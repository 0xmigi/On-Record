import { and, eq, gte, lte, ne, sql } from "drizzle-orm";
import {
  db,
  schema,
  newId,
  tlshDistance,
  getConfig,
  type Classification,
  type Fingerprint,
  type Network,
  type NoveltyBand,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// Classify stage (SPEC §2, the gate). Deploys only — upgrades inherit identity.
//   1. exact sha256 match → existing copy bucket, increment → band=clone
//   2. TLSH distance < CLONE_THRESHOLD → same bucket → band=variant
//   3. distance ≥ NOVEL_THRESHOLD from all neighbors → band=novel
//   4. middle band → band=variant (near a family, not a clean clone)
// Corpus scan is linear with a size ±20% prefilter — fine at ~2k events/day.
// ---------------------------------------------------------------------------

/** Collapse the 4-way corpus disposition into the 3-way radar band. */
function toBand(disposition: Classification["disposition"]): NoveltyBand {
  switch (disposition) {
    case "copy":
      return "clone";
    case "novel":
      return "novel";
    default:
      return "variant"; // near_copy + data_only both fold into variant
  }
}

export async function classifyFingerprint(
  network: Network,
  programId: string,
  fp: Fingerprint,
): Promise<Classification> {
  const cfg = await getConfig();

  // 1. exact match
  const exact = await db
    .select()
    .from(schema.copyBuckets)
    .where(and(eq(schema.copyBuckets.network, network), eq(schema.copyBuckets.canonicalSha256, fp.sha256)));
  if (exact[0]) {
    await bumpBucket(exact[0].id);
    // resolve the canonical member so the clone points at its original
    const canonical = await db
      .select({ programId: schema.fingerprintCorpus.programId })
      .from(schema.fingerprintCorpus)
      .where(
        and(
          eq(schema.fingerprintCorpus.network, network),
          eq(schema.fingerprintCorpus.sha256, fp.sha256),
          ne(schema.fingerprintCorpus.programId, programId),
        ),
      )
      .limit(1);
    return {
      disposition: "copy",
      band: "clone",
      bucketId: exact[0].id,
      nearestDistance: 0,
      nearestProgramId: canonical[0]?.programId ?? null,
      structuralNovelty: 0,
      watchlistHit: await matchWatchlist(network, programId, fp, null),
    };
  }

  // 2/3. nearest neighbor over the corpus (size ±20% prefilter)
  let nearest: { distance: number; sha256: string; programId: string } | null = null;
  if (fp.tlsh) {
    const lo = Math.floor(fp.sizeBytes * 0.8);
    const hi = Math.ceil(fp.sizeBytes * 1.2);
    const candidates = await db
      .select({
        programId: schema.fingerprintCorpus.programId,
        sha256: schema.fingerprintCorpus.sha256,
        tlsh: schema.fingerprintCorpus.tlsh,
      })
      .from(schema.fingerprintCorpus)
      .where(
        and(
          eq(schema.fingerprintCorpus.network, network),
          gte(schema.fingerprintCorpus.sizeBytes, lo),
          lte(schema.fingerprintCorpus.sizeBytes, hi),
        ),
      );
    for (const c of candidates) {
      if (!c.tlsh || c.sha256 === fp.sha256 || c.programId === programId) continue;
      const d = tlshDistance(fp.tlsh, c.tlsh);
      if (d !== null && (nearest === null || d < nearest.distance)) {
        nearest = { distance: d, sha256: c.sha256, programId: c.programId };
      }
    }
  }

  const minDist = nearest?.distance ?? Infinity;
  // structural novelty from bytecode distance: clamp((minDist − NOVEL) / 300, 0, 1)
  const structuralNovelty =
    minDist === Infinity ? 1 : Math.max(0, Math.min(1, (minDist - cfg.NOVEL_THRESHOLD) / 300));

  let disposition: Classification["disposition"];
  let bucketId: string | null = null;

  if (nearest && nearest.distance < cfg.CLONE_THRESHOLD) {
    disposition = "near_copy";
    bucketId = await bucketForSha(network, nearest.sha256, fp);
  } else if (minDist >= cfg.NOVEL_THRESHOLD) {
    disposition = "novel";
  } else {
    disposition = "data_only";
  }

  return {
    disposition,
    band: toBand(disposition),
    bucketId,
    nearestDistance: nearest?.distance ?? null,
    nearestProgramId: nearest?.programId ?? null,
    structuralNovelty,
    watchlistHit: await matchWatchlist(network, programId, fp, null),
  };
}

/** find (or create) the bucket whose canonical fingerprint is `sha256`,
 *  record the near-copy, return the bucket id. */
async function bucketForSha(network: Network, sha256: string, fp: Fingerprint): Promise<string> {
  const rows = await db
    .select()
    .from(schema.copyBuckets)
    .where(and(eq(schema.copyBuckets.network, network), eq(schema.copyBuckets.canonicalSha256, sha256)));
  if (rows[0]) {
    await bumpBucket(rows[0].id);
    return rows[0].id;
  }
  // The neighbor exists in the corpus but was never bucketed (it was the first
  // of its kind). Create the bucket with the neighbor as canonical.
  const id = newId("bkt");
  await db.insert(schema.copyBuckets).values({
    id,
    network,
    canonicalSha256: sha256,
    canonicalTlsh: fp.tlsh,
    memberCount: 2, // canonical + this near-copy
  });
  return id;
}

async function bumpBucket(id: string): Promise<void> {
  const now = new Date();
  const hourKey = now.toISOString().slice(0, 13); // per-hour velocity bucket
  await db
    .update(schema.copyBuckets)
    .set({
      memberCount: sql`${schema.copyBuckets.memberCount} + 1`,
      lastSeenAt: now,
      velocity: sql`jsonb_set(coalesce(${schema.copyBuckets.velocity}, '{}'::jsonb), ${`{${hourKey}}`}::text[], (coalesce(${schema.copyBuckets.velocity}->>${hourKey}, '0')::int + 1)::text::jsonb)`,
    })
    .where(eq(schema.copyBuckets.id, id));
}

/** copies of a bucket in the trailing N hours, from the velocity jsonb */
export function bucketVelocity(velocity: Record<string, unknown>, hours: number): number {
  const cutoff = Date.now() - hours * 3_600_000;
  let total = 0;
  for (const [hourKey, count] of Object.entries(velocity)) {
    const t = Date.parse(hourKey + ":00:00Z");
    if (Number.isFinite(t) && t >= cutoff) total += Number(count) || 0;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Watchlist matching (spec §3): a mainnet deploy matching a devnet-watchlist
// fingerprint (exact or near) or authority → "became real" candidate.
// ---------------------------------------------------------------------------

async function matchWatchlist(
  network: Network,
  programId: string,
  fp: Fingerprint,
  authority: string | null,
): Promise<Classification["watchlistHit"]> {
  if (network !== "mainnet") return null;
  const cfg = await getConfig();
  const active = await db.select().from(schema.watchlist).where(eq(schema.watchlist.status, "active"));
  for (const item of active) {
    if (item.sha256 && item.sha256 === fp.sha256) {
      return { watchlistId: item.id, matchedOn: "sha256" };
    }
    if (item.tlsh && fp.tlsh) {
      const d = tlshDistance(item.tlsh, fp.tlsh);
      if (d !== null && d < cfg.CLONE_THRESHOLD) return { watchlistId: item.id, matchedOn: "tlsh" };
    }
    if (authority && item.authority && item.authority === authority) {
      return { watchlistId: item.id, matchedOn: "authority" };
    }
  }
  return null;
}

/** Separate authority-only pass, used when the deploy's authority is known. */
export async function matchWatchlistAuthority(authority: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(schema.watchlist)
    .where(and(eq(schema.watchlist.status, "active"), eq(schema.watchlist.authority, authority)));
  return rows[0]?.id ?? null;
}

export async function appendToCorpus(
  network: Network,
  programId: string,
  fp: Fingerprint,
): Promise<void> {
  await db.insert(schema.fingerprintCorpus).values({
    id: newId("fpc"),
    programId,
    network,
    sha256: fp.sha256,
    tlsh: fp.tlsh,
    sizeBytes: fp.sizeBytes,
  });
}
