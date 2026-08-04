import { and, eq, ne, sql } from "drizzle-orm";
import {
  db,
  schema,
  isSourceRelative,
  pathOverlap,
  sharedPathCount,
  primitiveRarity,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// Interest score v0.1 — the surfacing methodology (VISION §5a), made concrete.
// "Interesting = unusually strong evidence of novelty, attention, adoption or
// disclosure for a program in its window — after discounting churn."
//
// Every component is a fixed, documented mapping of decoded facts (log-scaled
// so giants don't bury the emerging); churn discounts are multiplicative and
// recorded, not hidden. The score exists to ORDER the radar — the UI keeps
// showing the underlying signals, never this number.
//
//   disclosure .30  name/repo/site/IDL/security.txt/verified, of 6
//   novelty    .20  structural distance to nearest known code
//   primitives .15  rarity of the syscalls it imports, on its peak tier
//   newness    .10  e^(−age in days) — fresh deploys surface, then must earn it
//   momentum   .10  log₁₀ txns in last 24h (10k caps)
//   conviction .10  log₁₀ SOL locked by the deploy (100 SOL caps)
//   adoption   .05  fraction of the last 48 hours with ≥1 txn (sustained ≠ spike)
//
// Primitives joined at .15, taken from novelty (.25→.20) and newness (.20→.10).
// Newness gave up the most on purpose: sorting by "what landed most recently"
// is what the radar was drifting back into, and rarity of what a program calls
// is a far better reason to look at it than the hour it deployed.
//
// Usage was 45% of this (momentum .30 + adoption .15) and it is now 15%. Two
// reasons. It buried the finds: a program worth writing about is usually found
// BEFORE it has users, so scoring on traffic selects for things already past
// the interesting moment. And once devnet joined the same radar, usage stopped
// being comparable at all — a devnet program has no real traffic by definition,
// so weighting it heavily would have sorted an entire cluster to the bottom for
// a reason that says nothing about the code.
//
// Disclosure carries the most weight now because it is the sharpest bot filter
// we have that is not a band: a name, a repo, a site, an IDL, a security.txt
// and a verified build are six things a sniper never bothers with.
//
//   × 0.05 closed (rent reclaimed — the churn tail)
//   × 0.20 byte-clone (recycled code; sniper-flavored clones × 0.05)
//   ÷ family — 1/(1+log₂ n) scaled by how much of the family has been CLOSED,
//     where n is the larger of the copy bucket and the same-crate source family
//     (see familyOf). Size alone cannot tell a factory from a standard:
//     LayerZero's `oft` is on record 46 times and smart_arb 26, but oft has
//     closed none of them and smart_arb has closed 24. Rent is the tell — an
//     open program is SOL still locked up, a closed one is SOL taken back, so a
//     family that never closes anything is a family paying to stay.
//
// Stored on subjects.noveltyScore (the column the radar index already covers —
// it held the old placeholder blend, which this replaces) + facts.interest
// with the full component breakdown for explainability.
// ---------------------------------------------------------------------------

type SubjectRow = typeof schema.subjects.$inferSelect;

interface InterestFacts {
  activity?: { t: number; c: number }[];
  momentum?: { txns24h: number };
  nearest?: { id: string; distance: number };
  hasSecurityTxt?: boolean;
  securityTxt?: unknown;
  website?: string;
  social?: string;
  deployCostLamports?: number;
  closedAt?: string;
}

export interface Interest {
  score: number;
  components: Record<string, number>;
  penalty: number;
  sizePrior: number;
  /** what the churn discount was computed from, and which evidence set it */
  familySize: number;
  familyBasis: "none" | "bucket" | "source";
  /** share of the family already closed — 0 discounts nothing, 1 discounts fully */
  familyChurn: number;
  computedAt: string;
}

export interface Family {
  size: number;
  /** siblings with their rent reclaimed */
  closed: number;
  basis: Interest["familyBasis"];
}

export function computeInterest(row: SubjectRow, family: Family = { size: 1, closed: 0, basis: "none" }): Interest {
  const facts = (row.facts ?? {}) as InterestFacts;

  const txns24h = facts.momentum?.txns24h ?? row.earlySigners ?? 0;
  const momentum = Math.min(1, Math.log10(1 + txns24h) / 4);

  // sustained usage: how many of the last 48 hour-buckets saw any activity
  const now = Date.now();
  const activeHours = (facts.activity ?? []).filter(
    (p) => p.t >= now - 48 * 3_600_000 && p.c > 0,
  ).length;
  const adoption = Math.min(1, activeHours / 24);

  // structural novelty from the stored nearest-relative distance (same 0..300
  // span the classifier uses); clones are handled by the penalty below
  const novelty =
    row.noveltyBand === "clone"
      ? 0
      : facts.nearest
        ? Math.max(0, Math.min(1, facts.nearest.distance / 300))
        : 1;

  const disclosure =
    [
      row.name,
      row.repoUrl,
      facts.website ?? facts.social,
      row.idlPresent,
      Boolean(facts.hasSecurityTxt || facts.securityTxt),
      row.verified,
    ].filter(Boolean).length / 6;

  const costSol = (facts.deployCostLamports ?? 0) / 1e9;
  const conviction = Math.min(1, Math.log10(1 + costSol) / 2);

  // An undated row is a reference-corpus seed (an immutable landmark whose
  // deploy slot is not recoverable), not something that just landed. Defaulting
  // its age to `now` scored newness at a full 1.0 and would rank SPL Token
  // above the day's actual deploys.
  const deployedMs = (row.firstDeployAt ?? row.firstSeenAt)?.getTime() ?? null;
  const newness =
    deployedMs === null ? 0 : Math.exp(-Math.max(0, (now - deployedMs) / 86_400_000));

  // Rarity of the syscalls it imports, scored on the peak tier — the single
  // rarest thing it calls. Structural novelty says the code is unlike anything
  // on record; this says the code ASKS the runtime for something almost nobody
  // asks for. They catch different programs: a hand-rolled clone of a common
  // design scores low here, and a familiar-looking program that quietly imports
  // pairing crypto scores high.
  const primitives = primitiveRarity(row.profile?.syscalls).score;

  // Weights are also written out on /methodology — change both.
  const components = {
    momentum: momentum * 0.1,
    adoption: adoption * 0.05,
    novelty: novelty * 0.2,
    primitives: primitives * 0.15,
    disclosure: disclosure * 0.3,
    conviction: conviction * 0.1,
    newness: newness * 0.1,
  };
  const base = Object.values(components).reduce((a, b) => a + b, 0);

  let penalty = 1;
  // Near-copy family, scaled by how industrial it is — but only to the extent
  // the family behaves like one. Size says how many; churn says whether they
  // were meant to last. A family that has closed nothing pays nothing however
  // large it is (LayerZero's oft: 46 deploys, 0 closed, 20 verified), while one
  // that buries its own pays the full rate (smart_arb: 26 deploys, 24 closed).
  //   full rate: 2 members → ×0.59 · 5 → ×0.42 · 15 → ×0.30 · 50 → ×0.23
  // Not gated on bucketId: that was a leftover from when the bucket was the
  // only family we could see, and it let the worst case through — a program
  // that recompiles enough to land in NO bucket kept a clean ×1 while its
  // crate said six siblings (profit_guard, scored 0.1646 on a family of 6).
  const familyChurn =
    family.size >= 2 ? Math.max(0, Math.min(1, family.closed / (family.size - 1))) : 0;
  if (family.size >= 2) {
    const full = 1 / (1 + Math.log2(family.size));
    penalty = 1 - familyChurn * (1 - full);
  }
  if (row.noveltyBand === "clone") penalty = Math.min(penalty, 0.2);
  if (facts.closedAt) penalty = Math.min(penalty, 0.05);
  const isSniper =
    row.noveltyBand === "clone" && (row.profile?.integrations ?? []).includes("Pump.fun");
  if (isSniper) penalty = Math.min(penalty, 0.05);

  // size prior (measured 2026-07-13, ROADMAP §4): confident bots cluster hard
  // under 50KB (77%, template spike at 32,377 bytes) while named programs
  // almost never live there (2%). A discount — never a gate — on small
  // ANONYMOUS code only; a recovered name clears it, and Pinocchio/native are
  // exempt because tiny is idiomatic there (the 22–71KB real programs).
  const fw = row.profile?.framework;
  let sizePrior = 1;
  if (!row.name && row.sizeBytes != null && fw !== "pinocchio" && fw !== "native") {
    if (row.sizeBytes < 25_600) sizePrior = 0.55;
    else if (row.sizeBytes < 51_200) sizePrior = 0.7;
    else if (row.sizeBytes < 102_400) sizePrior = 0.85;
  }

  return {
    score: Math.round(base * penalty * sizePrior * 10_000) / 10_000,
    components,
    penalty,
    sizePrior,
    familySize: family.size,
    familyBasis: family.basis,
    familyChurn: Math.round(familyChurn * 1000) / 1000,
    computedAt: new Date().toISOString(),
  };
}

/** The programs sharing this one's SOURCE — same crate, with path evidence
 *  (a shared crate name alone proves nothing; isSourceRelative decides).
 *
 *  The bytecode bucket is a weak proxy for family. A factory that recompiles
 *  between deploys lands in a fresh, tiny bucket every time and collects only
 *  the mild 2-member discount: smart_arb ran 20 program ids through 11 buckets
 *  in 16 days, each new id taking the top of the radar on the strength of its
 *  bot traffic while its 19 siblings sat closed. The crate and its file tree
 *  survive the recompile, so they see the family the bucket can't. */
async function sourceFamily(row: SubjectRow): Promise<Family> {
  if (!row.crate) return { size: 1, closed: 0, basis: "none" };
  const candidates = await db
    .select({
      crate: schema.subjects.crate,
      sourcePaths: schema.subjects.sourcePaths,
      closedAt: sql<string | null>`${schema.subjects.facts} ->> 'closedAt'`,
    })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, row.network),
        eq(schema.subjects.crate, row.crate),
        ne(schema.subjects.id, row.id),
      ),
    )
    .limit(500);
  const mine = row.sourcePaths ?? [];
  let size = 1; // this program
  let closed = 0;
  for (const c of candidates) {
    const theirs = c.sourcePaths ?? [];
    const shared = sharedPathCount(mine, theirs);
    if (!isSourceRelative(row.crate, c.crate, shared, pathOverlap(mine, theirs))) continue;
    // isSourceRelative clears a pair on overlap alone, which is right for
    // *showing* lineage — one file out of a two-file tree is a lead worth a
    // link. It is not enough to halve a score: arb_router lost half of its on
    // a single shared path. Charging money needs a second file.
    if (shared < 2) continue;
    size += 1;
    if (c.closedAt) closed += 1;
  }
  return { size, closed, basis: size > 1 ? "source" : "none" };
}

/** The copy bucket, and how many of its members have been closed. Size stays
 *  the bucket's own counter (what the discount has always used); the closed
 *  count comes from the rows themselves. */
async function bucketFamily(row: SubjectRow): Promise<Family> {
  if (!row.bucketId) return { size: 1, closed: 0, basis: "none" };
  const [bucket] = await db
    .select({ n: schema.copyBuckets.memberCount })
    .from(schema.copyBuckets)
    .where(eq(schema.copyBuckets.id, row.bucketId));
  const [agg] = await db
    .select({
      closed: sql<number>`count(*) filter (where ${schema.subjects.facts} ->> 'closedAt' is not null)`,
    })
    .from(schema.subjects)
    .where(and(eq(schema.subjects.bucketId, row.bucketId), ne(schema.subjects.id, row.id)));
  const size = bucket?.n ?? 1;
  return { size, closed: Number(agg?.closed ?? 0), basis: size > 1 ? "bucket" : "none" };
}

/** Recompute a program's interest score (index column + facts).
 *  `persist: false` computes without writing — for previewing a scorer change. */
export async function refreshInterest(
  programId: string,
  opts: { persist?: boolean } = {},
): Promise<Interest | null> {
  const rows = await db.select().from(schema.subjects).where(eq(schema.subjects.id, programId));
  const row = rows[0];
  if (!row) return null;
  // whichever family is bigger is the honest one — a recompile hides from the
  // bucket, a rename hides from the crate, and neither should buy a clean slate
  const [bucket, source] = await Promise.all([bucketFamily(row), sourceFamily(row)]);
  const family = source.size > bucket.size ? source : bucket;
  const interest = computeInterest(row, family);
  if (opts.persist === false) return interest;
  await db
    .update(schema.subjects)
    .set({
      noveltyScore: interest.score,
      facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({ interest })}::jsonb`,
    })
    .where(eq(schema.subjects.id, programId));
  return interest;
}
