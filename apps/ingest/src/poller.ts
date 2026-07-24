import { and, eq, inArray, sql } from "drizzle-orm";
import {
  assertTlshAvailable,
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

/** A program is retried across this many ticks before the cursor gives up and
 *  moves past it. Bounds the damage of a poison event (e.g. a hostile IDL that
 *  throws in the probe) — without a cap it would wedge the cursor forever. */
const MAX_STAGE_ATTEMPTS = 5;

/** Stages that end an event's pipeline. Mirrors the queue path: fingerprint
 *  failures and spam skips don't enqueue a next hop, so they're terminal here
 *  too (the old inline loop blindly ran identify/classify after them). */
const TERMINAL_STAGES = new Set([
  "scored",
  "classified_devnet",
  "skipped_spam_wave",
  "fingerprint_failed",
  "failed_permanent",
]);

/** One poll tick. Idempotent — re-seeing a program is a no-op. */
export async function pollDeploys(opts: PollOptions): Promise<PollResult> {
  const { network, bootstrapHours, max } = opts;
  await assertTlshAvailable(); // see live.ts — never ingest without lineage
  const currentSlot = await getSlot(network);

  // The cursor is the highest slot with nothing missing at or below it. It only
  // moves through contiguous success, so a failed program holds it in place and
  // gets retried next tick instead of being skipped forever. First run (no
  // cursor row): fall back to the events high-water mark, then to a short
  // bootstrap window rather than replaying all of chain history. Downtime is
  // recoverable — the cursor is trusted however old it is, so a gap is a
  // catch-up burst (bounded per tick by `max`), not a silent hole.
  let sinceSlot = await getCursorSlot(network);
  if (sinceSlot == null) {
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
    // Trust the recorded high-water mark whenever one exists — clamping it to
    // the bootstrap window silently skips everything deployed while the
    // process was down (that exact gap happened on 2026-07-24: the first tick
    // after the cursor table shipped clamped a 21h outage down to 1h). The
    // bootstrap window is only for a genuinely empty table.
    sinceSlot = lastSlot > 0 ? lastSlot : bootstrapSlot;
  }

  // headers slot-filtered during the stream, programIds mapped only for the
  // fresh cohort — devnet's full header/ref sets OOM the 256MB container.
  // No slice here: already-ingested headers above the cursor cost one conflict
  // check each, and the cursor needs to see the whole span to advance past them.
  const fresh = (await enumerateProgramData(network, { minSlot: sinceSlot + 1 }))
    .sort((a, b) => a.deployedSlot - b.deployedSlot); // oldest→newest so the cursor walks forward

  if (!fresh.length) {
    logger.info({ network, sinceSlot, currentSlot }, "poll: no new programs");
    return { fresh: 0, ingested: 0, sinceSlot, currentSlot };
  }

  const programAccounts = await enumerateProgramAccounts(network, {
    keep: new Set(fresh.map((h) => h.programDataAddress)),
  });
  const pdToProgram = new Map(programAccounts.map((p) => [p.programDataAddress, p.programId]));

  // known programId → this is an upgrade, not a fresh deploy
  const programIds = fresh
    .map((h) => pdToProgram.get(h.programDataAddress))
    .filter((id): id is string => id != null);
  const known = programIds.length
    ? new Set(
        (
          await db
            .select({ id: schema.subjects.id })
            .from(schema.subjects)
            .where(inArray(schema.subjects.id, programIds))
        ).map((r) => r.id),
      )
    : new Set<string>();

  let ingested = 0;
  let advanceTo = sinceSlot; // highest slot in the contiguous-success prefix
  let blocked = false; // a failure (or the cap) below pins the cursor there

  for (const h of fresh) {
    if (ingested >= max) {
      // per-tick work cap. Never advance into the capped header's slot — the
      // rest of that slot hasn't run, and a same-slot split would skip it.
      if (!blocked) advanceTo = Math.min(advanceTo, h.deployedSlot - 1);
      blocked = true;
      break;
    }
    const programId = pdToProgram.get(h.programDataAddress);
    if (!programId) {
      // ProgramData with no live Program account (closed before we mapped it).
      // Nothing to ingest, ever — don't let it hold the cursor.
      if (!blocked) advanceTo = h.deployedSlot;
      continue;
    }
    const type: ChainEventType = known.has(programId) ? "upgrade" : "deploy";
    const blockTime = new Date(
      Date.now() - (currentSlot - h.deployedSlot) * (1000 / SLOTS_PER_SECOND),
    );
    try {
      const rec = await recordEvent(network, type, programId, h, blockTime);
      if (TERMINAL_STAGES.has(rec.stage)) {
        // fully ingested on a prior tick — pure cursor bookkeeping
        if (!blocked) advanceTo = h.deployedSlot;
        continue;
      }
      await driveEvent(rec.eventId, rec.stage, network);
      ingested++;
      if (!blocked) advanceTo = h.deployedSlot;
      logger.info(
        { programId, type, slot: h.deployedSlot, resumed: !rec.isNew },
        "poll: ingested program",
      );
    } catch (err) {
      const attempts = await bumpAttempts(network, h);
      if (attempts >= MAX_STAGE_ATTEMPTS) {
        // poison event: stop retrying, put it on record as failed, move on
        await markFailedPermanent(network, h);
        if (!blocked) advanceTo = h.deployedSlot;
        logger.error(
          { programId, slot: h.deployedSlot, attempts, err: String(err) },
          "poll: program failed permanently, cursor moving past it",
        );
      } else {
        blocked = true; // cursor holds; retried next tick
        logger.warn(
          { programId, slot: h.deployedSlot, attempts, err: String(err) },
          "poll: program failed, will retry",
        );
      }
    }
  }

  if (advanceTo > sinceSlot) await advanceCursor(network, advanceTo);

  logger.info({ network, fresh: fresh.length, ingested, sinceSlot, advanceTo }, "poll: done");
  return { fresh: fresh.length, ingested, sinceSlot, currentSlot };
}

/** Drive an event through its remaining stages, mirroring the queue path: each
 *  stage advances pipelineStage; terminal stages stop the walk. Resuming from a
 *  half-finished prior tick starts at the stage actually reached, so completed
 *  stages (and their bucket bumps) never re-run. */
async function driveEvent(eventId: string, stage: string, network: Network): Promise<void> {
  for (let hops = 0; hops < 6; hops++) {
    if (TERMINAL_STAGES.has(stage)) return;
    if (stage === "ingested") await fingerprintStage(eventId);
    else if (stage === "fingerprinted") await identifyStage(eventId);
    else if (stage === "identified") await classifyStage(eventId);
    else if (stage === "classified") {
      // devnet stops at classify (SPEC §3): no interest score, and no funding
      // trail — faucet SOL tells you nothing and the RPC walk isn't free
      if (network === "devnet") return;
      await scoreStage(eventId);
    } else return; // unknown stage — leave it rather than loop
    const next = await db
      .select({ stage: schema.events.pipelineStage })
      .from(schema.events)
      .where(eq(schema.events.id, eventId));
    const reached = next[0]?.stage;
    if (!reached || reached === stage) return; // stage didn't advance — bail
    stage = reached;
  }
}

async function getCursorSlot(network: Network): Promise<number | null> {
  const rows = await db
    .select({ slot: schema.pollCursors.slot })
    .from(schema.pollCursors)
    .where(eq(schema.pollCursors.network, network));
  return rows[0] ? Number(rows[0].slot) : null;
}

async function advanceCursor(network: Network, slot: number): Promise<void> {
  await db
    .insert(schema.pollCursors)
    .values({ network, slot, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.pollCursors.network,
      // monotonic: a stale concurrent tick can never pull the cursor backwards
      set: { slot: sql`greatest(${schema.pollCursors.slot}, ${slot})`, updatedAt: new Date() },
    });
}

/** Count a failed attempt on the event's enrichment (if the event row exists
 *  yet) and return the total so far. */
async function bumpAttempts(
  network: Network,
  header: { programDataAddress: string; deployedSlot: number },
): Promise<number> {
  const signature = `poll:${header.programDataAddress}:${header.deployedSlot}`;
  const rows = await db
    .update(schema.events)
    .set({
      enrichment: sql`jsonb_set(
        coalesce(${schema.events.enrichment}, '{}'::jsonb),
        '{pollAttempts}',
        (coalesce((${schema.events.enrichment}->>'pollAttempts')::int, 0) + 1)::text::jsonb
      )`,
    })
    .where(and(eq(schema.events.network, network), eq(schema.events.signature, signature)))
    .returning({ enrichment: schema.events.enrichment });
  const n = rows[0]?.enrichment?.pollAttempts;
  return typeof n === "number" ? n : 1;
}

async function markFailedPermanent(
  network: Network,
  header: { programDataAddress: string; deployedSlot: number },
): Promise<void> {
  const signature = `poll:${header.programDataAddress}:${header.deployedSlot}`;
  await db
    .update(schema.events)
    .set({ pipelineStage: "failed_permanent" })
    .where(and(eq(schema.events.network, network), eq(schema.events.signature, signature)));
}

/** Insert a synthetic loader event for a polled program (idempotent on a
 *  synthetic signature keyed by ProgramData address + slot). On conflict,
 *  returns the existing row and the stage it reached, so a half-finished
 *  pipeline from a prior tick can be resumed instead of abandoned. */
async function recordEvent(
  network: Network,
  type: ChainEventType,
  programId: string,
  header: { programDataAddress: string; deployedSlot: number; upgradeAuthority: string | null },
  blockTime: Date,
): Promise<{ eventId: string; stage: string; isNew: boolean }> {
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
  if (inserted[0]) return { eventId: inserted[0].id, stage: "ingested", isNew: true };
  const existing = await db
    .select({ id: schema.events.id, stage: schema.events.pipelineStage })
    .from(schema.events)
    .where(and(eq(schema.events.signature, signature), eq(schema.events.instructionIndex, 0)));
  if (!existing[0]) throw new Error(`event conflict but no row for ${signature}`);
  return { eventId: existing[0].id, stage: existing[0].stage, isNew: false };
}

/** Start the poll loop. Runs the pipeline inline (no Redis) so the whole live
 *  path fits in one process. First tick fires shortly after boot. */
export function startPolling(opts: PollOptions & { intervalMs: number }): void {
  process.env.INLINE_PIPELINE = "1";
  let running = false; // a stalled tick must not stack a concurrent enumeration
  const run = async () => {
    if (running) {
      logger.warn({ network: opts.network }, "poll tick still running, skipping this interval");
      return;
    }
    running = true;
    try {
      await pollDeploys(opts);
    } catch (err) {
      logger.error({ err: String(err) }, "poll tick failed");
    } finally {
      running = false;
    }
  };
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
