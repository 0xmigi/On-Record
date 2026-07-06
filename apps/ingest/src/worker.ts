import { Worker } from "bullmq";
import {
  makeRedis,
  logger,
  QUEUES,
  type EventJob,
  type QueueName,
  type VerifyJob,
  type WriteJob,
} from "@onrecord/core";
import {
  classifyStage,
  fingerprintStage,
  identifyStage,
  rankStage,
  verifyStage,
  writeStage,
} from "./pipeline.js";
import { startCron } from "./cron.js";

// ---------------------------------------------------------------------------
// The newsroom's back office: one BullMQ worker per pipeline stage (spec §4).
// Fingerprint is capped at 8 concurrent bytecode fetches; the LLM stages run
// serially so the daily budget check can't race itself into overspending.
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
stageWorker<EventJob>(QUEUES.rank, 2, ({ eventId }) => rankStage(eventId));
stageWorker<WriteJob>(QUEUES.write, 1, (job) => writeStage(job));
stageWorker<VerifyJob>(QUEUES.verify, 1, (job) => verifyStage(job));

startCron();

logger.info("onrecord workers running: fingerprint → identify → classify → rank → write → verify");
