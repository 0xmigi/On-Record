import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db, schema, type ApiFunnel, type Network, type ProgramProfile } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Funnel / Program Stats (SPEC §1, §6). A windowed view over the loader stream:
// deploy+upgrade events split into new deploys vs upgrades, and the new
// programs broken down by category, framework, integrations, identity, lineage,
// control and funding — all computed live from events + subjects (the profile
// now rides on subjects.profile). The web Stats page + radar header read this.
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

const WINDOW_HOURS: Record<string, number> = { "24h": 24, "48h": 48, "7d": 168, "30d": 720 };

/** Map the web's window key ("24h".."30d") to hours; default 48h. */
export function windowHoursFor(key: string | undefined): number {
  return WINDOW_HOURS[key ?? ""] ?? 48;
}

type SubjectLite = {
  sha256: string | null;
  noveltyBand: string | null;
  category: string | null;
  name: string | null;
  repoUrl: string | null;
  authorityClass: string | null;
  verified: boolean;
  entityKey: string | null;
  deployerFundingSource: string | null;
  profile: ProgramProfile | null;
  firstSeenAt: Date | null;
};

/** The rich funnel for a trailing window. */
export async function computeWindowFunnel(
  windowHours: number,
  network: Network = "mainnet",
): Promise<ApiFunnel> {
  const now = Date.now();
  const start = new Date(now - windowHours * HOUR);
  const midMs = now - (windowHours / 2) * HOUR;

  // event time = actual deploy time when we have it, else insert time (backfill).
  // Raw-SQL comparisons must bind an ISO string + ::timestamptz cast — the driver
  // only auto-encodes Date when drizzle knows the column type (not for coalesce()).
  const eventTime = sql`coalesce(${schema.events.blockTime}, ${schema.events.createdAt})`;
  const eventTimeGte = (d: Date) => sql`${eventTime} >= ${d.toISOString()}::timestamptz`;

  // raw + deploy/upgrade split
  const evRows = await db
    .select({ type: schema.events.type, n: sql<number>`count(*)` })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.network, network),
        inArray(schema.events.type, ["deploy", "upgrade"]),
        eventTimeGte(start),
      ),
    )
    .groupBy(schema.events.type);
  let deploys = 0;
  let upgrades = 0;
  for (const r of evRows) {
    if (r.type === "deploy") deploys = Number(r.n);
    else if (r.type === "upgrade") upgrades = Number(r.n);
  }
  const raw = deploys + upgrades;

  // new-program subjects in the window carry everything the breakdowns need
  const subs = (await db
    .select({
      sha256: schema.subjects.sha256,
      noveltyBand: schema.subjects.noveltyBand,
      category: schema.subjects.category,
      name: schema.subjects.name,
      repoUrl: schema.subjects.repoUrl,
      authorityClass: schema.subjects.authorityClass,
      verified: schema.subjects.verified,
      entityKey: schema.subjects.entityKey,
      deployerFundingSource: schema.subjects.deployerFundingSource,
      profile: schema.subjects.profile,
      firstSeenAt: schema.subjects.firstSeenAt,
    })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        gte(schema.subjects.firstSeenAt, start),
      ),
    )) as SubjectLite[];

  const uniqueSha = new Set<string>();
  let novel = 0;
  let variants = 0;
  let clones = 0;
  const byCategory: Record<string, number> = {};
  const byFramework: Record<string, number> = {};
  const byIntegration: Record<string, number> = {};
  const byCapability: Record<string, number> = {};
  const identity = { named: 0, withRepo: 0, opaque: 0 };
  const lineage = { novel: 0, variant: 0, fork: 0 };
  const control = { mutable: 0, frozen: 0, verified: 0 };
  const conviction = { knownEntity: 0, funderTraced: 0, untraced: 0 };
  const fwEarly: Record<string, number> = {};
  const fwLate: Record<string, number> = {};
  let earlyTotal = 0;
  let lateTotal = 0;

  for (const s of subs) {
    if (s.sha256) uniqueSha.add(s.sha256);
    if (s.noveltyBand === "novel") {
      novel++;
      lineage.novel++;
    } else if (s.noveltyBand === "variant") {
      variants++;
      lineage.variant++;
    } else if (s.noveltyBand === "clone") {
      clones++;
      lineage.fork++;
    }

    const cat = s.category ?? "unknown";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;

    const fw = s.profile?.framework ?? "unknown";
    byFramework[fw] = (byFramework[fw] ?? 0) + 1;
    for (const cap of s.profile?.capabilities ?? []) byCapability[cap] = (byCapability[cap] ?? 0) + 1;
    for (const integ of s.profile?.integrations ?? [])
      byIntegration[integ] = (byIntegration[integ] ?? 0) + 1;

    if (s.name) identity.named++;
    if (s.repoUrl) identity.withRepo++;
    if (!s.name && !s.repoUrl) identity.opaque++;

    if (s.authorityClass === "none") control.frozen++;
    else if (s.authorityClass) control.mutable++;
    if (s.verified) control.verified++;

    if (s.entityKey) conviction.knownEntity++;
    else if (s.deployerFundingSource) conviction.funderTraced++;
    else conviction.untraced++;

    const t = s.firstSeenAt?.getTime() ?? 0;
    if (t >= midMs) {
      fwLate[fw] = (fwLate[fw] ?? 0) + 1;
      lateTotal++;
    } else {
      fwEarly[fw] = (fwEarly[fw] ?? 0) + 1;
      earlyTotal++;
    }
  }

  const frameworkTrend = Object.keys(byFramework)
    .map((framework) => {
      const earlyShare = earlyTotal ? (fwEarly[framework] ?? 0) / earlyTotal : 0;
      const lateShare = lateTotal ? (fwLate[framework] ?? 0) / lateTotal : 0;
      return {
        framework,
        current: byFramework[framework] ?? 0,
        earlyShare,
        lateShare,
        delta: lateShare - earlyShare,
      };
    })
    .sort((a, b) => b.current - a.current);

  // 30-day hourly deploy/upgrade volume for the chart
  const volStart = new Date(now - 30 * 24 * HOUR);
  const bucket = sql<string>`to_char(date_trunc('hour', ${eventTime}), 'YYYY-MM-DD"T"HH24:00:00"Z"')`;
  const volRows = await db
    .select({ bucket, n: sql<number>`count(*)` })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.network, network),
        inArray(schema.events.type, ["deploy", "upgrade"]),
        eventTimeGte(volStart),
      ),
    )
    .groupBy(bucket)
    .orderBy(bucket);
  const volume = volRows.map((r) => ({
    t: Math.floor(new Date(r.bucket).getTime() / 1000),
    count: Number(r.n),
  }));

  return {
    date: todayKey(),
    raw,
    unique: uniqueSha.size,
    novel,
    clones,
    variants,
    deploys,
    upgrades,
    windowHours,
    aggregateWindowHours: windowHours,
    capped: false,
    byCategory,
    byFramework,
    byIntegration,
    byCapability,
    volume,
    identity,
    lineage,
    control,
    conviction,
    frameworkTrend,
    updatedAt: new Date().toISOString(),
  };
}

/** Cron helper: persist a compact daily record to funnel_daily (historical trail).
 *  The live API uses computeWindowFunnel; this is just the append-only record. */
export async function snapshotFunnel(date: string, network: Network = "mainnet"): Promise<void> {
  const { start, end } = dayBounds(date);
  const upper = date === todayKey() ? new Date() : end;
  const eventTime = sql`coalesce(${schema.events.blockTime}, ${schema.events.createdAt})`;

  const rawRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.network, network),
        inArray(schema.events.type, ["deploy", "upgrade"]),
        sql`${eventTime} >= ${start.toISOString()}::timestamptz`,
        sql`${eventTime} < ${upper.toISOString()}::timestamptz`,
      ),
    );
  const raw = Number(rawRows[0]?.n ?? 0);

  const subs = await db
    .select({
      sha256: schema.subjects.sha256,
      band: schema.subjects.noveltyBand,
      category: schema.subjects.category,
    })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        gte(schema.subjects.firstSeenAt, start),
        lt(schema.subjects.firstSeenAt, upper),
      ),
    );

  const uniqueSha = new Set<string>();
  let clones = 0;
  let variants = 0;
  let novel = 0;
  const byCategory: Record<string, number> = {};
  for (const s of subs) {
    if (s.sha256) uniqueSha.add(s.sha256);
    if (s.band === "clone") clones++;
    else if (s.band === "variant") variants++;
    else if (s.band === "novel") {
      novel++;
      const cat = s.category ?? "unknown";
      byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    }
  }

  await db
    .insert(schema.funnelDaily)
    .values({ date, network, raw, unique: uniqueSha.size, novel, clones, variants, byCategory, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.funnelDaily.date,
      set: { raw, unique: uniqueSha.size, novel, clones, variants, byCategory, updatedAt: new Date() },
    });
}

function dayBounds(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}
