import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./config.js";

// One pipeline stage per queue (SPEC §3). Jobs carry only the event id; each
// worker re-reads the row so stages stay idempotent and replayable.
//   fingerprint → identify → classify → score
export const QUEUES = {
  fingerprint: "fingerprint",
  identify: "identify",
  classify: "classify",
  score: "score",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface EventJob {
  eventId: string;
}

export function makeRedis(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

const queues = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: makeRedis(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { count: 5_000 },
        removeOnFail: false, // keep failures visible for /admin review
      },
    });
    queues.set(name, q);
  }
  return q;
}

export async function enqueue(name: QueueName, data: EventJob): Promise<void> {
  // Backfill drives the stages inline in-process (no Redis); the stage functions
  // still call enqueue() for the next hop, so make it a no-op in that mode.
  if (process.env.INLINE_PIPELINE === "1") return;
  await getQueue(name).add(name, data);
}
