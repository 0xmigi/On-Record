// ---------------------------------------------------------------------------
// Shared domain types. The API returns these shapes verbatim — the website is
// just one consumer (SPEC §7), so treat them as the public contract.
//
// v2 (the radar): no stories, no LLM prose. The pipeline turns loader events
// into scored, deduped, categorized *programs*. Fact only.
// ---------------------------------------------------------------------------

import type { Framework, ProgramProfile } from "./profile.js";

export type Network = "mainnet" | "devnet";

export type ChainEventType = "deploy" | "upgrade" | "set_authority" | "close";

export type AuthorityClass = "none" | "squads" | "program" | "hot_wallet";

/** Novelty band, from the dedup gate (SPEC §2). */
export type NoveltyBand = "clone" | "variant" | "novel";

/** Rule-based category tag (SPEC §4). `unknown` is honest, not a failure. */
export type Category = "defi" | "token" | "nft" | "infra" | "governance" | "unknown";

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
  /** raw disposition from the corpus scan */
  disposition: "copy" | "near_copy" | "novel" | "data_only";
  /** collapsed 3-way band shown on the radar */
  band: NoveltyBand;
  bucketId: string | null;
  nearestDistance: number | null;
  /** structural novelty from bytecode distance: clamp((minDist − NOVEL) / 300, 0, 1) */
  structuralNovelty: number;
  watchlistHit: { watchlistId: string; matchedOn: "sha256" | "tlsh" | "authority" } | null;
}

/** Deployer funding trail — where the deploy authority's SOL came from. */
export type FundingSource =
  | "cex" // funded from a known exchange
  | "bridge" // bridged in
  | "known_multisig"
  | "fresh" // freshly funded wallet, single hop, no known source
  | "unknown";

/** Composite novelty score + its inputs (SPEC §2). Written by the score stage. */
export interface ScoreResult {
  score: number; // 0..1 composite
  category: Category;
  instructionCount: number | null;
  idlPresent: boolean;
  fundingSource: FundingSource | null;
  earlySigners: number | null;
  components: Record<string, number>;
}

export interface EventEnrichment {
  fingerprint?: Fingerprint;
  profile?: ProgramProfile;
  identity?: Identity;
  classification?: Classification;
  score?: ScoreResult;
  skippedSpamWave?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Runtime config (config table) with defaults from SPEC §2
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  /** TLSH distance below which a deploy is a near-copy (variant) of a neighbor */
  CLONE_THRESHOLD: number;
  /** TLSH distance at/above which a deploy counts as novel */
  NOVEL_THRESHOLD: number;
  DEVNET_MAX_REDEPLOYS_PER_DAY: number;
  WATCHLIST_TTL_DAYS: number;
  /** how many hours after deploy still counts as "early" usage */
  EARLY_USAGE_WINDOW_HOURS: number;
  /** weights for the composite novelty score */
  noveltyWeights: {
    structural: number; // bytecode uniqueness
    instructionSurface: number; // IDL/ELF instruction count
    fundingTrail: number; // credible deployer funding
    authority: number; // multisig / immutable
    earlyUsage: number; // unique signers early
    verified: number; // open-source boost
  };
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  CLONE_THRESHOLD: 50,
  NOVEL_THRESHOLD: 150,
  DEVNET_MAX_REDEPLOYS_PER_DAY: 10,
  WATCHLIST_TTL_DAYS: 60,
  EARLY_USAGE_WINDOW_HOURS: 24,
  noveltyWeights: {
    structural: 1.0,
    instructionSurface: 0.7,
    fundingTrail: 0.6,
    authority: 0.5,
    earlyUsage: 0.6,
    verified: 0.5,
  },
};

// ---------------------------------------------------------------------------
// Public API response shapes (SPEC §7)
// ---------------------------------------------------------------------------

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
}

/** A radar row / program summary. */
export interface ApiProgram {
  id: string; // programId
  network: Network;
  name: string | null;
  deployedSlot: number | null;
  deployedAt: string | null; // ISO
  lastEventAt: string | null; // ISO
  band: NoveltyBand;
  noveltyScore: number; // 0..1
  category: Category;
  sizeBytes: number | null;
  instructionCount: number | null;
  idlPresent: boolean;
  authorityClass: AuthorityClass | null;
  deployerFundingSource: string | null;
  earlySigners: number | null;
  verified: boolean;
  bucketId: string | null;
  clusterSize: number | null;
  // --- program profile (docs/GRADING.md §5): from the SBF bytecode ---
  framework: Framework | null;
  capabilities: string[];
  integrations: string[];
  syscallCount: number | null;
}

export interface ApiProgramDetail extends ApiProgram {
  repoUrl: string | null;
  authority: string | null;
  sha256: string | null;
  events: ApiRawEvent[];
  neighbors: { programId: string; distance: number; name: string | null }[];
  idlInstructions: string[];
  strings: string[];
}

export interface ApiFunnel {
  date: string; // YYYY-MM-DD
  raw: number; // total deploy + upgrade events
  unique: number; // unique bytecode (Y)
  novel: number; // Z
  clones: number;
  variants: number;
  byCategory: Record<string, number>; // among novel
  updatedAt: string; // ISO
}

export interface ApiCluster {
  id: string;
  label: string | null;
  canonicalSha256: string;
  memberCount: number;
  velocity6h: number;
  members: { programId: string; deployedAt: string | null }[];
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
