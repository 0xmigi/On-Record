import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./config.js";

// One pipeline stage per queue (spec §4). Jobs carry only the event id; each
// worker re-reads the row so stages stay idempotent and replayable.
export const QUEUES = {
  fingerprint: "fingerprint",
  identify: "identify",
  classify: "classify",
  rank: "rank",
  write: "write",
  verify: "verify",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface EventJob {
  eventId: string;
}

export interface WriteJob {
  /** anchor event; empty string only for operator-triggered discrepancy
   *  stories where nothing has shipped on chain */
  eventId: string;
  storyType: string;
  /** copy-wave stories are about a bucket, not a single event */
  bucketId?: string;
  /** corroboration lever input */
  announcementUrl?: string;
  programId?: string;
  /** set on verify-failure rewrite attempts */
  rewriteErrors?: string[];
}

export interface VerifyJob {
  eventId: string;
  storyType: string;
  draft: unknown;
  attempt: number;
  bucketId?: string;
  announcementUrl?: string;
  programId?: string;
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
        removeOnFail: false, // keep failures visible for /admin dead-letter review
      },
    });
    queues.set(name, q);
  }
  return q;
}

export async function enqueue(name: QueueName, data: EventJob | WriteJob | VerifyJob): Promise<void> {
  await getQueue(name).add(name, data);
}
