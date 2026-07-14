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
  /** full ProgramData account size (header + allocated bytecode incl. padding) —
   *  what the deployer's rent is actually locked against */
  programDataBytes?: number;
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
  /** this bytecode is byte-identical to a verified build of another program */
  codeMatch: ApiCodeMatch | null;
  /** decoded Squads multisig behind the upgrade authority, when governed */
  multisig: ApiMultisig | null;
}

/** Squads multisig decoded from the deploy/upgrade transaction. */
export interface ApiMultisig {
  address: string;
  version: "v4" | "v3";
  threshold: number | null; // null = detected but not decodable (v3 legacy)
  members: number | null;
}

/** Exact-bytecode match against the verified-builds registry (OtterSec
 *  resolve-hash): the deploy ships the same code as a known open-source
 *  program. A lookup, not an inference. */
export interface ApiCodeMatch {
  programId: string; // the original (verified) program
  repository: string;
  trusted: boolean;
}

export interface Classification {
  /** raw disposition from the corpus scan */
  disposition: "copy" | "near_copy" | "novel" | "data_only";
  /** collapsed 3-way band shown on the radar */
  band: NoveltyBand;
  bucketId: string | null;
  nearestDistance: number | null;
  /** the corpus program the fingerprint sits closest to (lineage anchor) */
  nearestProgramId: string | null;
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
  /** traced wallet that funded the deploy authority (conviction evidence) */
  funderAddress: string | null;
  /** lamports the authority received in its funding transaction */
  fundingLamports: number | null;
  earlySigners: number | null;
  components: Record<string, number>;
}

/** The developer's own security.txt declaration, embedded in the binary
 *  (Neodyme standard). Every value is the developer's words — zero inference. */
export interface SecurityTxt {
  name?: string;
  project_url?: string;
  contacts?: string;
  policy?: string;
  preferred_languages?: string;
  source_code?: string;
  source_revision?: string;
  source_release?: string;
  encryption?: string;
  auditors?: string;
  acknowledgements?: string;
  expiry?: string;
}

/** Identity recovered directly from the SBF bytecode (Rust panic paths, Neodyme
 *  security.txt, embedded URLs) — the de-opaquing edge (~half of anonymous programs). */
export interface BytecodeIdentity {
  name: string | null;
  repoUrl: string | null;
  social: string | null;
  website: string | null;
  hasSecurityTxt: boolean;
  /** the full parsed security.txt block, when the binary ships one */
  securityTxt: SecurityTxt | null;
  anchor: boolean;
}

export interface EventEnrichment {
  fingerprint?: Fingerprint;
  profile?: ProgramProfile;
  bytecodeIdentity?: BytecodeIdentity;
  /** on-chain metadata probe: where the IDL came from + PMP security seed */
  metadata?: {
    idlSource: "pmp" | "anchor-legacy" | null;
    security: Record<string, unknown> | null;
  };
  deploy?: { firstDeployAt: string | null; deployType: "deploy" | "upgrade"; upgradeCount: number };
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
  /** where the IDL was published: Program Metadata Program vs legacy anchor:idl */
  idlSource: "pmp" | "anchor-legacy" | null;
  /** developer-declared logo (PMP security seed) */
  logoUrl: string | null;
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
  // --- recovered identity (de-opaquing) ---
  repoUrl: string | null;
  social: string | null;
  website: string | null;
  hasSecurityTxt: boolean;
  // --- lifecycle: closed = ProgramData deallocated, rent reclaimed ---
  /** ISO detection time when the program's ProgramData was found gone (closed).
   *  We detect absence, not the close tx — an honest "detected closed". */
  closedAt: string | null;
  closed: boolean;
  // --- deploy vs upgrade (from ProgramData history) ---
  deployType: "deploy" | "upgrade";
  firstDeployAt: string | null; // ISO — the ORIGINAL deploy (deployedAt is the latest)
  upgradeCount: number; // times re-deployed after the original
  // --- conviction: the traced funding of the deploy authority ---
  funderAddress: string | null;
  fundingAmountSol: number | null;
  /** rent-exempt SOL locked by the deploy (Program + ProgramData accounts) */
  deployCostSol: number | null;
  // --- fuzzy lineage: nearest known program by bytecode similarity ---
  nearest: ApiNearest | null;
  /** exact lineage: byte-identical to a verified build of a known program */
  codeMatch: ApiCodeMatch | null;
  /** devnet→mainnet lineage: this program was seen incubating on devnet before
   *  its mainnet debut (fingerprint/authority match against the watchlist) */
  incubation: ApiIncubation | null;
  /** Squads governance decoded from the deploy tx ("2-of-3") */
  multisig: ApiMultisig | null;
  // --- momentum: sampled on-chain activity (methodology v0) ---
  /** hourly tx-count buckets, oldest→newest (radar: last 48h; detail: 7d) */
  activity: ApiActivityPoint[] | null;
  momentum: { txns24h: number; growth: number | null } | null;
  /** interest-rank breakdown (interest.ts) — drives the "why is this here"
   *  line; components are already weight-scaled contributions */
  interest: ApiInterest | null;
}

export interface ApiInterest {
  score: number;
  components: Record<string, number>;
  penalty: number;
  sizePrior?: number;
}

export interface ApiActivityPoint {
  t: number; // hour bucket, epoch ms
  c: number; // transactions observed in that hour
}

/** devnet→mainnet incubation link, stored on subjects.facts by the pipeline
 *  when a mainnet deploy matches a devnet watchlist sighting. */
export interface ApiIncubation {
  devnetProgramId: string | null; // the devnet program it was sighted as
  firstDevnetAt: string; // ISO — first devnet sighting
  incubationDays: number; // devnet→mainnet gap, days (0.1 precision)
  devnetIterations: number; // devnet deploy/upgrade count before debut
  matchedOn: "sha256" | "tlsh" | "authority";
}

/** Nearest bytecode relative, resolved for display (SPEC §7). */
export interface ApiNearest {
  id: string | null; // program id of the relative (null if it left the corpus)
  name: string | null;
  similarity: number; // 0..1, from TLSH distance
  isReference: boolean; // true = registry/verified protocol, false = a peer deploy
}

export interface ApiProgramDetail extends ApiProgram {
  repoUrl: string | null;
  authority: string | null;
  sha256: string | null;
  events: ApiRawEvent[];
  neighbors: { programId: string; distance: number; name: string | null }[];
  idlInstructions: string[];
  strings: string[];
  /** the developer's embedded security.txt, verbatim fields */
  securityTxt: SecurityTxt | null;
}

export interface ApiFunnel {
  date: string; // YYYY-MM-DD (the window's end day)
  raw: number; // total deploy + upgrade events in the window
  unique: number; // unique bytecode among new programs
  novel: number;
  clones: number;
  variants: number;
  deploys: number; // new program ids
  upgrades: number; // upgrades of existing programs
  windowHours?: number;
  aggregateWindowHours?: number;
  capped?: boolean;
  byCategory: Record<string, number>; // category -> count among new programs
  byFramework?: Record<string, number>;
  byIntegration?: Record<string, number>;
  byCapability?: Record<string, number>;
  volume?: { t: number; count: number }[]; // 30-day hourly deploy/upgrade volume
  identity?: { named: number; withRepo: number; opaque: number };
  lineage?: { novel: number; variant: number; fork: number };
  control?: { mutable: number; frozen: number; verified: number };
  conviction?: { knownEntity: number; funderTraced: number; untraced: number };
  /** throwaway bots — new deploys that are byte-clones of known code (same
   *  program, fresh id: the sniper signature). `pumpfun` = the Pump.fun subset;
   *  `closed` = deploys already closed (rent reclaimed) in the window. */
  churn?: { redeploys: number; pumpfun: number; closed: number };
  frameworkTrend?: {
    framework: string;
    current: number;
    earlyShare: number;
    lateShare: number;
    delta: number;
  }[];
  updatedAt: string; // ISO
}

export interface ApiCluster {
  id: string;
  label: string | null;
  canonicalSha256: string;
  memberCount: number;
  velocity6h: number;
  members: {
    programId: string;
    name: string | null;
    deployedAt: string | null;
    closed: boolean;
  }[];
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
