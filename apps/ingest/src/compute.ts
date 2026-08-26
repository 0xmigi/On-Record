import { and, eq } from "drizzle-orm";
import { db, schema, logger, rpc, getSignaturesForAddress, type Network } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Compute per transaction — one implementation, two callers.
//
// The momentum tick takes a reading on its slow cycle; a card asks for one when
// it is about to draw a program the tick has not reached yet. Both go through
// here, so the number on the card is the number in the dossier is the number in
// the API. A second sampler would be a second answer.
//
// WHAT IT MEASURES. computeUnitsConsumed is a TRANSACTION-level number: a swap
// pays for Jupiter plus every token program it routes through. So this is only
// ever "compute per transaction that touches this program", never "what this
// program uses". There is no cheaper per-program attribution available — the
// enhanced-transactions API does not return compute at all.
//
// WHAT IT COSTS. One getTransaction per sampled signature, SAMPLE_N of them,
// once per program per MAX_AGE_H. On-demand readings are additionally capped
// per hour across the whole process, because /card.png is public and a miss
// would otherwise be a way for a stranger to spend our credits by iterating
// program ids.
// ---------------------------------------------------------------------------

export interface ComputeSample {
  median: number;
  p10: number;
  p90: number;
  /** transactions inspected */
  n: number;
  /** how many of them failed — free, from the same call */
  failed: number;
  sampledAt: string;
}

const SAMPLE_N = Number(process.env.COMPUTE_SAMPLE_N ?? 12);
/** how stale a reading may get before it is taken again */
export const MAX_AGE_H = Number(process.env.COMPUTE_MAX_AGE_H ?? 24);
/** on-demand readings allowed per hour, process-wide */
const ON_DEMAND_PER_HOUR = Number(process.env.COMPUTE_ON_DEMAND_PER_HOUR ?? 40);

let windowStart = Date.now();
let spentThisHour = 0;
/** programs already attempted and found to have too little traffic to read —
 *  without this, every card view of a dead program pays the full sample again */
const barren = new Map<string, number>();

function budgetAllows(): boolean {
  if (Date.now() - windowStart > 3_600_000) {
    windowStart = Date.now();
    spentThisHour = 0;
  }
  return spentThisHour < ON_DEMAND_PER_HOUR;
}

/** Is this reading old enough to retake? */
export function isStale(c: ComputeSample | null | undefined): boolean {
  if (!c) return true;
  return (Date.now() - Date.parse(c.sampledAt)) / 3_600_000 > MAX_AGE_H;
}

/**
 * Read compute for one program from a list of signatures.
 *
 * Exported so the momentum tick can hand over the page it already fetched
 * rather than paying for signatures twice.
 */
export async function computeFromSignatures(
  network: Network,
  signatures: string[],
): Promise<ComputeSample | null> {
  const cus: number[] = [];
  let failed = 0;
  for (const signature of signatures.slice(0, SAMPLE_N)) {
    try {
      const tx = await rpc<{ meta?: { computeUnitsConsumed?: number; err?: unknown } | null }>(
        network,
        "getTransaction",
        [signature, { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" }],
      );
      const cu = tx?.meta?.computeUnitsConsumed;
      if (typeof cu === "number") cus.push(cu);
      if (tx?.meta?.err) failed++;
    } catch {
      // one unreadable transaction must not cost the whole reading
    }
  }
  // three is the floor for a median and a spread that mean anything
  if (cus.length < 3) return null;
  const sorted = [...cus].sort((a, b) => a - b);
  const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!;
  return {
    median: sorted[Math.floor(sorted.length / 2)]!,
    p10: q(0.1),
    p90: q(0.9),
    n: cus.length,
    failed,
    sampledAt: new Date().toISOString(),
  };
}

/** Write a reading through to the program's facts. */
export async function storeCompute(programId: string, compute: ComputeSample): Promise<void> {
  const [row] = await db
    .select({ facts: schema.subjects.facts })
    .from(schema.subjects)
    .where(and(eq(schema.subjects.id, programId), eq(schema.subjects.kind, "program")));
  if (!row) return;
  await db
    .update(schema.subjects)
    .set({ facts: { ...((row.facts as object) ?? {}), compute }, updatedAt: new Date() })
    .where(eq(schema.subjects.id, programId));
}

/**
 * Take a reading now, for a program nothing has sampled yet.
 *
 * Returns null when the budget is spent, the program is known to be too quiet
 * to read, or the chain says nothing useful — the caller then draws "not
 * sampled yet", which is the honest answer and costs nothing.
 */
export async function sampleComputeOnDemand(
  network: Network,
  programId: string,
): Promise<ComputeSample | null> {
  const barredUntil = barren.get(programId);
  if (barredUntil && Date.now() < barredUntil) return null;
  if (!budgetAllows()) {
    logger.warn({ programId, cap: ON_DEMAND_PER_HOUR }, "compute: on-demand budget spent this hour");
    return null;
  }
  spentThisHour++;
  try {
    const sigs = await getSignaturesForAddress(network, programId, { limit: SAMPLE_N });
    if (sigs.length < 3) {
      // a program with almost no history will not become readable soon
      barren.set(programId, Date.now() + 24 * 3_600_000);
      return null;
    }
    const compute = await computeFromSignatures(network, sigs.map((s) => s.signature));
    if (!compute) {
      barren.set(programId, Date.now() + 6 * 3_600_000);
      return null;
    }
    await storeCompute(programId, compute);
    logger.info({ programId, median: compute.median, n: compute.n }, "compute: sampled on demand");
    return compute;
  } catch (err) {
    logger.warn({ programId, err: String(err) }, "compute: on-demand sample failed");
    return null;
  }
}
