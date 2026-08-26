import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db, schema, logger, getSignaturesForAddress, rpc, type Network } from "@onrecord/core";
import { refreshInterest } from "./interest.js";

// ---------------------------------------------------------------------------
// Momentum sampler (methodology v0's "Momentum" signal, VISION §5a): per-hour
// transaction counts for every program in the radar window, appended to
// subjects.facts.activity by a cron tick. Counts come from signature history
// with an `until` cursor, so each tick reads only what's new. Everything is
// decoded on-chain fact — no inference.
//
//   facts.activity  = [{ t: hour-bucket epoch ms, c: tx count }] (≤168 = 7d)
//   facts.momentum  = { txns24h, prev24h, growth, sampledAt, cursor }
//
// Cost model: ≤MOMENTUM_MAX_PROGRAMS programs/tick × usually 1 RPC call
// (3-page cap ⇒ busy-bot counts are a floor, not a lie — the shape survives).
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const SERIES_CAP = 168; // 7 days of hourly buckets
/** transactions inspected for a compute reading */
const COMPUTE_SAMPLE_N = Number(process.env.COMPUTE_SAMPLE_N ?? 12);
/** how stale a compute reading may get before it is taken again */
const COMPUTE_MAX_AGE_H = Number(process.env.COMPUTE_MAX_AGE_H ?? 24);

export interface ActivityPoint {
  t: number; // hour bucket, epoch ms
  c: number; // transactions observed in that hour
}

/**
 * A rate reading, taken once per tick.
 *
 * `c` above is a COUNT, and a count saturates: the sampler reads at most three
 * pages, so every program busier than ~3,000 tx/tick records exactly 3,000 and
 * the whole 7-day series flatlines at the ceiling. Jupiter, Raydium and Meteora
 * all render as the same solid block, which is the sampler's shape, not the
 * chain's.
 *
 * A rate does not saturate. The signatures already fetched cover some span of
 * time; dividing gives transactions per minute at that moment, and a busy
 * program simply reads high. Costs nothing — it is measured from the page the
 * tick already paid for.
 */
export interface RatePoint {
  t: number; // hour bucket, epoch ms
  r: number; // transactions per minute, observed
}

interface MomentumState {
  txns24h: number;
  /** the sampler's per-run page cap was hit — txns24h is a FLOOR. Busy programs
   *  otherwise all saturate at the same number (3 pages x 1000 x runs/day) and
   *  that ceiling gets read as real traffic. */
  txns24hTruncated?: boolean;
  prev24h: number;
  growth: number | null; // txns24h / prev24h, null until there is a prior day
  sampledAt: string;
  cursor: string | null; // newest signature already counted
}

/** Compute burned by the transactions that touch a program.
 *
 *  This is the WHOLE transaction's compute, not this program's share — a swap
 *  pays for every token program it routes through — so it is only ever labelled
 *  "per transaction". Sampled from a handful of signatures the tick already
 *  fetched, at one getTransaction each, so the cost is bounded and small. */
export interface ComputeSample {
  median: number;
  p10: number;
  p90: number;
  n: number;
  failed: number;
  sampledAt: string;
}

interface ActivityFacts {
  activity?: ActivityPoint[];
  compute?: ComputeSample;
  /** rate readings, one per tick — the series that survives a busy program */
  rate?: RatePoint[];
  momentum?: MomentumState;
}

export async function sampleMomentum(network: Network = "mainnet"): Promise<void> {
  const maxPrograms = Number(process.env.MOMENTUM_MAX_PROGRAMS ?? 100);
  const windowStart = new Date(Date.now() - 7 * 86_400_000);

  // Two populations, least-recently-sampled first (never-sampled first):
  //
  //   1. the radar window — anything deployed in the last 7 days, which is what
  //      the feed ranks and therefore what needs a fresh number;
  //   2. anything that appears on a reference map, however old.
  //
  // The second exists because the map compares neighbours against each other,
  // and an unsampled neighbour is a dash. Half of scope's neighbourhood read as
  // "—" while the programs themselves were among the busiest on the chain: the
  // sampler had simply never had a reason to look at a 2022 deploy. On a panel
  // whose whole job is "who here is big", a blank beside a name is the one
  // answer that teaches nothing.
  //
  // Cost is unchanged — maxPrograms still caps the run, the extra rows just
  // become eligible for the slots. They are naturally self-limiting: a program
  // only qualifies once some binary on record names it.
  const mapped = db
    .select({ id: schema.programReferences.toProgramId })
    .from(schema.programReferences)
    .where(eq(schema.programReferences.network, network))
    .union(
      db
        .select({ id: schema.programReferences.fromProgramId })
        .from(schema.programReferences)
        .where(eq(schema.programReferences.network, network)),
    );

  const subjects = await db
    .select({ id: schema.subjects.id, facts: schema.subjects.facts })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        or(gte(schema.subjects.firstSeenAt, windowStart), inArray(schema.subjects.id, mapped)),
      ),
    )
    .orderBy(sql`${schema.subjects.facts}->'momentum'->>'sampledAt' asc nulls first`)
    .limit(maxPrograms);

  let sampled = 0;
  let calls = 0;
  for (const s of subjects) {
    try {
      const facts = (s.facts ?? {}) as ActivityFacts;
      const cursor = facts.momentum?.cursor ?? undefined;

      // new signatures since the cursor (newest first), 3-page cap
      const PAGES = 3;
      const fresh: { signature: string; blockTime: number | null }[] = [];
      let before: string | undefined;
      let truncated = false;
      for (let page = 0; page < PAGES; page++) {
        const batch = await getSignaturesForAddress(network, s.id, {
          limit: 1000,
          before,
          until: cursor,
        });
        calls++;
        fresh.push(...batch);
        if (batch.length < 1000) break;
        before = batch[batch.length - 1]!.signature;
        // a full final page means this program out-ran the sampler this run
        if (page === PAGES - 1) truncated = true;
      }

      // merge per-hour counts into the stored series
      const buckets = new Map<number, number>(
        (facts.activity ?? []).map((p) => [p.t, p.c] as [number, number]),
      );
      for (const sig of fresh) {
        if (!sig.blockTime) continue;
        const t = Math.floor((sig.blockTime * 1000) / HOUR_MS) * HOUR_MS;
        buckets.set(t, (buckets.get(t) ?? 0) + 1);
      }
      const activity = [...buckets.entries()]
        .map(([t, c]) => ({ t, c }))
        .sort((a, b) => a.t - b.t)
        .slice(-SERIES_CAP);

      // The rate reading, from the page this tick already fetched. Span is
      // measured across the fetched signatures themselves, so a program that
      // filled the cap in ninety seconds reads as its real per-minute rate
      // instead of as the cap.
      const stamps = fresh.map((s) => s.blockTime).filter((t): t is number => typeof t === "number");
      const rateSeries = [...(facts.rate ?? [])];
      if (stamps.length >= 2) {
        const spanMin = (Math.max(...stamps) - Math.min(...stamps)) / 60;
        // a page whose signatures share one second says nothing usable
        if (spanMin >= 0.5) {
          const bucket = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
          const r = Math.round((stamps.length / spanMin) * 10) / 10;
          const at = rateSeries.findIndex((p) => p.t === bucket);
          if (at >= 0) rateSeries[at] = { t: bucket, r };
          else rateSeries.push({ t: bucket, r });
        }
      }
      while (rateSeries.length > SERIES_CAP) rateSeries.shift();

      // Compute, re-measured on a slow cycle. COMPUTE_SAMPLE_N transactions is
      // enough for a median and a spread, and re-reading it hourly would spend
      // for a number that barely moves — so a fresh reading only every
      // COMPUTE_MAX_AGE_H hours, and only for programs that have traffic.
      let compute = facts.compute;
      const computeAgeH = compute ? (Date.now() - Date.parse(compute.sampledAt)) / 3_600_000 : Infinity;
      if (fresh.length && computeAgeH > COMPUTE_MAX_AGE_H) {
        const picked = fresh.slice(0, COMPUTE_SAMPLE_N);
        const cus: number[] = [];
        let failed = 0;
        for (const sig of picked) {
          try {
            const tx = await rpc<{ meta?: { computeUnitsConsumed?: number; err?: unknown } | null }>(
              network,
              "getTransaction",
              [sig.signature, { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" }],
            );
            calls++;
            const cu = tx?.meta?.computeUnitsConsumed;
            if (typeof cu === "number") cus.push(cu);
            if (tx?.meta?.err) failed++;
          } catch {
            // one unreadable transaction must not cost the whole reading
          }
        }
        if (cus.length >= 3) {
          const sorted = [...cus].sort((a, b) => a - b);
          const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!;
          compute = {
            median: sorted[Math.floor(sorted.length / 2)]!,
            p10: q(0.1),
            p90: q(0.9),
            n: cus.length,
            failed,
            sampledAt: new Date().toISOString(),
          };
        }
      }

      const now = Date.now();
      const sum = (from: number, to: number) =>
        activity.reduce((acc, p) => (p.t >= from && p.t < to ? acc + p.c : acc), 0);
      const txns24h = sum(now - 86_400_000, now + HOUR_MS);
      const prev24h = sum(now - 2 * 86_400_000, now - 86_400_000);
      const momentum: MomentumState = {
        txns24hTruncated: truncated || undefined,
        txns24h,
        prev24h,
        growth: prev24h > 0 ? Math.round((txns24h / prev24h) * 10) / 10 : null,
        sampledAt: new Date().toISOString(),
        cursor: fresh[0]?.signature ?? cursor ?? null,
      };

      await db
        .update(schema.subjects)
        .set({
          facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({ activity, rate: rateSeries, momentum, ...(compute ? { compute } : {}) })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(schema.subjects.id, s.id));
      await refreshInterest(s.id); // activity moved — re-rank
      sampled++;
    } catch (err) {
      logger.warn({ id: s.id, err: String(err) }, "momentum: sample failed");
    }
  }
  logger.info({ sampled, of: subjects.length, rpcCalls: calls, network }, "momentum: tick done");
}
