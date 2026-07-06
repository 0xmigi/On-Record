// ---------------------------------------------------------------------------
// Shared domain types. The API returns these shapes verbatim — the website is
// just one consumer (spec §2), so treat them as the public contract.
// ---------------------------------------------------------------------------

export type Network = "mainnet" | "devnet";

export type ChainEventType = "deploy" | "upgrade" | "set_authority" | "close";

export type StoryType =
  | "update"
  | "launch"
  | "radar"
  | "became_real"
  | "corroboration"
  | "control_change"
  | "copy_wave";

export type AuthorityClass = "none" | "squads" | "program" | "hot_wallet";

export type StoryStatus = "published" | "killed" | "pinned" | "dead_letter";

/** A receipt is a pointer at the chain (or a repo) that proves a fact. */
export interface Receipt {
  kind: "tx" | "account" | "repo";
  ref: string;
}

export interface StoryFact {
  text: string;
  receipt: Receipt;
}

export interface StoryInference {
  text: string;
  confidence: "low" | "med" | "high";
}

/** What the writer LLM must produce — structured, never prose (spec §4.5). */
export interface StoryDraft {
  type: StoryType;
  headline: string; // ≤ 90 chars
  body: string; // ≤ 280 chars target, 320 hard limit, plain language
  facts: StoryFact[];
  inference: StoryInference | null;
  subjects: string[]; // programIds or entity ids
}

// ---------------------------------------------------------------------------
// Event enrichment — accumulated by pipeline stages inside events.enrichment
// ---------------------------------------------------------------------------

export interface Fingerprint {
  sha256: string;
  tlsh: string | null;
  sizeBytes: number;
  idl: { instructions: string[]; accounts: string[] } | null;
  strings: string[];
}

export interface Identity {
  entityId: string | null;
  entityName: string | null;
  verified: boolean;
  repoUrl: string | null;
  repoCommit: string | null;
  previousCommit: string | null;
  authorityClass: AuthorityClass | null;
  tvl: number | null;
}

export interface Classification {
  disposition: "copy" | "near_copy" | "novel" | "data_only";
  bucketId: string | null;
  nearestDistance: number | null;
  noveltyScore: number; // clamp((minDist − NOVEL_THRESHOLD) / 300, 0, 1)
  watchlistHit: { watchlistId: string; matchedOn: "sha256" | "tlsh" | "authority" } | null;
}

export interface RankResult {
  score: number;
  storyType: StoryType | null; // null = stays data
  components: Record<string, number>;
}

export interface EventEnrichment {
  fingerprint?: Fingerprint;
  identity?: Identity;
  classification?: Classification;
  rank?: RankResult;
  skippedSpamWave?: boolean;
  diffSummary?: string; // verified updates: truncated code diff summary
  announcementUrl?: string; // corroboration lever input
  error?: string;
}

// ---------------------------------------------------------------------------
// Runtime config (config table) with defaults from spec §7 / §11
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  CLONE_THRESHOLD: number;
  NOVEL_THRESHOLD: number;
  MAJOR_VALUE_MIN: number;
  DAILY_STORY_BUDGET: number;
  DEVNET_MAX_REDEPLOYS_PER_DAY: number;
  WATCHLIST_TTL_DAYS: number;
  MONTHLY_TOKEN_CAP: number;
  toneNotes: string;
  rankWeights: {
    valueHeld: number;
    verified: number;
    novelty: number;
    authorityRisk: number;
    watchlistHit: number;
    entityKnown: number;
    copyWaveVelocity: number;
  };
  perTypeFloors: Partial<Record<StoryType, number>>;
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  CLONE_THRESHOLD: 50,
  NOVEL_THRESHOLD: 150,
  MAJOR_VALUE_MIN: 10_000_000,
  DAILY_STORY_BUDGET: 15,
  DEVNET_MAX_REDEPLOYS_PER_DAY: 10,
  WATCHLIST_TTL_DAYS: 60,
  MONTHLY_TOKEN_CAP: 20_000_000,
  toneNotes: "",
  rankWeights: {
    valueHeld: 1.0,
    verified: 0.5,
    novelty: 1.0,
    authorityRisk: 1.2,
    watchlistHit: 1.5,
    entityKnown: 0.8,
    copyWaveVelocity: 0.6,
  },
  perTypeFloors: { radar: 1 },
};

// ---------------------------------------------------------------------------
// Public API response shapes (spec §2)
// ---------------------------------------------------------------------------

export interface ApiStory {
  id: string;
  type: StoryType;
  headline: string;
  body: string;
  facts: StoryFact[];
  inference: StoryInference | null;
  subjects: { id: string; name: string | null }[];
  status: StoryStatus;
  pinned: boolean;
  publishedAt: string; // ISO
}

export interface ApiStoryDetail extends ApiStory {
  events: ApiRawEvent[];
}

export interface ApiRawEvent {
  id: string;
  network: Network;
  type: ChainEventType;
  signature: string;
  slot: number;
  blockTime: string | null;
  programId: string;
  authorityBefore: string | null;
  authorityAfter: string | null;
  sha256After: string | null;
  enrichment: EventEnrichment;
}

export interface ApiSubject {
  id: string;
  kind: "program" | "entity";
  name: string | null;
  network: Network;
  verified: boolean;
  repoUrl: string | null;
  authorityClass: AuthorityClass | null;
  tvl: number | null;
  noveltyScore: number | null;
  bucketId: string | null;
  stories: ApiStory[];
}

export interface ApiDigest {
  date: string;
  stories: ApiStory[];
  counts: Record<string, number>;
}

export interface ApiCursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiWatchlistItem {
  id: string;
  kind: "fingerprint" | "authority";
  programId: string | null;
  authority: string | null;
  source: "devnet_novel" | "manual";
  note: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  deployCount: number;
  expiresAt: string;
  status: "active" | "matched" | "expired";
}

export interface ApiStats {
  launchesToday: number;
  updatesToday: number;
  copyPercentToday: number;
  radarThisWeek: number;
}
