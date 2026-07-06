import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import {
  db,
  schema,
  env,
  type ApiCursorPage,
  type ApiDigest,
  type ApiRawEvent,
  type ApiStats,
  type ApiStory,
  type ApiStoryDetail,
  type ApiSubject,
  type ApiWatchlistItem,
} from "@onrecord/core";
import { serializeEvent, serializeStories } from "../serialize.js";

// ---------------------------------------------------------------------------
// Public read API (spec §2). Self-contained JSON, stable ids, cursor paging.
// Everything sits behind this one layer so auth/metering could be inserted
// later without changing routes.
// ---------------------------------------------------------------------------

const STORY_TYPES = new Set([
  "update",
  "launch",
  "radar",
  "became_real",
  "corroboration",
  "control_change",
  "copy_wave",
]);

export function registerPublicRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { type?: string; cursor?: string; limit?: string } }>(
    "/api/stories",
    async (req): Promise<ApiCursorPage<ApiStory>> => {
      const limit = Math.min(Number(req.query.limit ?? 30) || 30, 100);
      const type = req.query.type && STORY_TYPES.has(req.query.type) ? req.query.type : null;

      const conditions = [
        or(eq(schema.stories.status, "published"), eq(schema.stories.status, "pinned")),
      ];
      if (type) conditions.push(eq(schema.stories.type, type));
      if (req.query.cursor) conditions.push(lt(schema.stories.id, req.query.cursor));

      const rows = await db
        .select()
        .from(schema.stories)
        .where(and(...conditions))
        .orderBy(desc(schema.stories.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const items = await serializeStories(page);
      // pinned first within the first page only, so paging cursors stay stable
      if (!req.query.cursor) items.sort((a, b) => Number(b.pinned) - Number(a.pinned));
      return { items, nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null };
    },
  );

  app.get<{ Params: { id: string } }>("/api/stories/:id", async (req, reply) => {
    const rows = await db.select().from(schema.stories).where(eq(schema.stories.id, req.params.id));
    const row = rows[0];
    if (!row || row.status === "killed" || row.status === "dead_letter") {
      return reply.code(404).send({ error: "story not found" });
    }
    const [story] = await serializeStories([row]);
    const events = row.eventIds.length
      ? await db.select().from(schema.events).where(inArray(schema.events.id, row.eventIds))
      : [];
    const detail: ApiStoryDetail = { ...story!, events: events.map(serializeEvent) };
    return detail;
  });

  app.get<{ Params: { date: string } }>("/api/digest/:date", async (req, reply) => {
    const rows = await db.select().from(schema.digests).where(eq(schema.digests.date, req.params.date));
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "no digest for that date" });
    const storyRows = row.storyIds.length
      ? await db.select().from(schema.stories).where(inArray(schema.stories.id, row.storyIds))
      : [];
    const digest: ApiDigest = {
      date: row.date,
      stories: await serializeStories(storyRows),
      counts: row.counts,
    };
    return digest;
  });

  app.get<{ Params: { id: string } }>("/api/subjects/:id", async (req, reply) => {
    const rows = await db.select().from(schema.subjects).where(eq(schema.subjects.id, req.params.id));
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "subject not found" });

    const storyRows = await db
      .select()
      .from(schema.stories)
      .where(
        and(
          or(eq(schema.stories.status, "published"), eq(schema.stories.status, "pinned")),
          sql`${schema.stories.subjects} @> ${JSON.stringify([row.id])}::jsonb`,
        ),
      )
      .orderBy(desc(schema.stories.id))
      .limit(50);

    const subject: ApiSubject = {
      id: row.id,
      kind: row.kind as ApiSubject["kind"],
      name: row.name,
      network: row.network as ApiSubject["network"],
      verified: row.verified,
      repoUrl: row.repoUrl,
      authorityClass: row.authorityClass as ApiSubject["authorityClass"],
      tvl: row.tvl,
      noveltyScore: row.noveltyScore,
      bucketId: row.bucketId,
      stories: await serializeStories(storyRows),
    };
    return subject;
  });

  app.get<{ Querystring: { cursor?: string; limit?: string; network?: string } }>(
    "/api/raw/events",
    async (req): Promise<ApiCursorPage<ApiRawEvent>> => {
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const conditions = [];
      if (req.query.network === "mainnet" || req.query.network === "devnet") {
        conditions.push(eq(schema.events.network, req.query.network));
      }
      if (req.query.cursor) conditions.push(lt(schema.events.id, req.query.cursor));
      const rows = await db
        .select()
        .from(schema.events)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(schema.events.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      return {
        items: page.map(serializeEvent),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    },
  );

  app.get("/api/lab", async (): Promise<ApiWatchlistItem[]> => {
    const rows = await db
      .select()
      .from(schema.watchlist)
      .where(eq(schema.watchlist.status, "active"))
      .orderBy(desc(schema.watchlist.lastSeenAt))
      .limit(100);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as ApiWatchlistItem["kind"],
      programId: r.programId,
      authority: r.authority,
      source: r.source as ApiWatchlistItem["source"],
      note: r.note,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      deployCount: r.deployCount,
      expiresAt: r.expiresAt.toISOString(),
      status: r.status as ApiWatchlistItem["status"],
    }));
  });

  app.get("/api/stats", async (): Promise<ApiStats> => {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const weekStart = new Date(Date.now() - 7 * 86_400_000);

    const todayStories = await db
      .select({ type: schema.stories.type })
      .from(schema.stories)
      .where(
        and(
          gte(schema.stories.createdAt, dayStart),
          or(eq(schema.stories.status, "published"), eq(schema.stories.status, "pinned")),
        ),
      );
    const weekStories = await db
      .select({ type: schema.stories.type })
      .from(schema.stories)
      .where(
        and(
          gte(schema.stories.createdAt, weekStart),
          or(eq(schema.stories.status, "published"), eq(schema.stories.status, "pinned")),
        ),
      );

    const todayDeploys = await db
      .select({ enrichment: schema.events.enrichment })
      .from(schema.events)
      .where(
        and(
          gte(schema.events.createdAt, dayStart),
          eq(schema.events.network, "mainnet"),
          eq(schema.events.type, "deploy"),
        ),
      );
    const copies = todayDeploys.filter((e) => {
      const cls = (e.enrichment as { classification?: { disposition?: string } }).classification;
      return cls?.disposition === "copy" || cls?.disposition === "near_copy";
    });

    return {
      launchesToday: todayStories.filter((s) => s.type === "launch").length,
      updatesToday: todayStories.filter((s) => s.type === "update").length,
      copyPercentToday: todayDeploys.length
        ? Math.round((copies.length / todayDeploys.length) * 100)
        : 0,
      radarThisWeek: weekStories.filter((s) => s.type === "radar").length,
    };
  });

  // RSS — cheap, and agents/readers both consume it (spec §2)
  app.get("/rss.xml", async (_req, reply) => {
    const rows = await db
      .select()
      .from(schema.stories)
      .where(or(eq(schema.stories.status, "published"), eq(schema.stories.status, "pinned")))
      .orderBy(desc(schema.stories.id))
      .limit(50);
    const stories = await serializeStories(rows);
    const items = stories
      .map(
        (s) => `    <item>
      <title>${escapeXml(s.headline)}</title>
      <link>${env.PUBLIC_API_URL}/api/stories/${s.id}</link>
      <guid isPermaLink="false">${s.id}</guid>
      <pubDate>${new Date(s.publishedAt).toUTCString()}</pubDate>
      <category>${s.type}</category>
      <description>${escapeXml(s.body)}</description>
    </item>`,
      )
      .join("\n");
    reply.type("application/rss+xml");
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>On Record</title>
    <link>${env.PUBLIC_API_URL}</link>
    <description>When it's real, at the source. Solana launches, updates and control changes — from the chain, with receipts.</description>
${items}
  </channel>
</rss>`;
  });

  app.get("/health", async () => ({ ok: true }));
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
