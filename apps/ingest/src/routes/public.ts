import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  db,
  schema,
  env,
  tlshDistance,
  type ApiCluster,
  type ApiCursorPage,
  type ApiProgram,
  type ApiRawEvent,
  type NoveltyBand,
} from "@onrecord/core";
import { serializeEvent, serializeProgram, serializeProgramDetail } from "../serialize.js";
import { readFunnel, todayKey } from "../funnel.js";

// ---------------------------------------------------------------------------
// Public read API (SPEC §7). Self-contained JSON, stable ids, cursor paging.
// Everything sits behind this one layer so auth/metering could be inserted
// later without changing routes.
// ---------------------------------------------------------------------------

const BANDS = new Set<NoveltyBand>(["clone", "variant", "novel"]);

function windowStart(window: string | undefined): Date | null {
  if (window === "all") return null;
  if (window === "week") return new Date(Date.now() - 7 * 86_400_000);
  return new Date(`${todayKey()}T00:00:00.000Z`); // default: today
}

/** cursor = base64("<score>:<id>") for stable score-desc, id-desc paging */
function encodeCursor(score: number, id: string): string {
  return Buffer.from(`${score}:${id}`).toString("base64url");
}
function decodeCursor(cursor: string): { score: number; id: string } | null {
  try {
    const [score, id] = Buffer.from(cursor, "base64url").toString().split(":");
    if (score === undefined || id === undefined) return null;
    return { score: Number(score), id };
  } catch {
    return null;
  }
}

async function clusterSizes(bucketIds: (string | null)[]): Promise<Map<string, number>> {
  const ids = [...new Set(bucketIds.filter((b): b is string => Boolean(b)))];
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: schema.copyBuckets.id, n: schema.copyBuckets.memberCount })
    .from(schema.copyBuckets)
    .where(inArray(schema.copyBuckets.id, ids));
  return new Map(rows.map((r) => [r.id, r.n]));
}

export function registerPublicRoutes(app: FastifyInstance): void {
  // --- the radar: ranked programs -----------------------------------------
  app.get<{ Querystring: { window?: string; band?: string; cursor?: string; limit?: string } }>(
    "/api/radar",
    async (req): Promise<ApiCursorPage<ApiProgram>> => {
      const limit = Math.min(Number(req.query.limit ?? 30) || 30, 100);
      const band = req.query.band && BANDS.has(req.query.band as NoveltyBand) ? req.query.band : "novel";
      const start = windowStart(req.query.window);

      const conditions = [
        eq(schema.subjects.network, "mainnet"),
        eq(schema.subjects.kind, "program"),
        eq(schema.subjects.noveltyBand, band),
      ];
      if (start) conditions.push(gte(schema.subjects.firstSeenAt, start));

      const cur = req.query.cursor ? decodeCursor(req.query.cursor) : null;
      if (cur) {
        conditions.push(
          or(
            lt(schema.subjects.noveltyScore, cur.score),
            and(eq(schema.subjects.noveltyScore, cur.score), lt(schema.subjects.id, cur.id)),
          )!,
        );
      }

      const rows = await db
        .select()
        .from(schema.subjects)
        .where(and(...conditions))
        .orderBy(desc(schema.subjects.noveltyScore), desc(schema.subjects.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const sizes = await clusterSizes(page.map((r) => r.bucketId));
      const items = page.map((r) => serializeProgram(r, r.bucketId ? (sizes.get(r.bucketId) ?? null) : null));
      const last = page[page.length - 1];
      return {
        items,
        nextCursor:
          rows.length > limit && last ? encodeCursor(last.noveltyScore ?? 0, last.id) : null,
      };
    },
  );

  // --- one program: the dossier -------------------------------------------
  app.get<{ Params: { id: string } }>("/api/programs/:id", async (req, reply) => {
    const rows = await db.select().from(schema.subjects).where(eq(schema.subjects.id, req.params.id));
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: "program not found" });

    const events = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.programId, row.id))
      .orderBy(desc(schema.events.slot))
      .limit(50);

    // nearest bytecode relatives (size ±20% prefilter, TLSH distance)
    const neighbors: { programId: string; distance: number; name: string | null }[] = [];
    if (row.tlsh && row.sizeBytes) {
      const lo = Math.floor(row.sizeBytes * 0.8);
      const hi = Math.ceil(row.sizeBytes * 1.2);
      const candidates = await db
        .select({ programId: schema.fingerprintCorpus.programId, tlsh: schema.fingerprintCorpus.tlsh })
        .from(schema.fingerprintCorpus)
        .where(
          and(
            eq(schema.fingerprintCorpus.network, row.network),
            gte(schema.fingerprintCorpus.sizeBytes, lo),
            lte(schema.fingerprintCorpus.sizeBytes, hi),
            ne(schema.fingerprintCorpus.programId, row.id),
          ),
        );
      const scored: { programId: string; distance: number }[] = [];
      for (const c of candidates) {
        if (!c.tlsh) continue;
        const d = tlshDistance(row.tlsh, c.tlsh);
        if (d !== null) scored.push({ programId: c.programId, distance: d });
      }
      scored.sort((a, b) => a.distance - b.distance);
      const top = scored.slice(0, 5);
      const names = top.length
        ? await db
            .select({ id: schema.subjects.id, name: schema.subjects.name })
            .from(schema.subjects)
            .where(inArray(schema.subjects.id, top.map((t) => t.programId)))
        : [];
      const nameMap = new Map(names.map((n) => [n.id, n.name]));
      for (const t of top) neighbors.push({ ...t, name: nameMap.get(t.programId) ?? null });
    }

    const clusterSize = row.bucketId
      ? ((await clusterSizes([row.bucketId])).get(row.bucketId) ?? null)
      : null;
    return serializeProgramDetail(row, events, neighbors, clusterSize);
  });

  // --- the funnel ----------------------------------------------------------
  app.get<{ Querystring: { date?: string } }>("/api/funnel", async (req) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? "") ? req.query.date! : todayKey();
    return readFunnel(date);
  });

  // --- a clone cluster -----------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/clusters/:id", async (req, reply) => {
    const rows = await db.select().from(schema.copyBuckets).where(eq(schema.copyBuckets.id, req.params.id));
    const bucket = rows[0];
    if (!bucket) return reply.code(404).send({ error: "cluster not found" });
    const members = await db
      .select({ programId: schema.subjects.id, deployedAt: schema.subjects.firstSeenAt })
      .from(schema.subjects)
      .where(eq(schema.subjects.bucketId, bucket.id))
      .orderBy(desc(schema.subjects.firstSeenAt))
      .limit(200);
    const cluster: ApiCluster = {
      id: bucket.id,
      label: bucket.label,
      canonicalSha256: bucket.canonicalSha256,
      memberCount: bucket.memberCount,
      velocity6h: velocity6h(bucket.velocity),
      members: members.map((m) => ({
        programId: m.programId,
        deployedAt: m.deployedAt?.toISOString() ?? null,
      })),
    };
    return cluster;
  });

  // --- raw loader events (power users) ------------------------------------
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

  // --- radar as RSS: novel programs, newest first --------------------------
  app.get("/rss.xml", async (_req, reply) => {
    const rows = await db
      .select()
      .from(schema.subjects)
      .where(
        and(
          eq(schema.subjects.network, "mainnet"),
          eq(schema.subjects.kind, "program"),
          eq(schema.subjects.noveltyBand, "novel"),
        ),
      )
      .orderBy(desc(schema.subjects.firstSeenAt))
      .limit(50);
    const items = rows
      .map((r) => {
        const title = r.name ?? `Novel ${r.category ?? "program"} — ${r.id.slice(0, 8)}…`;
        const score = Math.round((r.noveltyScore ?? 0) * 100);
        return `    <item>
      <title>${escapeXml(title)}</title>
      <link>https://orb.helius.dev/address/${r.id}</link>
      <guid isPermaLink="false">${r.id}</guid>
      <pubDate>${new Date(r.firstSeenAt ?? r.createdAt).toUTCString()}</pubDate>
      <category>${r.category ?? "unknown"}</category>
      <description>${escapeXml(`novelty ${score}/100 · ${r.category ?? "unknown"} · ${r.instructionCount ?? "?"} instructions`)}</description>
    </item>`;
      })
      .join("\n");
    reply.type("application/rss+xml");
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>On Record — novel program radar</title>
    <link>${env.PUBLIC_API_URL}</link>
    <description>Newly deployed Solana programs with no known relative on chain, ranked by novelty.</description>
${items}
  </channel>
</rss>`;
  });

  app.get("/health", async () => ({ ok: true }));
}

/** copies of a bucket in the trailing 6h, from the velocity jsonb */
function velocity6h(velocity: Record<string, unknown>): number {
  const cutoff = Date.now() - 6 * 3_600_000;
  let total = 0;
  for (const [hourKey, count] of Object.entries(velocity)) {
    const t = Date.parse(hourKey + ":00:00Z");
    if (Number.isFinite(t) && t >= cutoff) total += Number(count) || 0;
  }
  return total;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
