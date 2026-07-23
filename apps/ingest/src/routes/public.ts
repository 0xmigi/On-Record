import type { FastifyInstance } from "fastify";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import {
  db,
  schema,
  env,
  tlshDistance,
  fetchAnchorIdl,
  decodeInstructionUsage,
  looksLikeProgramId,
  escapeLike,
  lineageSizeWindow,
  sharedPathCount,
  pathOverlap,
  isSourceRelative,
  type ApiCluster,
  type ApiCursorPage,
  type ApiProgram,
  type ApiProgramDetail,
  type ApiRawEvent,
  type NoveltyBand,
} from "@onrecord/core";
import {
  serializeEvent,
  serializeProgram,
  serializeProgramDetail,
  type NearestMeta,
} from "../serialize.js";
import { computeWindowFunnel, windowHoursFor } from "../funnel.js";

// ---------------------------------------------------------------------------
// Public read API (SPEC §7). Self-contained JSON, stable ids, cursor paging.
// Everything sits behind this one layer so auth/metering could be inserted
// later without changing routes.
// ---------------------------------------------------------------------------

const BANDS = new Set<NoveltyBand>(["clone", "variant", "novel"]);

function windowStart(window: string | undefined): Date | null {
  if (window === "all") return null;
  if (window === "month") return new Date(Date.now() - 30 * 86_400_000);
  if (window === "week") return new Date(Date.now() - 7 * 86_400_000);
  return new Date(Date.now() - 86_400_000); // default: rolling last 24h
}

/** cursor = base64("<lastSeenMs>:<id>") for stable recency-desc, id-desc paging */
function encodeCursor(ts: number, id: string): string {
  return Buffer.from(`${ts}:${id}`).toString("base64url");
}
function decodeCursor(cursor: string): { ts: number; id: string } | null {
  try {
    const [ts, id] = Buffer.from(cursor, "base64url").toString().split(":");
    if (ts === undefined || id === undefined) return null;
    const t = Number(ts);
    // a malformed cursor must page from the start, not become NaN → new Date(NaN) → 500
    if (!Number.isFinite(t) || t < 0) return null;
    return { ts: t, id };
  } catch {
    return null;
  }
}

/** Clamp a ?limit= query param to [1, max]; garbage and negatives fall back to
 *  the default instead of reaching Postgres as an invalid LIMIT. */
function parseLimit(raw: string | undefined, def: number, max: number): number {
  const n = Math.floor(Number(raw ?? def));
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

/** Resolve display metadata for the nearest-relative ids stashed in facts:
 *  name + whether the relative is a known reference (registry entity or
 *  verified build) rather than an anonymous peer deploy. */
async function nearestMetaFor(rows: { facts: unknown }[]): Promise<Map<string, NearestMeta>> {
  const ids = [
    ...new Set(
      rows
        .map((r) => ((r.facts ?? {}) as { nearest?: { id?: string } }).nearest?.id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (!ids.length) return new Map();
  const relatives = await db
    .select({
      id: schema.subjects.id,
      name: schema.subjects.name,
      entityKey: schema.subjects.entityKey,
      verified: schema.subjects.verified,
      firstDeployAt: schema.subjects.firstDeployAt,
      firstSeenAt: schema.subjects.firstSeenAt,
    })
    .from(schema.subjects)
    .where(inArray(schema.subjects.id, ids));
  return new Map(
    relatives.map((r) => [
      r.id,
      {
        name: r.name,
        isReference: Boolean(r.entityKey) || r.verified,
        deployedAt: (r.firstDeployAt ?? r.firstSeenAt)?.toISOString() ?? null,
      },
    ]),
  );
}

/** Programs sharing this one's crate, ranked by how much of the source tree
 *  they actually share. A shared name alone proves nothing — Raydium and
 *  Meteora both ship a crate called `amm` and share one file — so
 *  isSourceRelative() requires path evidence before anything is returned. */
async function resolveSourceKin(row: {
  id: string;
  network: string;
  crate: string | null;
  sourcePaths: string[] | null;
}): Promise<ApiProgramDetail["sourceKin"]> {
  if (!row.crate) return [];
  const candidates = await db
    .select({
      id: schema.subjects.id,
      name: schema.subjects.name,
      crate: schema.subjects.crate,
      sourcePaths: schema.subjects.sourcePaths,
      firstDeployAt: schema.subjects.firstDeployAt,
      firstSeenAt: schema.subjects.firstSeenAt,
    })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, row.network),
        eq(schema.subjects.crate, row.crate),
        ne(schema.subjects.id, row.id),
      ),
    )
    .limit(200);

  const mine = row.sourcePaths ?? [];
  const kin = candidates
    .map((c) => {
      const theirs = c.sourcePaths ?? [];
      return {
        programId: c.id,
        name: c.name,
        crate: row.crate!,
        sharedFiles: sharedPathCount(mine, theirs),
        overlap: pathOverlap(mine, theirs),
        deployedAt: (c.firstDeployAt ?? c.firstSeenAt)?.toISOString() ?? null,
      };
    })
    .filter((k) => isSourceRelative(row.crate, row.crate, k.sharedFiles, k.overlap))
    .sort((a, b) => b.sharedFiles - a.sharedFiles || b.overlap - a.overlap);

  return kin.slice(0, 10);
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
  app.get<{ Querystring: { window?: string; band?: string; type?: string; cursor?: string; limit?: string; closed?: string; sort?: string; network?: string } }>(
    "/api/radar",
    async (req): Promise<ApiCursorPage<ApiProgram>> => {
      const limit = parseLimit(req.query.limit, 30, 100);
      const network = req.query.network === "devnet" ? "devnet" : "mainnet";
      // interest ordering (interest.ts v0.1 blend, stored on noveltyScore) is
      // the default — "most worth seeing first". ?sort=recent restores the
      // plain stream (and keeps cursor paging; interest pages have no cursor).
      // Devnet has no interest scores by design (no usage/money signals —
      // pipeline stops at classify), so it always serves the recency stream.
      const sort = req.query.sort === "recent" || network === "devnet" ? "recent" : "interest";
      const hasBand = !!(req.query.band && BANDS.has(req.query.band as NoveltyBand));
      const band = hasBand ? (req.query.band as NoveltyBand) : "novel";
      const type = req.query.type === "upgrade" ? "upgrade" : "deploy";
      const start = windowStart(req.query.window);
      // closed programs (rent reclaimed) are the churn tail — hidden by default,
      // ?closed=1 shows them, ?closed=only isolates the graveyard.
      const closedMode = req.query.closed === "1" ? "include" : req.query.closed === "only" ? "only" : "hide";

      const conditions = [
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
      ];
      // The deploy stream tiers by novelty (novel/variant/clone) and always
      // passes an explicit band. The upgrade stream spans all bands — an
      // upgrade's lineage band is orthogonal to the fact that it was upgraded,
      // so only constrain by band when one is explicitly requested. Forcing the
      // default "novel" here is what left the upgrade tab empty: nearly every
      // real upgrade lands in variant/clone.
      if (hasBand || type === "deploy") {
        conditions.push(eq(schema.subjects.noveltyBand, band));
      }
      if (closedMode === "hide") {
        conditions.push(sql`(${schema.subjects.facts} ->> 'closedAt') is null`);
      } else if (closedMode === "only") {
        conditions.push(sql`(${schema.subjects.facts} ->> 'closedAt') is not null`);
      }
      // deploy vs upgrade stream. Unclassified (null) rows read as new deploys so
      // nothing silently disappears before the classifier has run.
      if (type === "upgrade") {
        conditions.push(eq(schema.subjects.deployType, "upgrade"));
      } else {
        conditions.push(
          or(eq(schema.subjects.deployType, "deploy"), isNull(schema.subjects.deployType))!,
        );
      }
      if (start) conditions.push(gte(schema.subjects.firstSeenAt, start));
      // "newest" only makes sense for dated rows: undated reference-corpus
      // seeds would sort NULLS FIRST above every real deploy, and their ts=0
      // cursor would dead-end the next page.
      if (sort === "recent") conditions.push(isNotNull(schema.subjects.firstSeenAt));

      const cur = sort === "recent" && req.query.cursor ? decodeCursor(req.query.cursor) : null;
      if (cur) {
        const curDate = new Date(cur.ts);
        conditions.push(
          or(
            lt(schema.subjects.firstSeenAt, curDate),
            and(eq(schema.subjects.firstSeenAt, curDate), lt(schema.subjects.id, cur.id)),
          )!,
        );
      }

      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(schema.subjects)
          .where(and(...conditions))
          .orderBy(
            ...(sort === "interest"
              ? [sql`${schema.subjects.noveltyScore} desc nulls last`, desc(schema.subjects.firstSeenAt), desc(schema.subjects.id)]
              : [sql`${schema.subjects.firstSeenAt} desc nulls last`, desc(schema.subjects.id)]),
          )
          .limit(limit + 1),
        // true row count for the same slice — the radar's tier counts read
        // this, not items.length (which caps at the page limit)
        db
          .select({ n: sql<number>`count(*)` })
          .from(schema.subjects)
          .where(and(...conditions)),
      ]);

      const page = rows.slice(0, limit);
      const [sizes, nearest] = await Promise.all([
        clusterSizes(page.map((r) => r.bucketId)),
        nearestMetaFor(page),
      ]);
      const items = page.map((r) =>
        serializeProgram(r, r.bucketId ? (sizes.get(r.bucketId) ?? null) : null, nearest),
      );
      const last = page[page.length - 1];
      return {
        items,
        total: Number(totalRows[0]?.n ?? items.length),
        // cursor paging is recency-keyed; interest-ordered pages don't paginate
        nextCursor:
          sort === "recent" && rows.length > limit && last
            ? encodeCursor(last.firstSeenAt?.getTime() ?? 0, last.id)
            : null,
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
      const [lo, hi] = lineageSizeWindow(row.sizeBytes);
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

    const [clusterSize, nearestMeta] = await Promise.all([
      row.bucketId
        ? clusterSizes([row.bucketId]).then((m) => m.get(row.bucketId!) ?? null)
        : Promise.resolve(null),
      nearestMetaFor([row]),
    ]);
    // Source lineage: who else compiled from this crate. Answers the question
    // TLSH structurally cannot — tail.trade is a build of Drift's crate (88
    // shared files) at bytecode distance 182, which no threshold would ever
    // call a relative. The crate name only nominates; the shared file count
    // decides (see core/sourcetree.ts).
    const sourceKin = await resolveSourceKin(row);

    return serializeProgramDetail(row, events, neighbors, clusterSize, nearestMeta, sourceKin);
  });

  // --- a program's full Anchor IDL (the human-readable interface) ----------
  // Both RPC-backed routes require the id to be on record: they drive metered
  // Helius work, and an unknown-id default would let anyone burn credits by
  // iterating arbitrary addresses.
  app.get<{ Params: { id: string } }>("/api/programs/:id/idl", async (req, reply) => {
    const rows = await db
      .select({ network: schema.subjects.network })
      .from(schema.subjects)
      .where(eq(schema.subjects.id, req.params.id));
    if (!rows[0]) return reply.code(404).send({ error: "unknown program" });
    const network = rows[0].network as "mainnet" | "devnet";
    const idl = await fetchAnchorIdl(network, req.params.id);
    return { idl };
  });

  // --- instruction usage: the program's real "shape" (decoded from recent txns)
  app.get<{ Params: { id: string } }>("/api/programs/:id/usage", async (req, reply) => {
    const rows = await db
      .select({ network: schema.subjects.network })
      .from(schema.subjects)
      .where(eq(schema.subjects.id, req.params.id));
    if (!rows[0]) return reply.code(404).send({ error: "unknown program" });
    const network = rows[0].network as "mainnet" | "devnet";
    const usage = await decodeInstructionUsage(network, req.params.id, { sample: 400 });
    return { usage };
  });

  // --- the funnel / program stats (windowed) -------------------------------
  app.get<{ Querystring: { window?: string; network?: string } }>("/api/funnel", async (req) => {
    const network = req.query.network === "devnet" ? "devnet" : "mainnet";
    return computeWindowFunnel(windowHoursFor(req.query.window), network);
  });

  // --- a clone cluster -----------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/clusters/:id", async (req, reply) => {
    const rows = await db.select().from(schema.copyBuckets).where(eq(schema.copyBuckets.id, req.params.id));
    const bucket = rows[0];
    if (!bucket) return reply.code(404).send({ error: "cluster not found" });
    const members = await db
      .select({
        programId: schema.subjects.id,
        name: schema.subjects.name,
        deployedAt: schema.subjects.firstSeenAt,
        closedAt: sql<string | null>`${schema.subjects.facts} ->> 'closedAt'`,
      })
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
        name: m.name,
        deployedAt: m.deployedAt?.toISOString() ?? null,
        closed: m.closedAt != null,
      })),
    };
    return cluster;
  });

  // --- search: find a program by name, crate, repo or what it talks to -----
  // Ranked, not scored: an exact name beats a name prefix beats a name
  // substring beats an integration beats anything found in the binary. The
  // last tier is the interesting one — it matches crate names and error
  // identifiers in programs whose developers published nothing at all.
  app.get<{ Querystring: { q?: string; network?: string; limit?: string; sort?: string } }>(
    "/api/search",
    async (req): Promise<{ items: ApiProgram[]; query: string; truncated: boolean }> => {
      const raw = (req.query.q ?? "").trim();
      const limit = parseLimit(req.query.limit, 20, 50);
      const sort = req.query.sort === "recent" ? "recent" : "relevance";
      // 2 chars is the floor a trigram index can serve without degrading to a
      // full scan, and single letters match essentially every binary anyway.
      if (raw.length < 2) return { items: [], query: raw, truncated: false };

      // a pasted address isn't a text query — resolve it as an id
      if (looksLikeProgramId(raw)) {
        const hit = await db.select().from(schema.subjects).where(eq(schema.subjects.id, raw));
        const row = hit[0];
        if (row) {
          const [sizes, nearest] = await Promise.all([
            clusterSizes([row.bucketId]),
            nearestMetaFor([row]),
          ]);
          return {
            items: [serializeProgram(row, row.bucketId ? (sizes.get(row.bucketId) ?? null) : null, nearest)],
            query: raw,
            truncated: false,
          };
        }
        return { items: [], query: raw, truncated: false };
      }

      const q = escapeLike(raw.toLowerCase());
      const like = `%${q}%`;
      // Search spans both clusters whatever mode you're browsing in — a devnet
      // hit is still the answer to "where is this program", it just needs
      // labelling. No dedup pass is needed: subjects.id is the program address
      // and the primary key, so a program deployed to both clusters is one row,
      // and the mainnet upsert overwrites `network`. Its devnet history rides
      // along as the incubation fact the dossier already backlinks.
      const conditions = [eq(schema.subjects.kind, "program")];

      const rank = sql<number>`case
        when lower(${schema.subjects.name}) = ${q} then 0
        when lower(${schema.subjects.name}) like ${q + "%"} then 1
        when lower(${schema.subjects.name}) like ${like} then 2
        when lower(${schema.subjects.profile}::text) like ${like} then 3
        when lower(${schema.subjects.repoUrl}) like ${like} then 4
        when lower(${schema.subjects.id}) like ${q + "%"} then 5
        else 6 end`;
      // mainnet outranks devnet within a match tier, regardless of which mode
      // you're browsing — a live program beats a rehearsal of one
      const clusterRank = sql<number>`case
        when ${schema.subjects.network} = 'mainnet' then 0 else 1 end`;

      const rows = await db
        .select()
        .from(schema.subjects)
        .where(
          and(
            ...conditions,
            or(
              sql`lower(${schema.subjects.name}) like ${like}`,
              sql`lower(${schema.subjects.repoUrl}) like ${like}`,
              sql`lower(${schema.subjects.profile}::text) like ${like}`,
              sql`${schema.subjects.category} like ${like}`,
              sql`lower(${schema.subjects.id}) like ${q + "%"}`,
              sql`${schema.subjects.searchText} like ${like}`,
            )!,
          ),
        )
        // Match quality first, then mainnet over devnet, then the tiebreak.
        //
        // The tiebreak is what ?sort= switches, and it matters more than it
        // looks: a broad query like "metadao" matches nothing by name, so
        // every hit lands in the bytecode tier and the tiebreak becomes the
        // whole ordering. Interest rank answers "what's worth seeing"; recency
        // answers "what happened lately". Tiers stay above both either way, so
        // searching a name never buries the program that owns it.
        .orderBy(
          rank,
          clusterRank,
          ...(sort === "recent"
            ? [sql`${schema.subjects.firstSeenAt} desc nulls last`]
            : [sql`${schema.subjects.noveltyScore} desc nulls last`, desc(schema.subjects.firstSeenAt)]),
        )
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const [sizes, nearest] = await Promise.all([
        clusterSizes(page.map((r) => r.bucketId)),
        nearestMetaFor(page),
      ]);
      return {
        items: page.map((r) =>
          serializeProgram(r, r.bucketId ? (sizes.get(r.bucketId) ?? null) : null, nearest),
        ),
        query: raw,
        truncated: rows.length > limit,
      };
    },
  );

  // --- raw loader events (power users) ------------------------------------
  app.get<{ Querystring: { cursor?: string; limit?: string; network?: string } }>(
    "/api/raw/events",
    async (req): Promise<ApiCursorPage<ApiRawEvent>> => {
      const limit = parseLimit(req.query.limit, 50, 200);
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
