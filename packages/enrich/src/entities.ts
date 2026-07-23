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
  authorities?: string[];
}

export async function seedFromLabels(): Promise<number> {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "labels.yaml");
  const doc = parse(await readFile(file, "utf8")) as { entities?: LabelEntry[] };
  let count = 0;
  for (const entry of doc.entities ?? []) {
    await upsertEntity({ ...entry, source: "labels" });
    count++;
  }
  return count;
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
    const authorities = [...new Set([...row.authorities, ...(entry.authorities ?? [])])];
    await db
      .update(schema.entities)
      .set({
        programIds,
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
    authorities: entry.authorities ?? [],
    tvl: entry.tvl ?? null,
    tvlUpdatedAt: entry.tvl != null ? new Date() : null,
    source: entry.source,
  });
}

export async function findEntityForProgram(programId: string): Promise<{ id: string; name: string; tvl: number | null } | null> {
  const rows = await db
    .select()
    .from(schema.entities)
    .where(sql`${schema.entities.programIds} @> ${JSON.stringify([programId])}::jsonb`);
  const row = rows[0];
  return row ? { id: row.id, name: row.name, tvl: row.tvl } : null;
}

export async function findEntityForAuthority(authority: string): Promise<{ id: string; name: string } | null> {
  const rows = await db
    .select()
    .from(schema.entities)
    .where(sql`${schema.entities.authorities} @> ${JSON.stringify([authority])}::jsonb`);
  const row = rows[0];
  return row ? { id: row.id, name: row.name } : null;
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
