import { eq, sql } from "drizzle-orm";
import { db, schema } from "@onrecord/core";

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
//   momentum   .30  log₁₀ txns in last 24h (10k caps)
//   adoption   .15  fraction of the last 48 hours with ≥1 txn (sustained ≠ spike)
//   novelty    .20  structural distance to nearest known code
//   disclosure .15  name/repo/site/IDL/security.txt/verified, of 6
//   conviction .10  log₁₀ SOL locked by the deploy (100 SOL caps)
//   newness    .10  e^(−age in days) — fresh deploys surface, then must earn it
//
//   × 0.05 closed (rent reclaimed — the churn tail)
//   × 0.20 byte-clone (recycled code; sniper-flavored clones × 0.05)
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
  computedAt: string;
}

export function computeInterest(row: SubjectRow, familySize = 1): Interest {
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

  const deployedMs = (row.firstDeployAt ?? row.firstSeenAt)?.getTime() ?? now;
  const ageDays = Math.max(0, (now - deployedMs) / 86_400_000);
  const newness = Math.exp(-ageDays);

  const components = {
    momentum: momentum * 0.3,
    adoption: adoption * 0.15,
    novelty: novelty * 0.2,
    disclosure: disclosure * 0.15,
    conviction: conviction * 0.1,
    newness: newness * 0.1,
  };
  const base = Object.values(components).reduce((a, b) => a + b, 0);

  let penalty = 1;
  // near-copy family, scaled by how industrial it is: a 2-member family reads
  // as a fork (mild discount, other signals can carry it); a 15-a-day family
  // is a factory regardless of whether today's instance is still alive.
  //   2 members → ×0.59 · 5 → ×0.42 · 15 → ×0.30 · 50 → ×0.23
  if (row.bucketId && familySize >= 2) penalty = 1 / (1 + Math.log2(familySize));
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
    computedAt: new Date().toISOString(),
  };
}

/** Recompute and persist a program's interest score (index column + facts). */
export async function refreshInterest(programId: string): Promise<Interest | null> {
  const rows = await db.select().from(schema.subjects).where(eq(schema.subjects.id, programId));
  const row = rows[0];
  if (!row) return null;
  let familySize = 1;
  if (row.bucketId) {
    const bucket = await db
      .select({ n: schema.copyBuckets.memberCount })
      .from(schema.copyBuckets)
      .where(eq(schema.copyBuckets.id, row.bucketId));
    familySize = bucket[0]?.n ?? 1;
  }
  const interest = computeInterest(row, familySize);
  await db
    .update(schema.subjects)
    .set({
      noveltyScore: interest.score,
      facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({ interest })}::jsonb`,
    })
    .where(eq(schema.subjects.id, programId));
  return interest;
}
