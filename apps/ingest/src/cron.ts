import { and, eq, gte } from "drizzle-orm";
import { db, schema, logger, tlshDistance } from "@onrecord/core";
import { expireWatchlist, refreshTvl } from "@onrecord/enrich";
import { generateDigest } from "@onrecord/newsroom";
import { copyWaveSweep } from "./pipeline.js";

// ---------------------------------------------------------------------------
// Scheduled work (spec §8): TVL refresh (6h), copy-wave sweep (30m), and the
// daily 9am-ET batch — digest, watchlist expiry, corpus stats, threshold
// drift report. Plain timers; the process is long-lived and single-instance.
// ---------------------------------------------------------------------------

export function startCron(): void {
  every(6 * 3_600_000, "tvl-refresh", refreshTvl);
  every(30 * 60_000, "copy-wave-sweep", async () => {
    const n = await copyWaveSweep();
    if (n) logger.info({ enqueued: n }, "copy-wave stories enqueued");
  });
  every(3_600_000, "daily-batch", maybeRunDaily);
}

function every(ms: number, name: string, fn: () => Promise<unknown>): void {
  const run = () =>
    fn().catch((err) => logger.error({ cron: name, err: String(err) }, "cron job failed"));
  setTimeout(run, 15_000); // first pass shortly after boot
  setInterval(run, ms);
}

let lastDailyDate = "";

/** Fires once per day at/after 9am America/New_York (spec §11 default). */
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

  // digest covers the previous ET day
  const prev = new Date(now.getTime() - 86_400_000);
  const prevDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(prev);
  await generateDigest(prevDate);
  await expireWatchlist();
  await corpusStats();
  await thresholdDriftReport();
}

async function corpusStats(): Promise<void> {
  const rows = await db
    .select({ network: schema.fingerprintCorpus.network })
    .from(schema.fingerprintCorpus);
  const byNetwork = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.network] = (acc[r.network] ?? 0) + 1;
    return acc;
  }, {});
  logger.info({ corpus: byNetwork, total: rows.length }, "corpus stats");
}

/** Threshold drift report: the distribution of nearest-neighbor distances for
 *  yesterday's deploys tells the operator whether CLONE/NOVEL thresholds still
 *  cut the data where they should. Logged, not actioned. */
async function thresholdDriftReport(): Promise<void> {
  const since = new Date(Date.now() - 86_400_000);
  const recent = await db
    .select()
    .from(schema.fingerprintCorpus)
    .where(and(eq(schema.fingerprintCorpus.network, "mainnet"), gte(schema.fingerprintCorpus.seenAt, since)));
  const older = await db
    .select({ tlsh: schema.fingerprintCorpus.tlsh, sizeBytes: schema.fingerprintCorpus.sizeBytes })
    .from(schema.fingerprintCorpus)
    .where(eq(schema.fingerprintCorpus.network, "mainnet"));

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
