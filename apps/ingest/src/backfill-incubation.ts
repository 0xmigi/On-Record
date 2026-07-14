import { eq } from "drizzle-orm";
import bs58 from "bs58";
import {
  db,
  schema,
  logger,
  newId,
  getAccountBytes,
  getDeployHistory,
  getSignaturesForAddress,
  parseProgramDataAccount,
  findProgramAddress,
  type Network,
} from "@onrecord/core";
import { fingerprintStage, identifyStage, classifyStage, scoreStage } from "./pipeline.js";

// ---------------------------------------------------------------------------
// One-off: program-ID devnet→mainnet lineage backfill.
//
// Serious teams reuse the same program keypair across clusters, so a mainnet
// program's deploy history often has a devnet twin at the SAME address. This
// links them directly (a stronger provenance signal than the fingerprint
// watchlist): for each mainnet program id, if a devnet program exists at the
// same address AND its first deploy predates mainnet's, write an `incubation`
// fact (matchedOn: "program_id"). Ingests the mainnet subject first if it isn't
// tracked yet, so the dossier renders.
//
//   railway ssh "node apps/ingest/dist/backfill-incubation.js <programId> [<programId> ...]"
//
// Idempotent: re-running refreshes the incubation fact; existing subjects are
// not re-ingested.
// ---------------------------------------------------------------------------

process.env.INLINE_PIPELINE = "1"; // stages run in sequence, no Redis

const LOADER = bs58.decode("BPFLoaderUpgradeab1e11111111111111111111111");
const programDataOf = (programId: string): string =>
  bs58.encode(findProgramAddress([bs58.decode(programId)], LOADER));

/** Every deploy/upgrade/set-authority signature on an address, oldest first.
 *  ProgramData is only touched by those txs, so this IS the deploy history. */
async function allDeploySigs(network: Network, address: string): Promise<{ blockTime: number | null }[]> {
  const out: { signature: string; blockTime: number | null }[] = [];
  let before: string | undefined;
  for (let page = 0; page < 20; page++) {
    const sigs = await getSignaturesForAddress(network, address, { limit: 1000, before });
    if (!sigs.length) break;
    out.push(...sigs);
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1]!.signature;
  }
  return out.reverse();
}

/** Ingest the mainnet subject through the normal pipeline if it isn't tracked. */
async function ensureSubject(programId: string, pd: string): Promise<void> {
  const existing = await db
    .select({ id: schema.subjects.id })
    .from(schema.subjects)
    .where(eq(schema.subjects.id, programId));
  if (existing[0]) {
    logger.info({ programId }, "incubation-backfill: subject already tracked");
    return;
  }

  const raw = await getAccountBytes("mainnet", pd);
  const parsed = raw ? parseProgramDataAccount(raw) : null;
  if (!parsed) throw new Error("no ProgramData account on mainnet — not an upgradeable program");
  const dh = await getDeployHistory("mainnet", pd);

  const eventId = newId("evt");
  const inserted = await db
    .insert(schema.events)
    .values({
      id: eventId,
      network: "mainnet",
      type: "deploy",
      signature: `incubation-backfill:${pd}`,
      instructionIndex: 0,
      slot: dh.firstDeploySlot ?? dh.lastDeploySlot ?? 0,
      blockTime: dh.firstDeployAt ?? new Date(),
      programId,
      programDataAddress: pd,
      authorityBefore: null,
      authorityAfter: parsed.upgradeAuthority ?? null,
    })
    .onConflictDoNothing({ target: [schema.events.signature, schema.events.instructionIndex] })
    .returning({ id: schema.events.id });
  const evId = inserted[0]?.id;
  if (!evId) {
    logger.info({ programId }, "incubation-backfill: deploy event already present");
    return;
  }

  await fingerprintStage(evId);
  await identifyStage(evId);
  await classifyStage(evId);
  await scoreStage(evId);
  logger.info({ programId }, "incubation-backfill: ingested mainnet subject");
}

/** Compute + persist the incubation fact if the program is genuinely devnet-first. */
async function writeIncubation(programId: string, pd: string): Promise<boolean> {
  const onDevnet = await getAccountBytes("devnet", programId);
  if (!onDevnet) {
    logger.warn({ programId }, "no devnet program at the same address — no lineage");
    return false;
  }
  const [devSigs, main] = await Promise.all([
    allDeploySigs("devnet", pd),
    getDeployHistory("mainnet", pd),
  ]);
  const devTimes = devSigs.map((s) => s.blockTime).filter((t): t is number => t != null);
  if (!devTimes.length || !main.firstDeployAt) {
    logger.warn({ programId }, "incomplete deploy history on one cluster");
    return false;
  }
  const firstDevnetMs = devTimes[0]! * 1000;
  const mainFirstMs = main.firstDeployAt.getTime();
  if (firstDevnetMs >= mainFirstMs) {
    logger.warn(
      { programId, devnet: new Date(firstDevnetMs), mainnet: main.firstDeployAt },
      "not devnet-first — skipping (mainnet came first or same time)",
    );
    return false;
  }

  // pre-launch effort vs lifetime activity are different signals — capture both
  const beforeLaunch = devTimes.filter((t) => t * 1000 < mainFirstMs).length;
  const lastDevnetMs = devTimes[devTimes.length - 1]! * 1000;
  const incubationDays = Math.round(((mainFirstMs - firstDevnetMs) / 86_400_000) * 10) / 10;
  const incubation = {
    devnetProgramId: programId, // same address on both clusters
    firstDevnetAt: new Date(firstDevnetMs).toISOString(),
    incubationDays,
    devnetIterations: beforeLaunch, // deploys strictly before the mainnet debut
    devnetDeploysTotal: devTimes.length,
    lastDevnetAt: new Date(lastDevnetMs).toISOString(),
    matchedOn: "program_id" as const,
  };

  const rows = await db
    .select({ facts: schema.subjects.facts })
    .from(schema.subjects)
    .where(eq(schema.subjects.id, programId));
  const facts = (rows[0]?.facts ?? {}) as Record<string, unknown>;
  await db
    .update(schema.subjects)
    .set({ facts: { ...facts, incubation }, updatedAt: new Date() })
    .where(eq(schema.subjects.id, programId));
  logger.info({ programId, incubation }, "incubation-backfill: wrote incubation fact");
  return true;
}

async function run(): Promise<void> {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!ids.length) throw new Error("usage: backfill-incubation.js <programId> [<programId> ...]");
  let linked = 0;
  for (const programId of ids) {
    const pd = programDataOf(programId);
    logger.info({ programId, programData: pd }, "incubation-backfill: start");
    try {
      await ensureSubject(programId, pd);
      if (await writeIncubation(programId, pd)) linked++;
    } catch (err) {
      logger.error({ programId, err: String(err) }, "incubation-backfill: failed");
    }
  }
  logger.info({ of: ids.length, linked }, "incubation-backfill: complete");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "incubation-backfill: fatal");
    process.exit(1);
  });
