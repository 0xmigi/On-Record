import type { NearestWeakness } from "./lineage.js";

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
/** What a program does, derived from its own instruction surface (categorize.ts).
 *
 *  Six buckets used to do this job and 83% of everything landed in `defi` —
 *  true, and useless as a filter. These are the distinctions the evidence can
 *  actually carry: each one has instruction vocabulary that separates it.
 *
 *  Deliberately absent: behavioural labels (arb bot, sniper, trading bot). Those
 *  are read off transaction patterns, not code — the radar's clone band and the
 *  Pump.fun integration chip already carry that signal, and a category claiming
 *  it from bytecode would be a guess. */
export type Category =
  | "dex"
  | "perps"
  | "lending"
  | "staking"
  | "launchpad"
  | "bridge"
  | "oracle"
  | "nft"
  | "governance"
  | "airdrop"
  | "token"
  | "infra"
  /** finance-shaped, but nothing more specific survived the evidence */
  | "defi"
  | "unknown";

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
  /** the registry's own category string for this entity (labels.yaml), before
   *  it is mapped onto Category. Absent on events enriched before this existed. */
  entityCategory?: string | null;
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
  /** public repo found by searching code for the program id — an inference,
   *  not a verified build. Absent on events enriched before this existed. */
  repoLink?: RepoLink | null;
}

/** A source repo recovered by searching public code for the program id.
 *  Distinct from `Identity.repoUrl`, which comes from the verified-builds
 *  registry and is proof; this is a search hit with its evidence attached. */
export interface RepoLink {
  /** owner/name */
  repo: string;
  repoUrl: string;
  /** declared = the repo compiles to this address (declare_id! / Anchor.toml);
   *  crate-path = the repo carries the same crate path the binary leaked */
  method: "declared" | "crate-path";
  /** both directions closed: binary leaked programs/<crate>/, repo has it too */
  crateConfirmed: boolean;
  /** repo files containing the program id, capped for storage */
  matchedPaths: string[];
  /** files matched in this repo (before the path cap) */
  matchCount: number;
  /** other repos that also survived the link test — copies, renames, hard
   *  forks. >0 means "this one, of N that could claim it", not "the only one". */
  otherCandidates: number;
  queriedAt: string;
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
  /** distinct programs within 5 similarity points of the nearest — a crowd (high
   *  count) means the match is generic framework shape, not a specific relative */
  nearestPeersWithin5: number;
  /** 2nd-nearest distinct program's distance — the gap that says "standout" */
  nearestRunnerUpDistance: number | null;
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
  /** crate directory from the leaked panic path (`programs/<crate>/src/…`) —
   *  `name` may be a security.txt label instead. Absent on older enrichments. */
  crate?: string | null;
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
  deploy?: {
    firstDeployAt: string | null;
    deployType: "deploy" | "upgrade";
    upgradeCount: number;
    /** upgradeCount hit the history page cap — it is a floor, render "N+" */
    upgradeCountTruncated?: boolean;
  };
  identity?: Identity;
  classification?: Classification;
  score?: ScoreResult;
  skippedSpamWave?: boolean;
  /** This event carries no real chain timestamp and must not be dated.
   *
   *  Set only by the landmark seeder for immutable loader-v1/v2 programs: they
   *  have no ProgramData history, and their deploy slot is not cheaply
   *  recoverable (walking a program account's signatures back to genesis is
   *  billions of pages for SPL Token). Stamping `now` would put programs from
   *  2020 at the top of the 24h radar, so they stay undated instead — indexed,
   *  searchable, and in the fingerprint corpus, but out of every dated stream.
   *  The radar already excludes undated rows from `sort=recent` by design. */
  undated?: boolean;
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
  /** crate the binary leaked — the source family, which survives the
   *  recompiles that push each redeploy into its own copy bucket */
  crate: string | null;
  clusterSize: number | null;
  // --- program profile (docs/GRADING.md §5): from the SBF bytecode ---
  framework: Framework | null;
  capabilities: string[];
  integrations: string[];
  syscallCount: number | null;
  // --- recovered identity (de-opaquing) ---
  /** A repo somebody declared AND that answered when we last asked. Null once
   *  the liveness sweep finds it gone — see repoUrlDeclared. */
  repoUrl: string | null;
  /** The declared repo when it 404s. Kept, because publishing a source pointer
   *  on chain that then breaks is itself a fact about the project — but served
   *  under a name no consumer will render as a working link or score as
   *  disclosure (apps/ingest/src/repo-link.ts). */
  repoUrlDeclared: string | null;
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
  /** upgradeCount is a floor (history page cap hit) — render as "N+" */
  upgradeCountTruncated: boolean;
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
  /** the same program address on the OTHER cluster, probed directly.
   *  null = never probed (unknown), which is NOT the same as probed-and-absent
   *  (`present: false`). See ApiCounterpart. */
  counterpart: ApiCounterpart | null;
  /** Squads governance decoded from the deploy tx ("2-of-3") */
  multisig: ApiMultisig | null;
  // --- momentum: sampled on-chain activity (methodology v0) ---
  /** hourly tx-count buckets, oldest→newest (radar: last 48h; detail: 7d) */
  activity: ApiActivityPoint[] | null;
  momentum: {
    txns24h: number;
    growth: number | null;
    /** txns24h is a floor — the sampler's page cap was hit that run */
    txns24hTruncated?: boolean;
  } | null;
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
  devnetIterations: number; // devnet deploys BEFORE the mainnet debut (pre-launch effort)
  devnetDeploysTotal?: number; // lifetime devnet deploys (incl. post-launch staging)
  lastDevnetAt?: string | null; // ISO — last devnet deploy/upgrade (ongoing-activity signal)
  // how the mainnet program was tied to devnet: bytecode (sha256/tlsh),
  // upgrade authority, or the same program address on both clusters
  matchedOn: "sha256" | "tlsh" | "authority" | "program_id";
}

/** The same program address on the OTHER cluster, probed directly rather than
 *  inferred. Stored on subjects.facts by counterpart.ts.
 *
 *  Why this exists: subjects.id is the program address alone, so a program
 *  deployed to both clusters is ONE row and `network` is whichever cluster
 *  wrote last. That made a `DEVNET` badge read as "this is a devnet program"
 *  when it only ever meant "the last loader event we saw was on devnet" — 106
 *  of 6,573 devnet rows (1.6%) are live on mainnet right now, and said nothing
 *  about it. `incubation` cannot cover this: it is computed on a mainnet event,
 *  so a program we have only ever seen on devnet never triggers it.
 *
 *  `present: false` is a real answer (probed, not there). A null counterpart is
 *  the unknown. Absent, zero and unknown stay distinct. */
export interface ApiCounterpart {
  /** the cluster this describes — always the opposite of the subject's own */
  network: Network;
  /** does an executable program account exist at this address there */
  present: boolean;
  /** ProgramData is a live image, not a husk left by a close. Null when the
   *  program is absent, or immutable (loader v1/v2 has no ProgramData). */
  alive: boolean | null;
  /** ProgramData length there — differs from ours whenever the two clusters
   *  are running different builds, which is the point of showing it */
  sizeBytes: number | null;
  /** last deploy slot on that cluster, from the ProgramData header */
  deployedSlot: number | null;
  /** ISO time of that slot, when it could be resolved */
  deployedAt: string | null;
  /** upgrade authority THERE. The one that matters: devnet routinely runs a
   *  hot key while mainnet sits behind a multisig, and reporting the devnet
   *  authority as if it governed the money is the worst error available. */
  authority: string | null;
  authorityClass: AuthorityClass | null;
  /** ISO — when this probe ran. Presence is a fact with a timestamp. */
  checkedAt: string;
}

/** Nearest bytecode relative, resolved for display (SPEC §7). */
export interface ApiNearest {
  id: string | null; // program id of the relative (null if it left the corpus)
  name: string | null;
  similarity: number; // 0..1, from TLSH distance
  isReference: boolean; // true = registry/verified protocol, false = a peer deploy
  deployedAt: string | null; // neighbor's first deploy (ISO) — for before/after-this direction
  /** ISO — when this relative's ProgramData was closed, null while it is still
   *  open. Lineage prints it: an unmarked row reads as a live sibling, and a
   *  99%-identical program that was gutted hours after deploy is a different
   *  fact entirely. */
  closedAt: string | null;
  /** distinct programs within 5 similarity points of this match — high = the match
   *  is generic framework shape (a crowd), not a specific relative */
  peersWithin5: number | null;
  /** Set when this match must not be read as a specific relative — the score is
   *  measuring generic shape. "crowd": many programs are equally close.
   *  "size": the two binaries are too far apart in size to share a body of code.
   *  Callers must not name a weak match as a fork or a source (lineage.ts). */
  weak: NearestWeakness | null;
  /** 2nd-nearest program's similarity (0..1) — the gap that marks a standout */
  runnerUpSimilarity: number | null;
}

export interface ApiProgramDetail extends ApiProgram {
  repoUrl: string | null;
  authority: string | null;
  sha256: string | null;
  events: ApiRawEvent[];
  neighbors: { programId: string; distance: number; name: string | null }[];
  idlInstructions: string[];
  strings: string[];
  /** sol_* syscall imports read off the ELF — the evidence behind capabilities */
  syscalls: string[];
  /** which ELF shape the syscalls came from: dynamic imports (SBPFv1), hashed
   *  static call immediates (SBPFv2+), or a last-resort string scan */
  syscallSource: "dynsym" | "static" | "strings" | null;
  /** handler names recovered from the binary — the interface surface for the
   *  majority of programs, which never publish an IDL */
  instructionNames: string[];
  instructionSource: "idl" | "anchor-log" | "debug-enum" | null;
  /** the developer's embedded security.txt, verbatim fields */
  securityTxt: SecurityTxt | null;
  /** repo found by searching public code for the program id — an inference,
   *  shown apart from `repoUrl`, which somebody declared */
  repoLink: RepoLink | null;
  /** transactions-per-minute readings, one per sampler tick. Unlike `activity`
   *  counts these do not saturate on a busy program (momentum.ts). */
  rate: { t: number; r: number }[] | null;
  /** Compute burned by transactions that touch this program: the median and the
   *  middle 80% of a sample, against the 1,400,000 one transaction may use.
   *  TRANSACTION-level — a swap pays for every program it routes through — so
   *  it is never "what this program uses". `failed` is how many of the sampled
   *  transactions errored, which is free from the same call. */
  compute: {
    median: number;
    p10: number;
    p90: number;
    /** the heaviest call in the sample */
    max: number;
    /** share of calls under 2,000 CU — bookkeeping rather than work */
    cheapShare: number;
    /** median compute REQUESTED — the number SGP-0003's resource fee prices */
    requestedMedian: number | null;
    /** median consumed ÷ requested, 0–1 */
    utilisation: number | null;
    /** sampled transactions that set no compute limit */
    noLimit: number;
    n: number;
    failed: number;
    sampledAt: string;
  } | null;
  /** programs compiled from the same crate — the fork signal TLSH misses.
   *  Ranked by how much of the source tree they literally share. */
  sourceKin: {
    programId: string;
    name: string | null;
    crate: string;
    sharedFiles: number;
    overlap: number; // 0..1 jaccard over recovered .rs paths
    deployedAt: string | null;
    /** ISO close time, null while open — see ApiNearest.closedAt */
    closedAt: string | null;
  }[];
  /** Measured bytecode similarity (0..1) to each program lineage lists —
   *  bucket siblings, source relatives, the nearest match. Same TLSH span the
   *  novelty score uses. Absent for a relative outside the size window, which
   *  the UI must render as "not measured" rather than as zero. */
  similarityTo: Record<string, number>;
  /** the reference graph: program ids embedded in this image, and the ones
   *  that embed it. `namedBy` is the more telling direction — who reaches for
   *  this program says more about its place than its own import list does.
   *  A reference is not proof of a call; see core/references.ts. */
  references: {
    names: ApiEdgeNode[];
    namedBy: ApiEdgeNode[];
  };
}

/** One end of a reference edge. `txns24h` and `activity` are the NEIGHBOUR'S
 *  OWN traffic, never traffic over the edge — a vault doing 7,783 txns/day
 *  beside an arrow into klend would read as 7,783 flowing into klend, and
 *  almost none of it does. Per-edge flow needs inner instructions from parsed
 *  transactions; every surface that renders these says whose number it is.
 *  `txnsTruncated` = the momentum sampler hit its page cap, so the count is a
 *  floor and the series plateaus at a ceiling it never really reached. */
export interface ApiEdgeNode {
  id: string;
  name: string | null;
  crate: string | null;
  txns24h: number | null;
  txnsTruncated: boolean;
  activity: { t: number; c: number }[] | null;
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
  volume?: { t: number; count: number }[]; // 30-day hourly deploy/upgrade volume, this cluster
  /** the same 30-day series for BOTH clusters, so the chart can put mainnet and
   *  devnet volume side by side while the rest of the page stays single-cluster */
  volumeByNetwork?: Record<
    Network,
    { t: number; count: number; deploys: number; upgrades: number }[]
  >;
  /** ISO — when this cluster's record actually begins (first row written).
   *  Everything left of it is absent or backfilled, and undercounts. */
  recordStartsAt?: string | null;
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
    /** ISO close time — deployedAt→closedAt is how long the deploy lived,
     *  which is the whole story of a redeploy-and-gut family */
    closedAt: string | null;
  }[];
}

export interface ApiCursorPage<T> {
  items: T[];
  /** true row count for the whole slice (items caps at the page limit) */
  total?: number;
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
