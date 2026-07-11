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
  computedAt: string;
}

export function computeInterest(row: SubjectRow): Interest {
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
  // near-copy family: shares a copy-bucket with other deploys (the ×N churn —
  // same code family under fresh ids). Softer than the exact-clone discount:
  // a genuine fork lands here too, and its other signals can still carry it.
  if (row.bucketId) penalty = 0.5;
  if (row.noveltyBand === "clone") penalty = 0.2;
  if (facts.closedAt) penalty = Math.min(penalty, 0.05);
  const isSniper =
    row.noveltyBand === "clone" && (row.profile?.integrations ?? []).includes("Pump.fun");
  if (isSniper) penalty = Math.min(penalty, 0.05);

  return {
    score: Math.round(base * penalty * 10_000) / 10_000,
    components,
    penalty,
    computedAt: new Date().toISOString(),
  };
}

/** Recompute and persist a program's interest score (index column + facts). */
export async function refreshInterest(programId: string): Promise<Interest | null> {
  const rows = await db.select().from(schema.subjects).where(eq(schema.subjects.id, programId));
  const row = rows[0];
  if (!row) return null;
  const interest = computeInterest(row);
  await db
    .update(schema.subjects)
    .set({
      noveltyScore: interest.score,
      facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({ interest })}::jsonb`,
    })
    .where(eq(schema.subjects.id, programId));
  return interest;
}
