import { and, eq, gte, isNull, lt, lte, ne, sql } from "drizzle-orm";
import {
  lineageSizeWindow,
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
// Corpus scan is linear with an asymmetric size prefilter (see lineage.ts) —
// fine at ~2k events/day.
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

export interface ClassifyOptions {
  /** false when re-running the gate over already-ingested programs (the
   *  reclassify cron): membership can still move, but nothing new arrived, so
   *  the clone-velocity signal must not tick. Default true (a live deploy). */
  arrival?: boolean;
  /** the deploy's upgrade authority, for watchlist authority matches */
  authority?: string | null;
}

export async function classifyFingerprint(
  network: Network,
  programId: string,
  fp: Fingerprint,
  opts: ClassifyOptions = {},
): Promise<Classification> {
  const cfg = await getConfig();
  const arrival = opts.arrival !== false;

  // When this program is already in the corpus (a reclassify pass), only what
  // the corpus held BEFORE this BYTECODE first appeared may claim it as a copy
  // or set its band — otherwise the original of a cloned family gets demoted to
  // a clone of its own copycats as they accumulate. Null on the live path (the
  // corpus append happens after classification), where everything is prior.
  //
  // The cut is anchored to the bytecode, NOT to the program's own first
  // sighting. A program is graded on its CURRENT binary, and for an upgraded
  // program those two dates are far apart: anchoring on the program excluded
  // every corpus row recorded between its original deploy and the code actually
  // being graded. That produced rows badged "novel — no known relative" while
  // carrying a 94–99%-similar neighbour (measured 2026-07-24: 66 of 69 such
  // rows, 27 of them excluding a neighbour that genuinely predated the code).
  // Same firstSeen/lastEvent confusion the radar's upgrade window had.
  const mine = await db
    .select({ at: sql<string | null>`min(${schema.fingerprintCorpus.seenAt})` })
    .from(schema.fingerprintCorpus)
    .where(
      and(
        eq(schema.fingerprintCorpus.network, network),
        eq(schema.fingerprintCorpus.programId, programId),
        eq(schema.fingerprintCorpus.sha256, fp.sha256),
      ),
    );
  const firstSeen = mine[0]?.at ? new Date(mine[0].at) : null;

  // 1. exact byte-match → clone. The gate is a PRIOR deploy of the identical
  // bytecode by some other program id: a bot that redeploys the same binary
  // under fresh program ids would otherwise fall through to the TLSH scan,
  // which skips same-sha candidates (see below), and surface as "novel" every
  // time. A bucket may or may not exist yet — one is only created once a
  // *second* copy shows up.
  const exact = await db
    .select()
    .from(schema.copyBuckets)
    .where(and(eq(schema.copyBuckets.network, network), eq(schema.copyBuckets.canonicalSha256, fp.sha256)));

  const priorCopy = await db
    .select({ programId: schema.fingerprintCorpus.programId })
    .from(schema.fingerprintCorpus)
    .where(
      and(
        eq(schema.fingerprintCorpus.network, network),
        eq(schema.fingerprintCorpus.sha256, fp.sha256),
        ne(schema.fingerprintCorpus.programId, programId),
        ...(firstSeen ? [lt(schema.fingerprintCorpus.seenAt, firstSeen)] : []),
      ),
    )
    .limit(1);

  if (priorCopy[0]) {
    // join the existing bucket, or create one keyed on this sha256 (with the
    // earlier deploy as canonical) when this is the second sighting.
    const bucketId = exact[0]
      ? (await joinBucket(network, programId, exact[0].id, arrival), exact[0].id)
      : await bucketForSha(network, programId, fp.sha256, fp, arrival);
    return {
      disposition: "copy",
      band: "clone",
      bucketId,
      nearestDistance: 0,
      nearestProgramId: priorCopy[0]?.programId ?? null,
      nearestPeersWithin5: 0,
      nearestRunnerUpDistance: null,
      structuralNovelty: 0,
      watchlistHit: await matchWatchlist(network, programId, fp, opts.authority ?? null),
    };
  }

  // 2/3. nearest neighbor over the corpus (asymmetric size prefilter). We also measure
  // the *crowd* — how many distinct programs cluster within 5 similarity points of
  // the nearest — so the UI can flag a generic framework-shape match (a pack) vs a
  // genuine relative (a standout), instead of crowning one arbitrary tie-winner.
  let nearest: { distance: number; sha256: string; programId: string } | null = null;
  // band-eligible nearest: only neighbors that predate this program's own first
  // appearance can decide its band (see firstSeen above). `nearest` itself
  // stays corpus-wide — the displayed "nearest relative" should refresh as
  // siblings arrive; the band should not decay because of them.
  let nearestPrior: { distance: number; sha256: string; programId: string } | null = null;
  let peersWithin5 = 0;
  let runnerUpDistance: number | null = null;
  if (fp.tlsh) {
    const [lo, hi] = lineageSizeWindow(fp.sizeBytes);
    const candidates = await db
      .select({
        programId: schema.fingerprintCorpus.programId,
        sha256: schema.fingerprintCorpus.sha256,
        tlsh: schema.fingerprintCorpus.tlsh,
        seenAt: schema.fingerprintCorpus.seenAt,
      })
      .from(schema.fingerprintCorpus)
      .where(
        and(
          eq(schema.fingerprintCorpus.network, network),
          gte(schema.fingerprintCorpus.sizeBytes, lo),
          lte(schema.fingerprintCorpus.sizeBytes, hi),
        ),
      );
    // min distance per distinct program (corpus is append-only → many rows/program)
    const minByProgram = new Map<string, { distance: number; sha256: string; prior: boolean }>();
    for (const c of candidates) {
      if (!c.tlsh || c.sha256 === fp.sha256 || c.programId === programId) continue;
      const d = tlshDistance(fp.tlsh, c.tlsh);
      if (d === null) continue;
      const prior = firstSeen === null || c.seenAt < firstSeen;
      const prev = minByProgram.get(c.programId);
      if (!prev || d < prev.distance) {
        minByProgram.set(c.programId, { distance: d, sha256: c.sha256, prior });
      } else if (prev.distance === d && prior && !prev.prior) {
        prev.prior = true; // same distance from a prior row — keep the prior flag
      }
    }
    const ranked = [...minByProgram.entries()]
      .map(([pid, v]) => ({ programId: pid, distance: v.distance, sha256: v.sha256, prior: v.prior }))
      .sort((a, b) => a.distance - b.distance);
    if (ranked[0]) {
      nearest = ranked[0];
      runnerUpDistance = ranked[1]?.distance ?? null;
      // 5 similarity points = 15 TLSH distance units (similarity = 1 − d/300)
      peersWithin5 = ranked.filter((r) => r.distance <= ranked[0]!.distance + 15).length;
    }
    nearestPrior = ranked.find((r) => r.prior) ?? null;
  }

  const minDist = nearestPrior?.distance ?? Infinity;
  // structural novelty from bytecode distance: clamp((minDist − NOVEL) / 300, 0, 1)
  const structuralNovelty =
    minDist === Infinity ? 1 : Math.max(0, Math.min(1, (minDist - cfg.NOVEL_THRESHOLD) / 300));

  let disposition: Classification["disposition"];
  let bucketId: string | null = null;

  if (nearestPrior && nearestPrior.distance < cfg.CLONE_THRESHOLD) {
    disposition = "near_copy";
    bucketId = await bucketForSha(network, programId, nearestPrior.sha256, fp, arrival);
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
    nearestPeersWithin5: peersWithin5,
    nearestRunnerUpDistance: runnerUpDistance,
    structuralNovelty,
    watchlistHit: await matchWatchlist(network, programId, fp, opts.authority ?? null),
  };
}

/** find (or create) the bucket whose canonical fingerprint is `sha256`,
 *  record the near-copy, return the bucket id. */
async function bucketForSha(
  network: Network,
  programId: string,
  sha256: string,
  fp: Fingerprint,
  arrival: boolean,
): Promise<string> {
  const rows = await db
    .select()
    .from(schema.copyBuckets)
    .where(and(eq(schema.copyBuckets.network, network), eq(schema.copyBuckets.canonicalSha256, sha256)));
  if (rows[0]) {
    await joinBucket(network, programId, rows[0].id, arrival);
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
  // Mark the canonical's subject row as a member. Without this, a later
  // reclassify of the canonical fails the membership check below and bumps the
  // count it was already part of.
  await db
    .update(schema.subjects)
    .set({ bucketId: id })
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.sha256, sha256),
        isNull(schema.subjects.bucketId),
      ),
    );
  return id;
}

/** Count a program into a bucket exactly once. memberCount and the velocity
 *  series only move when the program wasn't already a member — reclassify
 *  passes re-run this path every few hours, and unconditional bumps inflated
 *  both numbers forever. Velocity additionally requires a live arrival: a
 *  reclassified old program is membership drift, not clone velocity. */
async function joinBucket(
  network: Network,
  programId: string,
  bucketId: string,
  arrival: boolean,
): Promise<void> {
  const current = await db
    .select({ bucketId: schema.subjects.bucketId })
    .from(schema.subjects)
    .where(and(eq(schema.subjects.id, programId), eq(schema.subjects.network, network)));
  if (current[0]?.bucketId === bucketId) return; // already counted
  const now = new Date();
  const hourKey = now.toISOString().slice(0, 13); // per-hour velocity bucket
  await db
    .update(schema.copyBuckets)
    .set({
      memberCount: sql`${schema.copyBuckets.memberCount} + 1`,
      lastSeenAt: now,
      ...(arrival
        ? {
            velocity: sql`jsonb_set(coalesce(${schema.copyBuckets.velocity}, '{}'::jsonb), ${`{${hourKey}}`}::text[], (coalesce(${schema.copyBuckets.velocity}->>${hourKey}, '0')::int + 1)::text::jsonb)`,
          }
        : {}),
    })
    .where(eq(schema.copyBuckets.id, bucketId));
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
