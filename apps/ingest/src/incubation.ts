import { and, asc, eq, sql } from "drizzle-orm";
import bs58 from "bs58";
import {
  db,
  schema,
  stageLogger,
  findProgramAddress,
  getAccountBytes,
  getSignaturesForAddress,
  LOADER_PROGRAM_ID,
  type ApiIncubation,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// devnet→mainnet incubation, matched on the program id itself.
//
// Serious teams reuse the same program keypair across clusters, so a mainnet
// program's devnet twin usually sits at the SAME address. That is the strongest
// form of this link and the cheapest to check — no fingerprint threshold, no
// authority heuristic, just "does this address also exist on devnet, and was it
// there first".
//
// It used to be reachable only by running backfill-incubation.ts by hand, so in
// practice nothing had it. The pipeline's own incubation path went exclusively
// through the devnet fingerprint watchlist, which requires the devnet deploy to
// have been classified `novel` AND its bytecode to still resemble what finally
// shipped. Ripstr is what that misses: 8 devnet deploys at
// EQ6wkaMZ… over three days, then the same address on mainnet — and no
// incubation fact, because the devnet build landed as a `variant` and was never
// watchlisted. So the check runs inline now, on every mainnet event, and the
// watchlist path stays as the fallback for teams that DO rotate keypairs.
//
// The record is preferred over the chain: if our poller already saw the devnet
// deploys we have their block times for free, including the ones that came after
// the mainnet debut (post-launch staging, a separate signal). The chain probe is
// the fallback for programs whose devnet life predates our coverage.
// ---------------------------------------------------------------------------

const log = stageLogger("incubation");

/** How many pages of signature history the chain probe will walk. Matches
 *  getDeployHistory: ProgramData is only touched by deploy/upgrade/set-authority
 *  txns, so a handful of pages covers any real program's whole deploy life. */
const PROBE_PAGES = 5;

function programDataAddress(programId: string): string {
  return bs58.encode(
    findProgramAddress([bs58.decode(programId)], bs58.decode(LOADER_PROGRAM_ID)),
  );
}

/** Devnet deploy times (epoch ms, oldest first) already in our own record.
 *
 *  Deduped by slot, not by row: a program first seen mid-life has both a poller
 *  sighting and a genesis row seeded from the same deploy tx (see
 *  recordGenesisDeploy), and counting each would inflate the iteration count. */
async function devnetTimesFromRecord(programId: string): Promise<number[]> {
  const rows = await db
    .select({ slot: schema.events.slot, blockTime: schema.events.blockTime })
    .from(schema.events)
    .where(and(eq(schema.events.programId, programId), eq(schema.events.network, "devnet")))
    .orderBy(asc(schema.events.slot));

  const bySlot = new Map<number, number>();
  for (const r of rows) {
    if (!r.blockTime) continue;
    const ms = r.blockTime.getTime();
    const seen = bySlot.get(r.slot);
    if (seen === undefined || ms < seen) bySlot.set(r.slot, ms);
  }
  return [...bySlot.values()].sort((a, b) => a - b);
}

/** Devnet deploy times read straight off the chain. Returns null when there is
 *  no devnet program at this address at all — which is the common answer, and
 *  costs one account read to establish. */
async function devnetTimesFromChain(programId: string): Promise<number[] | null> {
  if (!(await getAccountBytes("devnet", programId))) return null;

  const pd = programDataAddress(programId);
  const times: number[] = [];
  let before: string | undefined;
  for (let page = 0; page < PROBE_PAGES; page++) {
    const sigs = await getSignaturesForAddress("devnet", pd, { limit: 1000, before });
    if (!sigs.length) break;
    for (const s of sigs) if (s.blockTime) times.push(s.blockTime * 1000);
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1]!.signature;
  }
  return times.sort((a, b) => a - b);
}

/** Build the fact, or null if these devnet times don't actually precede the
 *  mainnet debut. A program that only reached devnet AFTER launching (staging a
 *  next version there) is not an incubation — the ordering is the whole claim.
 *  Exported for the arithmetic: given times, this is the whole rule. */
export function computeIncubation(
  programId: string,
  devnetTimes: number[],
  mainnetFirstMs: number,
): ApiIncubation | null {
  const first = devnetTimes[0];
  const last = devnetTimes[devnetTimes.length - 1];
  if (first === undefined || last === undefined || first >= mainnetFirstMs) return null;

  return {
    devnetProgramId: programId, // the same address on both clusters
    firstDevnetAt: new Date(first).toISOString(),
    incubationDays: Math.round(((mainnetFirstMs - first) / 86_400_000) * 10) / 10,
    // pre-launch effort and lifetime devnet activity are different signals
    devnetIterations: devnetTimes.filter((t) => t < mainnetFirstMs).length,
    devnetDeploysTotal: devnetTimes.length,
    lastDevnetAt: new Date(last).toISOString(),
    matchedOn: "program_id",
  };
}

/** Link a mainnet program to its devnet twin at the same address and persist the
 *  fact. Returns what was written, or null when there is no devnet-first twin.
 *
 *  `probeChain` spends up to PROBE_PAGES+1 RPC calls to look for devnet history
 *  we never polled. Worth it on a genuine mainnet debut, wasteful on every
 *  upgrade of a program we already know has no devnet side. */
export async function linkIncubation(
  programId: string,
  mainnetFirstDeployAt: Date | null,
  opts: { probeChain?: boolean } = {},
): Promise<ApiIncubation | null> {
  // "unknown" is the placeholder a set_authority/close event carries when the
  // program id could not be resolved — matching devnet events against it would
  // pool every unresolved row into one bogus lineage
  if (!programId || programId === "unknown" || !mainnetFirstDeployAt) return null;
  const mainnetFirstMs = mainnetFirstDeployAt.getTime();

  let times = await devnetTimesFromRecord(programId);
  if (!times.length && opts.probeChain) times = (await devnetTimesFromChain(programId)) ?? [];
  if (!times.length) return null;

  const incubation = computeIncubation(programId, times, mainnetFirstMs);
  if (!incubation) return null;

  // network-scoped: a devnet subject row sharing this program id must never
  // pick up the fact (see upsertSubject's cross-cluster guard)
  await db
    .update(schema.subjects)
    .set({
      facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({ incubation })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.subjects.id, programId), eq(schema.subjects.network, "mainnet")));

  log.info(
    {
      programId,
      incubationDays: incubation.incubationDays,
      devnetIterations: incubation.devnetIterations,
    },
    "devnet→mainnet incubation linked (program_id)",
  );
  return incubation;
}
