import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema, logger, tlshDistance } from "@onrecord/core";
import { expireWatchlist, refreshTvl } from "@onrecord/enrich";
import { snapshotFunnel, todayKey } from "./funnel.js";
import { sampleMomentum } from "./momentum.js";
import { sweepClosed } from "./closed.js";
import { reclassifyRecent } from "./reclassify.js";

// ---------------------------------------------------------------------------
// Scheduled work (SPEC §10): TVL refresh (6h), a live funnel snapshot (15m),
// and a daily batch — watchlist expiry, corpus stats, threshold drift report,
// and finalizing yesterday's funnel. Plain timers; the process is long-lived
// and single-instance.
// ---------------------------------------------------------------------------

export function startCron(): void {
  every(6 * 3_600_000, "tvl-refresh", refreshTvl);
  every(15 * 60_000, "funnel-snapshot", async () => {
    await snapshotFunnel(todayKey());
  });
  every(3_600_000, "daily-batch", maybeRunDaily);
  // refresh band / bucket / nearest-relative as the corpus grows — a late
  // sibling deploy makes an earlier program's stored "nearest" go stale.
  every(6 * 3_600_000, "reclassify-refresh", () => reclassifyRecent("mainnet", 72));
  // per-program hourly activity buckets — the Momentum signal (VISION §5a)
  every(Number(process.env.MOMENTUM_INTERVAL_MS ?? 3_600_000), "momentum-sample", async () => {
    await sampleMomentum();
  });
  // detect programs closed since deploy (rent reclaimed) — the churn tail
  every(Number(process.env.CLOSED_SWEEP_INTERVAL_MS ?? 15 * 60_000), "closed-sweep", async () => {
    await sweepClosed("mainnet");
  });
}

function every(ms: number, name: string, fn: () => Promise<unknown>): void {
  const run = () =>
    fn().catch((err) => logger.error({ cron: name, err: String(err) }, "cron job failed"));
  setTimeout(run, 15_000); // first pass shortly after boot
  setInterval(run, ms);
}

let lastDailyDate = "";

/** Fires once per day at/after 9am America/New_York (SPEC §10 default). */
async function maybeRunDaily(): Promise<void> {
  const now = new Date();
  const et = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
  });
  const dateEt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
  const hourEt = Number(et.format(now));
  if (hourEt < 9 || lastDailyDate === dateEt) return;
  lastDailyDate = dateEt;

  // finalize yesterday's funnel snapshot
  const prev = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  await snapshotFunnel(prev);
  await expireWatchlist();
  await corpusStats();
  await thresholdDriftReport();
}

async function corpusStats(): Promise<void> {
  // aggregate in the database — the corpus is append-only and loading every
  // row to count it would eventually OOM the container
  const rows = await db
    .select({ network: schema.fingerprintCorpus.network, n: sql<number>`count(*)` })
    .from(schema.fingerprintCorpus)
    .groupBy(schema.fingerprintCorpus.network);
  const byNetwork = Object.fromEntries(rows.map((r) => [r.network, Number(r.n)]));
  const total = rows.reduce((a, r) => a + Number(r.n), 0);
  logger.info({ corpus: byNetwork, total }, "corpus stats");
}

/** Threshold drift report: the distribution of nearest-neighbor distances for
 *  yesterday's deploys tells the operator whether CLONE/NOVEL thresholds still
 *  cut the data where they should. Logged, not actioned. */
async function thresholdDriftReport(): Promise<void> {
  const since = new Date(Date.now() - 86_400_000);
  const recent = await db
    .select({ tlsh: schema.fingerprintCorpus.tlsh, sizeBytes: schema.fingerprintCorpus.sizeBytes })
    .from(schema.fingerprintCorpus)
    .where(and(eq(schema.fingerprintCorpus.network, "mainnet"), gte(schema.fingerprintCorpus.seenAt, since)));
  // compare against a bounded trailing window, not all of history — the corpus
  // is append-only and the O(recent x all) scan would grow without limit (the
  // drift signal only needs a representative recent population anyway)
  const comparisonSince = new Date(Date.now() - 90 * 86_400_000);
  const older = await db
    .select({ tlsh: schema.fingerprintCorpus.tlsh, sizeBytes: schema.fingerprintCorpus.sizeBytes })
    .from(schema.fingerprintCorpus)
    .where(
      and(
        eq(schema.fingerprintCorpus.network, "mainnet"),
        gte(schema.fingerprintCorpus.seenAt, comparisonSince),
      ),
    );

  const distances: number[] = [];
  for (const item of recent) {
    if (!item.tlsh) continue;
    let min = Infinity;
    for (const other of older) {
      if (!other.tlsh || other.tlsh === item.tlsh) continue;
      if (Math.abs(other.sizeBytes - item.sizeBytes) > item.sizeBytes * 0.2) continue;
      const d = tlshDistance(item.tlsh, other.tlsh);
      if (d !== null && d < min) min = d;
    }
    if (min !== Infinity) distances.push(min);
  }
  distances.sort((a, b) => a - b);
  const pct = (p: number) => distances[Math.floor((distances.length - 1) * p)] ?? null;
  logger.info(
    { n: distances.length, p10: pct(0.1), p50: pct(0.5), p90: pct(0.9) },
    "threshold drift report (nearest-neighbor distance distribution)",
  );
}
