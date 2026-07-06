import { inArray } from "drizzle-orm";
import {
  db,
  schema,
  type ApiRawEvent,
  type ApiStory,
  type EventEnrichment,
  type StoryFact,
  type StoryInference,
} from "@onrecord/core";

type StoryRow = typeof schema.stories.$inferSelect;
type EventRow = typeof schema.events.$inferSelect;

export async function serializeStories(rows: StoryRow[]): Promise<ApiStory[]> {
  // resolve subject display names in one query
  const subjectIds = [...new Set(rows.flatMap((r) => r.subjects))];
  const subjectRows = subjectIds.length
    ? await db.select().from(schema.subjects).where(inArray(schema.subjects.id, subjectIds))
    : [];
  const names = new Map(subjectRows.map((s) => [s.id, s.name]));

  return rows.map((row) => ({
    id: row.id,
    type: row.type as ApiStory["type"],
    headline: row.headline,
    body: row.body,
    facts: row.facts as StoryFact[],
    inference: (row.inference as StoryInference | null) ?? null,
    subjects: row.subjects.map((id) => ({ id, name: names.get(id) ?? null })),
    status: row.status as ApiStory["status"],
    pinned: row.status === "pinned",
    publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
  }));
}

export function serializeEvent(row: EventRow): ApiRawEvent {
  return {
    id: row.id,
    network: row.network as ApiRawEvent["network"],
    type: row.type as ApiRawEvent["type"],
    signature: row.signature,
    slot: row.slot,
    blockTime: row.blockTime?.toISOString() ?? null,
    programId: row.programId,
    authorityBefore: row.authorityBefore,
    authorityAfter: row.authorityAfter,
    sha256After: row.sha256After,
    enrichment: row.enrichment as EventEnrichment,
  };
}
