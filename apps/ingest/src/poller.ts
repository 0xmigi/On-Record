import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  schema,
  newId,
  logger,
  getSlot,
  enumerateProgramAccounts,
  enumerateProgramData,
  type ChainEventType,
  type Network,
} from "@onrecord/core";
import { fingerprintStage, identifyStage, classifyStage, scoreStage } from "./pipeline.js";

// ---------------------------------------------------------------------------
// Live poller (the near-real-time ingestion path). The loader's signature
// history is not queryable and a webhook on the loader would drown us in
// buffer-Write staging noise — so instead we poll chain state on an interval:
// enumerate ProgramData headers (deploy slot + authority, ~45 bytes each),
// diff against the newest slot we've already recorded, and drive each new
// program through the pipeline inline. One header-only getProgramAccounts call
// per tick catches every deploy/upgrade with near-zero waste.
//
// Deploy vs upgrade: ProgramData only stores the LAST deploy slot, so a freshly
// bumped program looks identical to a new one from chain state. We split on
// whether the programId is already a known subject (upgrade) or not (deploy) —
// the same heuristic the rest of the pipeline uses.
// ---------------------------------------------------------------------------

const SLOTS_PER_SECOND = 2.5; // ~400ms/slot; block time is approximate from slot delta

export interface PollOptions {
  network: Network;
  /** how far back to reach on the first tick against an empty table */
  bootstrapHours: number;
  /** safety cap on programs ingested per tick */
  max: number;
}

export interface PollResult {
  fresh: number;
  ingested: number;
  sinceSlot: number;
  currentSlot: number;
}

/** One poll tick. Idempotent — re-seeing a program is a no-op. */
export async function pollDeploys(opts: PollOptions): Promise<PollResult> {
  const { network, bootstrapHours, max } = opts;
  const currentSlot = await getSlot(network);

  // high-water mark: the newest deploy/upgrade slot already recorded. On an
  // empty table this is 0, so fall back to a short bootstrap window rather than
  // replaying all of chain history.
  const hw = await db
    .select({ maxSlot: sql<number>`max(${schema.events.slot})` })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.network, network),
        inArray(schema.events.type, ["deploy", "upgrade"]),
      ),
    );
  const lastSlot = Number(hw[0]?.maxSlot ?? 0);
  const bootstrapSlot = currentSlot - Math.floor(bootstrapHours * 3600 * SLOTS_PER_SECOND);
  const sinceSlot = Math.max(lastSlot, bootstrapSlot);

  const [programAccounts, dataHeaders] = await Promise.all([
    enumerateProgramAccounts(network),
    enumerateProgramData(network),
  ]);
  const pdToProgram = new Map(programAccounts.map((p) => [p.programDataAddress, p.programId]));

  const fresh = dataHeaders
    .filter((h) => h.deployedSlot > sinceSlot && pdToProgram.has(h.programDataAddress))
    .sort((a, b) => a.deployedSlot - b.deployedSlot) // oldest→newest so rows insert in order
    .slice(0, max);

  if (!fresh.length) {
    logger.info({ network, sinceSlot, currentSlot }, "poll: no new programs");
    return { fresh: 0, ingested: 0, sinceSlot, currentSlot };
  }

  // known programId → this is an upgrade, not a fresh deploy
  const programIds = fresh.map((h) => pdToProgram.get(h.programDataAddress)!);
  const known = new Set(
    (
      await db
        .select({ id: schema.subjects.id })
        .from(schema.subjects)
        .where(inArray(schema.subjects.id, programIds))
    ).map((r) => r.id),
  );

  let ingested = 0;
  for (const h of fresh) {
    const programId = pdToProgram.get(h.programDataAddress)!;
    const type: ChainEventType = known.has(programId) ? "upgrade" : "deploy";
    const blockTime = new Date(
      Date.now() - (currentSlot - h.deployedSlot) * (1000 / SLOTS_PER_SECOND),
    );
    try {
      const eventId = await recordEvent(network, type, programId, h, blockTime);
      if (!eventId) continue; // already ingested this (programData, slot)
      await fingerprintStage(eventId);
      await identifyStage(eventId);
      await classifyStage(eventId);
      await scoreStage(eventId);
      ingested++;
      logger.info({ programId, type, slot: h.deployedSlot }, "poll: ingested program");
    } catch (err) {
      logger.warn({ programId, err: String(err) }, "poll: program failed, skipping");
    }
  }

  logger.info({ network, fresh: fresh.length, ingested, sinceSlot }, "poll: done");
  return { fresh: fresh.length, ingested, sinceSlot, currentSlot };
}

/** Insert a synthetic loader event for a polled program (idempotent on a
 *  synthetic signature keyed by ProgramData address + slot). */
async function recordEvent(
  network: Network,
  type: ChainEventType,
  programId: string,
  header: { programDataAddress: string; deployedSlot: number; upgradeAuthority: string | null },
  blockTime: Date,
): Promise<string | null> {
  const signature = `poll:${header.programDataAddress}:${header.deployedSlot}`;
  const inserted = await db
    .insert(schema.events)
    .values({
      id: newId("evt"),
      network,
      type,
      signature,
      instructionIndex: 0,
      slot: header.deployedSlot,
      blockTime,
      programId,
      programDataAddress: header.programDataAddress,
      authorityBefore: null,
      authorityAfter: header.upgradeAuthority,
    })
    .onConflictDoNothing({ target: [schema.events.signature, schema.events.instructionIndex] })
    .returning({ id: schema.events.id });
  return inserted[0]?.id ?? null;
}

/** Start the poll loop. Runs the pipeline inline (no Redis) so the whole live
 *  path fits in one process. First tick fires shortly after boot. */
export function startPolling(opts: PollOptions & { intervalMs: number }): void {
  process.env.INLINE_PIPELINE = "1";
  const run = () =>
    pollDeploys(opts).catch((err) => logger.error({ err: String(err) }, "poll tick failed"));
  setTimeout(run, 5_000);
  setInterval(run, opts.intervalMs);
  logger.info(
    { network: opts.network, intervalMs: opts.intervalMs },
    "onrecord live poller started",
  );
}

// Allow a one-shot manual poll: `INLINE_PIPELINE=1 tsx src/poller.ts [--network=mainnet]`
const isMain = process.argv[1]?.endsWith("poller.ts") || process.argv[1]?.endsWith("poller.js");
if (isMain) {
  const argv = process.argv.slice(2);
  const get = (k: string, d: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
  const network = get("network", "mainnet") === "devnet" ? "devnet" : "mainnet";
  process.env.INLINE_PIPELINE = "1";
  pollDeploys({
    network,
    bootstrapHours: Number(get("bootstrap-hours", "1")),
    max: Number(get("max", "200")),
  })
    .then((r) => {
      logger.info(r, "poll complete");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: String(err) }, "poll failed");
      process.exit(1);
    });
}
