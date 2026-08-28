import bs58 from "bs58";
import { and, eq, sql } from "drizzle-orm";
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

/** ComputeBudget program — where a transaction declares what it wants. */
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

/**
 * The compute a transaction ASKED FOR, from its SetComputeUnitLimit
 * instruction (tag 0x02, then a u32 little-endian).
 *
 * This is the number that matters under SGP-0003: the proposed resource fee is
 * charged per compute unit REQUESTED, not per unit burned, so a program that
 * asks for 1.4M and uses 50k would pay for 1.4M. Consumed is what the work
 * cost; requested is what it will cost to ask.
 *
 * Null when the transaction sets no limit — it then runs on the per-instruction
 * default, which is not a number the transaction chose.
 */
function requestedFrom(instructions: { programId?: string; data?: string }[] | undefined): number | null {
  for (const i of instructions ?? []) {
    if (i.programId !== COMPUTE_BUDGET || typeof i.data !== "string") continue;
    try {
      const b = Buffer.from(bs58.decode(i.data));
      if (b.length >= 5 && b[0] === 2) return b.readUInt32LE(1);
    } catch {
      // an undecodable ComputeBudget instruction is not worth failing over
    }
  }
  return null;
}

export interface ComputeSample {
  median: number;
  p10: number;
  p90: number;
  /** the heaviest call in the sample — on a bimodal program this is the story */
  max: number;
  /** share of calls under 2,000 CU, i.e. cranks rather than work */
  cheapShare: number;
  /** median compute REQUESTED via SetComputeUnitLimit — what SGP-0003 prices */
  requestedMedian: number | null;
  /** median consumed ÷ requested, 0–1. Low means paying for headroom it never
   *  uses, which is exactly what the proposed resource fee makes expensive. */
  utilisation: number | null;
  /** transactions in the sample that set no limit at all */
  noLimit: number;
  /** transactions inspected */
  n: number;
  /** how many of them failed — free, from the same call */
  failed: number;
  sampledAt: string;
}

// Twelve was far too few. Phoenix Eternal spans 556 to 884,264 CU, and twelve
// consecutive signatures reported medians of 112,477 / 22,912 / 8,743 / 894
// depending purely on where the window landed — a 126x swing on one program.
// A hundred is stable across the same windows.
const SAMPLE_N = Number(process.env.COMPUTE_SAMPLE_N ?? 100);
/** below this a call is doing bookkeeping, not work */
const CHEAP_CU = 2_000;
/** how stale a reading may get before it is taken again */
export const MAX_AGE_H = Number(process.env.COMPUTE_MAX_AGE_H ?? 24);
/** on-demand readings allowed per hour, process-wide */
const ON_DEMAND_PER_HOUR = Number(process.env.COMPUTE_ON_DEMAND_PER_HOUR ?? 8);

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

/** Is this reading old enough — or old enough in SHAPE — to retake?
 *
 *  Readings taken before the spread and the requested figure existed carry only
 *  a median and a band. They are not wrong, but every surface now draws `max`
 *  and `requestedMedian`, and a reading missing them renders as a hole rather
 *  than as an absence. Age them out on shape as well as on the clock: one tick
 *  replaces them, and nothing has to special-case a partial sample forever. */
export function isStale(c: ComputeSample | null | undefined): boolean {
  if (!c) return true;
  if (typeof c.max !== "number" || typeof c.noLimit !== "number") return true;
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
  const reqs: number[] = [];
  const ratios: number[] = [];
  let failed = 0;
  let noLimit = 0;
  for (const signature of signatures.slice(0, SAMPLE_N)) {
    try {
      const tx = await rpc<{
        meta?: { computeUnitsConsumed?: number; err?: unknown } | null;
        transaction?: { message?: { instructions?: { programId?: string; data?: string }[] } };
      }>(network, "getTransaction", [
        signature,
        { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" },
      ]);
      const cu = tx?.meta?.computeUnitsConsumed;
      if (typeof cu === "number") cus.push(cu);
      if (tx?.meta?.err) failed++;
      const req = requestedFrom(tx?.transaction?.message?.instructions);
      if (req === null) noLimit++;
      else {
        reqs.push(req);
        if (typeof cu === "number" && req > 0) ratios.push(Math.min(1, cu / req));
      }
    } catch {
      // one unreadable transaction must not cost the whole reading
    }
  }
  // ten is the floor for a spread that means anything
  if (cus.length < 10) return null;
  const sorted = [...cus].sort((a, b) => a - b);
  const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!;
  return {
    median: sorted[Math.floor(sorted.length / 2)]!,
    p10: q(0.1),
    p90: q(0.9),
    max: sorted[sorted.length - 1]!,
    cheapShare: cus.filter((c) => c < CHEAP_CU).length / cus.length,
    requestedMedian: reqs.length ? [...reqs].sort((a, b) => a - b)[Math.floor(reqs.length / 2)]! : null,
    utilisation: ratios.length
      ? Math.round([...ratios].sort((a, b) => a - b)[Math.floor(ratios.length / 2)]! * 100) / 100
      : null,
    noLimit,
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

/** Why a reading is not being returned. The distinction is the whole point: a
 *  program with almost no transactions is NOT one we have yet to get to, and a
 *  surface that says "measuring…" about the first is telling the reader to wait
 *  for something that will never arrive. */
export type ComputeMissReason =
  /** too little traffic to read — this is an answer about the program */
  | "too-quiet"
  /** the hourly ceiling is spent; a later visit gets a reading */
  | "budget"
  /** the read was attempted and failed */
  | "failed";

export interface ComputeReading {
  sample: ComputeSample | null;
  /** set whenever `sample` is null, never otherwise */
  reason: ComputeMissReason | null;
}

/**
 * Take a reading now, for a program nothing has sampled yet.
 *
 * Never throws, and always says WHY it has nothing: the caller renders "not
 * enough traffic to measure" or "not sampled yet" accordingly, and both cost
 * nothing.
 */
export async function sampleComputeOnDemand(
  network: Network,
  programId: string,
): Promise<ComputeReading> {
  const barredUntil = barren.get(programId);
  if (barredUntil && Date.now() < barredUntil) return { sample: null, reason: "too-quiet" };
  if (!budgetAllows()) {
    logger.warn({ programId, cap: ON_DEMAND_PER_HOUR }, "compute: on-demand budget spent this hour");
    return { sample: null, reason: "budget" };
  }
  spentThisHour++;
  try {
    const sigs = await getSignaturesForAddress(network, programId, { limit: SAMPLE_N });
    if (sigs.length < 10) {
      // a program with almost no history will not become readable soon
      barren.set(programId, Date.now() + 24 * 3_600_000);
      return { sample: null, reason: "too-quiet" };
    }
    const compute = await computeFromSignatures(network, sigs.map((s) => s.signature));
    if (!compute) {
      // signatures existed but under ten of them parsed — same answer to the
      // reader, shorter bar, because this one can change within the day
      barren.set(programId, Date.now() + 6 * 3_600_000);
      return { sample: null, reason: "too-quiet" };
    }
    await storeCompute(programId, compute);
    logger.info({ programId, median: compute.median, n: compute.n }, "compute: sampled on demand");
    return { sample: compute, reason: null };
  } catch (err) {
    logger.warn({ programId, err: String(err) }, "compute: on-demand sample failed");
    return { sample: null, reason: "failed" };
  }
}

// ---------------------------------------------------------------------------
// Where a reading sits among the others — the comparison, not the number.
//
// "Uses 20% of what it reserves" means nothing on its own. It means something
// against "the median program on record uses 61%". Corpus-relative, always:
// the same rule the syscall census and the size cohort already follow.
//
// Cached per network for a few minutes. This is a full-table aggregate over a
// corpus that grows by ~157 rows a day, so a stale-by-minutes answer is exact
// enough to rank one program, and it saves a scan per program in a batch.
// ---------------------------------------------------------------------------

export interface ComputeCensus {
  /** programs on this network carrying a utilisation reading */
  n: number;
  /** median utilisation across them, 0–1 — the number a rank is read against */
  median: number | null;
  /** every reading, ascending, so a rank is a scan of an array not a query */
  sorted: number[];
  computedAt: number;
}

const computeCensusCache = new Map<Network, ComputeCensus>();
const COMPUTE_CENSUS_TTL_MS = 5 * 60_000;

/** Below this the distribution is too thin to rank against, and a percentile
 *  would be a number dressed up as a finding. Only a corpus backfill lifts it. */
const MIN_CORPUS = 30;

export async function computeCensus(network: Network): Promise<ComputeCensus> {
  const hit = computeCensusCache.get(network);
  if (hit && Date.now() - hit.computedAt < COMPUTE_CENSUS_TTL_MS) return hit;

  const rows = await db.execute<{ u: string }>(sql`
    select ${schema.subjects.facts} -> 'compute' ->> 'utilisation' as u
    from ${schema.subjects}
    where ${schema.subjects.network} = ${network}
      and ${schema.subjects.kind} = 'program'
      and ${schema.subjects.facts} -> 'compute' ->> 'utilisation' is not null
  `);
  const sorted = rows
    .map((r) => Number(r.u))
    .filter((u) => Number.isFinite(u))
    .sort((a, b) => a - b);

  const census: ComputeCensus = {
    n: sorted.length,
    median: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null,
    sorted,
    computedAt: Date.now(),
  };
  computeCensusCache.set(network, census);
  return census;
}

export interface ComputeRank {
  /** programs the rank was taken against */
  n: number;
  /** the corpus median utilisation, 0–1 */
  median: number | null;
  /** share of them using a SMALLER fraction of their reservation, 0–1.
   *  Null when the corpus is too thin to rank against — which is not the same
   *  as "average", and must never be rendered as a percentile. */
  below: number | null;
}

/** Rank one utilisation reading against everything else on record. */
export async function rankUtilisation(
  network: Network,
  utilisation: number | null | undefined,
): Promise<ComputeRank | null> {
  if (typeof utilisation !== "number") return null;
  const census = await computeCensus(network);
  if (!census.n) return null;
  return {
    n: census.n,
    median: census.median,
    below:
      census.n >= MIN_CORPUS
        ? census.sorted.filter((u) => u < utilisation).length / census.n
        : null,
  };
}
