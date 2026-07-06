import { and, eq, gte } from "drizzle-orm";
import {
  db,
  schema,
  getConfig,
  type ChainEventType,
  type EventEnrichment,
  type RankResult,
  type StoryType,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// Rank stage (spec §4.4): a deterministic score decides what becomes a story
// at all. No LLM here — weights live in the config table.
// ---------------------------------------------------------------------------

export interface RankInput {
  eventType: ChainEventType;
  enrichment: EventEnrichment;
  copyWaveVelocity6h?: number; // set when evaluating a bucket, not an event
  isCopyWaveCheck?: boolean;
  hasAnnouncement?: boolean;
}

export async function rankEvent(input: RankInput): Promise<RankResult> {
  const cfg = await getConfig();
  const w = cfg.rankWeights;
  const identity = input.enrichment.identity;
  const cls = input.enrichment.classification;

  const tvl = identity?.tvl ?? 0;
  // log-scaled value: $10M (MAJOR_VALUE_MIN default) ≈ 0.7, $1B ≈ 0.9
  const valueHeld = tvl > 0 ? Math.min(1, Math.log10(tvl) / 10) : 0;
  const verified = identity?.verified ? 1 : 0;
  const novelty = cls?.noveltyScore ?? 0;
  const entityKnown = identity?.entityId ? 1 : 0;
  const watchlistHit = cls?.watchlistHit ? 1 : 0;
  const copyVelocity = Math.min(1, (input.copyWaveVelocity6h ?? 0) / 30);

  // authority risk: control of value moved onto/off a single key, or frozen
  let authorityRisk = 0;
  if (input.eventType === "set_authority") {
    authorityRisk = 0.4;
    if (identity?.authorityClass === "hot_wallet") authorityRisk = 0.8;
    if (identity?.authorityClass === "none") authorityRisk = 0.7; // freezing is news
    if (tvl >= cfg.MAJOR_VALUE_MIN) authorityRisk = 1;
  }

  const components = {
    valueHeld: valueHeld * w.valueHeld,
    verified: verified * w.verified,
    novelty: novelty * w.novelty,
    authorityRisk: authorityRisk * w.authorityRisk,
    watchlistHit: watchlistHit * w.watchlistHit,
    entityKnown: entityKnown * w.entityKnown,
    copyWaveVelocity: copyVelocity * w.copyWaveVelocity,
  };
  const score = Object.values(components).reduce((a, b) => a + b, 0);

  return { score, storyType: pickStoryType(input, entityKnown === 1), components };
}

function pickStoryType(input: RankInput, entityKnown: boolean): StoryType | null {
  const cls = input.enrichment.classification;

  if (input.hasAnnouncement) return "corroboration";
  if (input.isCopyWaveCheck) return "copy_wave";
  if (cls?.watchlistHit) return "became_real";

  // individual copies never get stories (spec §1.4)
  if (cls?.disposition === "copy" || cls?.disposition === "near_copy") return null;

  switch (input.eventType) {
    case "set_authority":
      return "control_change";
    case "deploy":
      if (entityKnown) return "launch";
      if (cls?.disposition === "novel") return "radar";
      return null;
    case "upgrade":
      // default per spec §11: unknown low-activity upgrades never rank
      return entityKnown ? "update" : null;
    case "close":
      return entityKnown ? "control_change" : null;
  }
}

/** Minimum score to become a story, per type. Radar has a low bar (Radar
 *  tolerates false positives); control changes need real risk behind them. */
const MIN_SCORE: Record<StoryType, number> = {
  update: 0.6,
  launch: 0.6,
  radar: 0.7,
  became_real: 0.5,
  corroboration: 0, // operator asked for it
  control_change: 0.8,
  copy_wave: 0.4,
};

export interface BudgetDecision {
  allowed: boolean;
  reason?: string;
}

/** Daily budget with per-type floors (spec §1.6, §4.4). Floors reserve room:
 *  e.g. there is always space for 1 radar/day if any qualify. */
export async function checkBudget(storyType: StoryType, score: number): Promise<BudgetDecision> {
  if (score < (MIN_SCORE[storyType] ?? 0.6)) return { allowed: false, reason: "below_min_score" };

  const cfg = await getConfig();
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const publishedToday = await db
    .select({ type: schema.stories.type })
    .from(schema.stories)
    .where(and(gte(schema.stories.createdAt, dayStart), eq(schema.stories.status, "published")));

  if (publishedToday.length < cfg.DAILY_STORY_BUDGET) return { allowed: true };

  const floor = cfg.perTypeFloors[storyType] ?? 0;
  const ofTypeToday = publishedToday.filter((s) => s.type === storyType).length;
  if (ofTypeToday < floor) return { allowed: true }; // floor slot still open
  return { allowed: false, reason: "daily_budget_exhausted" };
}
