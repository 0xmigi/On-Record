import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db, schema, type ApiFunnel, type Network } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Funnel computation (SPEC §1, §6): raw deploy+upgrade events → unique bytecode
// → novel. Counted over a UTC-day window, keyed by date. "today" uses a
// trailing window so the number is live.
// ---------------------------------------------------------------------------

export function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function dayBounds(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000);
  return { start, end };
}

/** Compute the funnel for a date directly from events + subjects. */
export async function computeFunnel(date: string, network: Network = "mainnet"): Promise<ApiFunnel> {
  const { start, end } = dayBounds(date);
  // for the current day, count right up to now (trailing/live)
  const upper = date === todayKey() ? new Date() : end;

  // raw = deploy + upgrade events in the window
  const rawRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.network, network),
        inArray(schema.events.type, ["deploy", "upgrade"]),
        gte(schema.events.createdAt, start),
        lt(schema.events.createdAt, upper),
      ),
    );
  const raw = Number(rawRows[0]?.n ?? 0);

  // newly-seen programs in the window carry the band + category we ranked on
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

  return {
    date,
    raw,
    unique: uniqueSha.size,
    novel,
    clones,
    variants,
    byCategory,
    updatedAt: new Date().toISOString(),
  };
}

/** Compute and persist the snapshot for a date. */
export async function snapshotFunnel(date: string, network: Network = "mainnet"): Promise<ApiFunnel> {
  const f = await computeFunnel(date, network);
  await db
    .insert(schema.funnelDaily)
    .values({
      date,
      network,
      raw: f.raw,
      unique: f.unique,
      novel: f.novel,
      clones: f.clones,
      variants: f.variants,
      byCategory: f.byCategory,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.funnelDaily.date,
      set: {
        raw: f.raw,
        unique: f.unique,
        novel: f.novel,
        clones: f.clones,
        variants: f.variants,
        byCategory: f.byCategory,
        updatedAt: new Date(),
      },
    });
  return f;
}

/** Read a stored snapshot, falling back to a live computation. */
export async function readFunnel(date: string, network: Network = "mainnet"): Promise<ApiFunnel> {
  // today is always computed live so the number moves; past days read the row
  if (date === todayKey()) return computeFunnel(date, network);
  const rows = await db.select().from(schema.funnelDaily).where(eq(schema.funnelDaily.date, date));
  const row = rows[0];
  if (!row) return computeFunnel(date, network);
  return {
    date: row.date,
    raw: row.raw,
    unique: row.unique,
    novel: row.novel,
    clones: row.clones,
    variants: row.variants,
    byCategory: row.byCategory,
    updatedAt: row.updatedAt.toISOString(),
  };
}
