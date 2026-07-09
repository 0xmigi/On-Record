import { Worker } from "bullmq";
import { makeRedis, logger, QUEUES, type EventJob, type QueueName } from "@onrecord/core";
import { classifyStage, fingerprintStage, identifyStage, scoreStage } from "./pipeline.js";
import { startCron } from "./cron.js";

// ---------------------------------------------------------------------------
// One BullMQ worker per pipeline stage (SPEC §3). Fingerprint is capped at 8
// concurrent bytecode fetches; score does the funding/usage RPC walks so it
// runs a little wider.
//   fingerprint → identify → classify → score
// ---------------------------------------------------------------------------

function stageWorker<T>(
  name: QueueName,
  concurrency: number,
  handler: (data: T) => Promise<void>,
): Worker {
  const worker = new Worker(
    name,
    async (job) => {
      await handler(job.data as T);
    },
    { connection: makeRedis(), concurrency },
  );
  worker.on("failed", (job, err) => {
    logger.error({ queue: name, jobId: job?.id, err: err.message }, "stage failed");
  });
  return worker;
}

stageWorker<EventJob>(QUEUES.fingerprint, 8, ({ eventId }) => fingerprintStage(eventId));
stageWorker<EventJob>(QUEUES.identify, 4, ({ eventId }) => identifyStage(eventId));
stageWorker<EventJob>(QUEUES.classify, 2, ({ eventId }) => classifyStage(eventId));
stageWorker<EventJob>(QUEUES.score, 4, ({ eventId }) => scoreStage(eventId));

startCron();

logger.info("onrecord workers running: fingerprint → identify → classify → score");
