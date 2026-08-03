import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { eq, sql } from "drizzle-orm";
import { db, schema, logger, newId } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Entity registry (spec §4.2): who is behind a program id. Seeded from the
// in-repo labels.yaml plus DeFiLlama's protocol list; refreshed TVL every 6h.
// ---------------------------------------------------------------------------

interface LabelEntry {
  name: string;
  slug: string;
  category?: string;
  website?: string;
  llamaSlug?: string;
  programIds?: string[];
  programNames?: Record<string, string>;
  authorities?: string[];
}

/** A `programIds:` entry is either a bare id (the program carries the entity
 *  name) or `<id>: <name>` (it carries its own). The second form exists because
 *  "Jupiter" on twelve different rows tells a reader nothing about which of
 *  Jupiter's programs they are looking at. */
type ProgramEntry = string | Record<string, string>;

interface RawLabelEntry extends Omit<LabelEntry, "programIds"> {
  programIds?: ProgramEntry[];
}

export async function seedFromLabels(): Promise<number> {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "labels.yaml");
  const doc = parse(await readFile(file, "utf8")) as { entities?: RawLabelEntry[] };
  let count = 0;
  for (const entry of doc.entities ?? []) {
    await upsertEntity({ ...entry, ...splitProgramEntries(entry), source: "labels" });
    count++;
  }
  return count;
}

/** Flatten the two `programIds:` forms into the flat id list plus the id→name
 *  map. A malformed entry is fatal rather than skipped: a dropped id is a
 *  landmark that silently never gets named, which is the exact failure this
 *  registry exists to prevent. */
function splitProgramEntries(entry: RawLabelEntry): {
  programIds: string[];
  programNames: Record<string, string>;
} {
  const programIds: string[] = [];
  const programNames: Record<string, string> = {};
  for (const item of entry.programIds ?? []) {
    if (typeof item === "string") {
      programIds.push(item);
      continue;
    }
    const pairs = Object.entries(item ?? {});
    if (pairs.length !== 1 || typeof pairs[0]?.[1] !== "string") {
      throw new Error(
        `labels.yaml: entity "${entry.slug}" has a programIds entry that is neither an id nor a single id: name pair`,
      );
    }
    const [id, name] = pairs[0]!;
    programIds.push(id);
    programNames[id] = name;
  }
  return { programIds, programNames };
}

interface LlamaProtocol {
  name: string;
  slug: string;
  category?: string;
  url?: string;
  chains?: string[];
  tvl?: number;
  address?: string | null;
}

/** Pull Solana protocols from DeFiLlama. Program-id mappings from Llama are
 *  sparse; the main value is names + TVL, which snapshot onto events. */
export async function seedFromDefiLlama(): Promise<number> {
  const res = await fetch("https://api.llama.fi/protocols", { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`defillama protocols: HTTP ${res.status}`);
  const protocols = (await res.json()) as LlamaProtocol[];
  let count = 0;
  for (const p of protocols) {
    if (!p.chains?.includes("Solana")) continue;
    const programIds: string[] = [];
    if (p.address?.startsWith("solana:")) programIds.push(p.address.slice("solana:".length));
    await upsertEntity(
      {
        name: p.name,
        slug: p.slug,
        category: p.category,
        website: p.url,
        llamaSlug: p.slug,
        programIds,
        tvl: p.tvl,
        source: "defillama",
      },
      // never let Llama clobber curated names/program lists
      { preferExisting: true },
    );
    count++;
  }
  return count;
}

async function upsertEntity(
  entry: LabelEntry & { tvl?: number; source: string },
  opts: { preferExisting?: boolean } = {},
): Promise<void> {
  const existing = await db.select().from(schema.entities).where(eq(schema.entities.slug, entry.slug));
  const row = existing[0];
  if (row) {
    const programIds = [...new Set([...row.programIds, ...(entry.programIds ?? [])])];
    // curated per-program names win over whatever was stored last run; Llama
    // never supplies them, so preferExisting leaves the map untouched
    const programNames = opts.preferExisting
      ? row.programNames
      : { ...row.programNames, ...(entry.programNames ?? {}) };
    const authorities = [...new Set([...row.authorities, ...(entry.authorities ?? [])])];
    await db
      .update(schema.entities)
      .set({
        programIds,
        programNames,
        authorities,
        tvl: entry.tvl ?? row.tvl,
        tvlUpdatedAt: entry.tvl != null ? new Date() : row.tvlUpdatedAt,
        ...(opts.preferExisting
          ? {}
          : {
              name: entry.name,
              category: entry.category ?? row.category,
              website: entry.website ?? row.website,
              llamaSlug: entry.llamaSlug ?? row.llamaSlug,
            }),
      })
      .where(eq(schema.entities.id, row.id));
    return;
  }
  await db.insert(schema.entities).values({
    id: newId("ent"),
    name: entry.name,
    slug: entry.slug,
    category: entry.category ?? null,
    website: entry.website ?? null,
    llamaSlug: entry.llamaSlug ?? null,
    programIds: entry.programIds ?? [],
    programNames: entry.programNames ?? {},
    authorities: entry.authorities ?? [],
    tvl: entry.tvl ?? null,
    tvlUpdatedAt: entry.tvl != null ? new Date() : null,
    source: entry.source,
  });
}

export async function findEntityForProgram(
  programId: string,
): Promise<{ id: string; name: string; category: string | null; tvl: number | null } | null> {
  const rows = await db
    .select()
    .from(schema.entities)
    .where(sql`${schema.entities.programIds} @> ${JSON.stringify([programId])}::jsonb`);
  const row = rows[0];
  if (!row) return null;
  // the specific name for THIS program, else the entity's own
  return {
    id: row.id,
    name: row.programNames?.[programId] ?? row.name,
    category: row.category,
    tvl: row.tvl,
  };
}

export async function findEntityForAuthority(
  authority: string,
): Promise<{ id: string; name: string; category: string | null } | null> {
  const rows = await db
    .select()
    .from(schema.entities)
    .where(sql`${schema.entities.authorities} @> ${JSON.stringify([authority])}::jsonb`);
  const row = rows[0];
  return row ? { id: row.id, name: row.name, category: row.category } : null;
}

/** 6-hourly TVL refresh (spec §8): re-pull per-protocol TVL for entities we
 *  know the llama slug of. */
export async function refreshTvl(): Promise<void> {
  const rows = await db.select().from(schema.entities);
  for (const row of rows) {
    if (!row.llamaSlug) continue;
    try {
      const res = await fetch(`https://api.llama.fi/tvl/${encodeURIComponent(row.llamaSlug)}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const tvl = Number(await res.text());
      if (!Number.isFinite(tvl)) continue;
      await db
        .update(schema.entities)
        .set({ tvl, tvlUpdatedAt: new Date() })
        .where(eq(schema.entities.id, row.id));
    } catch (err) {
      logger.warn({ slug: row.llamaSlug, err: String(err) }, "tvl refresh failed");
    }
  }
}
