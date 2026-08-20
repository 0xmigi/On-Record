import { eq } from "drizzle-orm";
import { db, schema } from "./db/client.js";
import { decodeInstructionUsage, type InstructionUsage } from "./usage.js";
import { sampleProgramTraffic, type TrafficSample } from "./traffic.js";
import type { Network } from "./types.js";

// ---------------------------------------------------------------------------
// Stored activity samples: the read side of `activity_samples`.
//
// Everything metered goes through here. `readUsage`/`readTraffic` never touch
// the chain — they answer from the table and hand back the measurement time so
// the caller can say when it was true. `sampleUsageNow`/`sampleTrafficNow` are
// the only functions that spend credits, and they are called on demand only —
// today that means the dossier with ?sample=live. Nothing samples on a clock.
//
// See the schema comment for why this exists at all.
// ---------------------------------------------------------------------------

/** A stored sample: the payload, plus when it was measured.
 *  `sampledAt === null` means nobody has ever looked — which is NOT the same
 *  as a sample that came back empty (payload null, sampledAt set). */
export interface StoredSample<T> {
  value: T | null;
  sampledAt: Date | null;
}

const NEVER: StoredSample<never> = { value: null, sampledAt: null };

/** Instruction usage as last measured. Free — reads the table. */
export async function readUsage(subjectId: string): Promise<StoredSample<InstructionUsage>> {
  const [row] = await db
    .select({ usage: schema.activitySamples.usage, at: schema.activitySamples.usageSampledAt })
    .from(schema.activitySamples)
    .where(eq(schema.activitySamples.subjectId, subjectId));
  if (!row) return NEVER;
  return { value: (row.usage as InstructionUsage | null) ?? null, sampledAt: row.at ?? null };
}

/** Traffic shape as last measured. Free — reads the table. */
export async function readTraffic(subjectId: string): Promise<StoredSample<TrafficSample>> {
  const [row] = await db
    .select({ traffic: schema.activitySamples.traffic, at: schema.activitySamples.trafficSampledAt })
    .from(schema.activitySamples)
    .where(eq(schema.activitySamples.subjectId, subjectId));
  if (!row) return NEVER;
  return { value: (row.traffic as TrafficSample | null) ?? null, sampledAt: row.at ?? null };
}

/** Measure instruction usage now and write it through. SPENDS CREDITS. */
export async function sampleUsageNow(
  network: Network,
  subjectId: string,
  opts: { sample?: number } = {},
): Promise<StoredSample<InstructionUsage>> {
  const usage = await decodeInstructionUsage(network, subjectId, opts);
  const now = new Date();
  await db
    .insert(schema.activitySamples)
    .values({
      subjectId,
      network,
      usage: (usage ?? null) as Record<string, unknown> | null,
      usageSampledAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.activitySamples.subjectId,
      set: {
        usage: (usage ?? null) as Record<string, unknown> | null,
        usageSampledAt: now,
        updatedAt: now,
      },
    });
  return { value: usage, sampledAt: now };
}

/** Measure traffic shape now and write it through. SPENDS CREDITS. */
export async function sampleTrafficNow(
  network: Network,
  subjectId: string,
  opts: { signatures?: number; parse?: number } = {},
): Promise<StoredSample<TrafficSample>> {
  const traffic = await sampleProgramTraffic(network, subjectId, opts);
  const now = new Date();
  await db
    .insert(schema.activitySamples)
    .values({
      subjectId,
      network,
      traffic: (traffic ?? null) as Record<string, unknown> | null,
      trafficSampledAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.activitySamples.subjectId,
      set: {
        traffic: (traffic ?? null) as Record<string, unknown> | null,
        trafficSampledAt: now,
        updatedAt: now,
      },
    });
  return { value: traffic, sampledAt: now };
}
