import { env, logger } from "@onrecord/core";
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

startCron();
logger.info("onrecord live: running");
