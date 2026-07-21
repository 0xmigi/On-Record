import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema, logger, getSignaturesForAddress, type Network } from "@onrecord/core";
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

export interface ActivityPoint {
  t: number; // hour bucket, epoch ms
  c: number; // transactions observed in that hour
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

interface ActivityFacts {
  activity?: ActivityPoint[];
  momentum?: MomentumState;
}

export async function sampleMomentum(network: Network = "mainnet"): Promise<void> {
  const maxPrograms = Number(process.env.MOMENTUM_MAX_PROGRAMS ?? 100);
  const windowStart = new Date(Date.now() - 7 * 86_400_000);

  // radar-window programs, least-recently-sampled first (never-sampled first)
  const subjects = await db
    .select({ id: schema.subjects.id, facts: schema.subjects.facts })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        gte(schema.subjects.firstSeenAt, windowStart),
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
          facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({ activity, momentum })}::jsonb`,
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
