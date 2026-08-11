import { and, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
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
// the only functions that spend credits, and nothing on a request path should
// call them (the sweep does, and the dossier does when explicitly asked with
// ?sample=live).
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

/** Record that somebody asked for this program, so the sweep knows it is worth
 *  spending on. Cheap (one upsert), and the only write a request path makes.
 *  Deliberately does not sample: request volume must never move the bill. */
export async function noteRequested(subjectId: string, network: Network): Promise<void> {
  const now = new Date();
  await db
    .insert(schema.activitySamples)
    .values({ subjectId, network, requestedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.activitySamples.subjectId,
      set: { requestedAt: now, updatedAt: now },
    });
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

/** Programs the sweep should spend on, in priority order:
 *    1. asked for, never sampled  (a visitor is looking at "not sampled yet")
 *    2. asked for, sample older than `staleAfterMs`
 *  Programs nobody has requested are never sampled at all — which is the whole
 *  point. Interest is the budget. */
export async function dueForSample(
  network: Network,
  column: "usage" | "traffic",
  opts: { max: number; staleAfterMs: number; requestedWithinMs: number },
): Promise<string[]> {
  const at =
    column === "usage" ? schema.activitySamples.usageSampledAt : schema.activitySamples.trafficSampledAt;
  const staleBefore = new Date(Date.now() - opts.staleAfterMs);
  const caresSince = new Date(Date.now() - opts.requestedWithinMs);

  const rows = await db
    .select({ id: schema.activitySamples.subjectId })
    .from(schema.activitySamples)
    .where(
      and(
        eq(schema.activitySamples.network, network),
        // only things a human has actually asked for, recently. These are the
        // typed operators on purpose: a Date interpolated into a raw sql``
        // fragment loses its column type and postgres.js rejects the bind.
        isNotNull(schema.activitySamples.requestedAt),
        gte(schema.activitySamples.requestedAt, caresSince),
        or(isNull(at), lt(at, staleBefore)),
      ),
    )
    // never-sampled first, then stalest
    .orderBy(sql`${at} asc nulls first`)
    .limit(opts.max);

  return rows.map((r) => r.id);
}
