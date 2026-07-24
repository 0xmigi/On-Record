import { assertTlshAvailable, env, logger } from "@onrecord/core";
import { createApp } from "./server.js";
import { startPolling } from "./poller.js";
import { startCron } from "./cron.js";

// ---------------------------------------------------------------------------
// Single-process live deployment (Railway). Runs the public read API, the live
// poller, and the scheduled jobs in one container with the pipeline inline —
// no Redis, no separate worker. Sized for ~157 deploys/day: enrichment per
// program is milliseconds, so a queue buys nothing here and one service keeps
// the hosting bill tiny.
//
//   API            → serves the web app (radar / dossier / funnel)
//   poller         → near-real-time loader ingestion (see poller.ts)
//   cron           → funnel snapshots, TVL refresh, daily batch (see cron.ts)
// ---------------------------------------------------------------------------

process.env.INLINE_PIPELINE = "1"; // stages run in-process; enqueue() is a no-op

// A stray fire-and-forget rejection must not kill the whole container (Node
// exits on unhandledRejection by default). Log it; the loops all catch.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: String(reason) }, "unhandled rejection (survived)");
});

// Prove the fingerprinter works before the poller can write anything. Without
// tlsh every ingested program lands as lineage-less "novel" while the pipeline
// still reports ok — fail at boot instead, where it is obvious.
await assertTlshAvailable();

const app = await createApp();
await app.listen({ port: env.PORT, host: "0.0.0.0" });
logger.info({ port: env.PORT }, "onrecord live: API listening");

if (process.env.LIVE_POLL_ENABLED !== "0") {
  startPolling({
    network: "mainnet",
    intervalMs: Number(process.env.LIVE_POLL_INTERVAL_MS ?? 120_000),
    bootstrapHours: Number(process.env.LIVE_POLL_BOOTSTRAP_HOURS ?? 1),
    max: Number(process.env.LIVE_POLL_MAX ?? 200),
  });
} else {
  logger.info("onrecord live: poller disabled (LIVE_POLL_ENABLED=0)");
}

// Devnet lineage feed (ROADMAP §1) — opt-in via env. Hourly is plenty: a
// devnet lineage only has to be on record before its mainnet debut, and the
// census measured ~300 programs touched/day (≈60–90K credits/mo all-in).
if (process.env.DEVNET_POLL_ENABLED === "1") {
  startPolling({
    network: "devnet",
    intervalMs: Number(process.env.DEVNET_POLL_INTERVAL_MS ?? 3_600_000),
    bootstrapHours: Number(process.env.DEVNET_POLL_BOOTSTRAP_HOURS ?? 2),
    max: Number(process.env.DEVNET_POLL_MAX ?? 400),
  });
} else {
  logger.info("onrecord live: devnet poller off (set DEVNET_POLL_ENABLED=1 to start)");
}

startCron();
logger.info("onrecord live: running");
