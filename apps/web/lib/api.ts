// Typed fetch helpers for the On Record backend API.
// Every helper catches network/parse failures and returns a safe empty
// fallback so pages render a designed empty state instead of crashing.

const API_BASE = process.env.API_URL ?? "http://localhost:3001";
// a production build with no API_URL would silently render an empty site
// against localhost — fail loudly instead (surfaces via the error boundary)
const API_MISCONFIGURED = !process.env.API_URL && process.env.NODE_ENV === "production";

export type Network = "mainnet" | "devnet";
export type Band = "clone" | "variant" | "novel";
// Mirrors the backend Category enum (packages/enrich categorize.ts) — only add
// values here once the classifier can actually produce them.
export type Category =
  | "defi"
  | "token"
  | "nft"
  | "infra"
  | "governance"
  | "unknown";
export type AuthorityClass = "none" | "squads" | "program" | "hot_wallet" | null;
export type Framework = "anchor" | "pinocchio" | "native" | "unknown";

export type RadarWindow = "today" | "week" | "month" | "all";
export type RadarType = "deploy" | "upgrade";

/** A radar row / program summary. */
export interface ApiProgram {
  id: string; // programId (base58)
  network: Network;
  name: string | null; // set only if identified
  deployedSlot: number | null;
  deployedAt: string | null; // ISO
  lastEventAt: string | null; // ISO
  band: Band;
  noveltyScore: number; // 0..1
  category: Category;
  sizeBytes: number | null;
  instructionCount: number | null;
  idlPresent: boolean;
  idlSource: "pmp" | "anchor-legacy" | null; // where the IDL was published
  logoUrl: string | null; // developer-declared logo (on-chain metadata)
  authorityClass: AuthorityClass;
  deployerFundingSource: string | null; // known entity label (e.g. "Coinbase"), else null
  funderAddress: string | null; // the wallet that funded the deployer (traced)
  fundingAmountSol: number | null;
  deployCostSol: number | null; // rent-exempt SOL locked by the deploy
  earlySigners: number | null;
  verified: boolean;
  bucketId: string | null;
  clusterSize: number | null; // members in its clone cluster, if any
  deployType: RadarType; // "deploy" = new program id, "upgrade" = existing program changed
  firstDeployAt: string | null; // ISO — the ORIGINAL deploy (deployedAt is the latest)
  upgradeCount: number; // times re-deployed after the original
  /** upgradeCount is a floor (deploy-history page cap hit) — render as "N+" */
  upgradeCountTruncated?: boolean;
  // identity recovered from the program binary (the de-opaquer)
  repoUrl: string | null;
  social: string | null; // x.com / twitter
  website: string | null;
  hasSecurityTxt: boolean;
  // lifecycle — closed = ProgramData deallocated (rent reclaimed). Detected by
  // absence, not the close tx, so it's an honest "detected closed".
  closedAt: string | null;
  closed: boolean;
  // structured program profile (ELF-parsed)
  framework: Framework | null;
  capabilities: string[];
  integrations: string[];
  syscallCount: number | null;
  // fuzzy lineage — nearest known program by code similarity
  nearest: {
    name: string | null;
    id: string | null;
    similarity: number; // 0..1
    isReference: boolean; // true = a famous protocol, false = a peer deploy
    deployedAt: string | null; // neighbor's first deploy — for before/after-this direction
    peersWithin5: number | null; // distinct programs within 5 pts — high = generic crowd
    runnerUpSimilarity: number | null; // 2nd-nearest similarity (0..1) — gap = standout
  } | null;
  // exact lineage — byte-identical to a verified build of a known program
  codeMatch: {
    programId: string; // the original (verified) program
    repository: string;
    trusted: boolean;
  } | null;
  // devnet→mainnet lineage — seen incubating on devnet before its mainnet debut
  incubation: {
    devnetProgramId: string | null; // the devnet program it was sighted as
    firstDevnetAt: string; // ISO — first devnet sighting
    incubationDays: number; // devnet→mainnet gap, days
    devnetIterations: number; // devnet deploys BEFORE the mainnet debut (pre-launch effort)
    devnetDeploysTotal?: number; // lifetime devnet deploys (incl. post-launch staging)
    lastDevnetAt?: string | null; // ISO — last devnet deploy/upgrade
    matchedOn: "sha256" | "tlsh" | "authority" | "program_id";
  } | null;
  // Squads governance decoded from the deploy tx
  multisig: {
    address: string;
    version: "v4" | "v3";
    threshold: number | null; // null = detected but not decodable (v3 legacy)
    members: number | null;
  } | null;
  // sampled on-chain activity (hourly tx buckets; radar 48h, dossier 7d)
  activity: { t: number; c: number }[] | null;
  momentum: { txns24h: number; growth: number | null; txns24hTruncated?: boolean } | null;
  // interest-rank breakdown — drives the "why is this here" line; components
  // are weight-scaled contributions (absent on rows scored before it shipped)
  interest: {
    score: number;
    components: Record<string, number>;
    penalty: number;
    sizePrior?: number;
  } | null;
}

export interface ApiRawEvent {
  id: string;
  network: Network;
  type: "deploy" | "upgrade" | "set_authority" | "close";
  signature: string;
  slot: number;
  blockTime: string | null;
  programId: string;
  authorityBefore: string | null;
  authorityAfter: string | null;
  sha256After: string | null;
}

export interface ApiNeighbor {
  programId: string;
  distance: number;
  name: string | null;
}

/** The developer's own security.txt declaration, embedded in the program
 *  binary (Neodyme standard). Verbatim fields — nothing inferred. */
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

export interface ApiProgramDetail extends ApiProgram {
  authority: string | null;
  sha256: string | null;
  events: ApiRawEvent[]; // deploy/upgrade/authority timeline, newest first
  neighbors: ApiNeighbor[]; // nearest bytecode fingerprints
  idlInstructions: string[];
  strings: string[]; // notable printable strings from bytecode
  syscalls: string[]; // sol_* imports read off the ELF (the capability evidence)
  securityTxt: SecurityTxt | null; // embedded security.txt, verbatim
  /** programs compiled from the same crate — shared source, which bytecode
   *  distance cannot detect. Ranked by how many .rs files they share. */
  sourceKin?: {
    programId: string;
    name: string | null;
    crate: string;
    sharedFiles: number;
    overlap: number;
    deployedAt: string | null;
  }[];
}

export interface ApiFunnel {
  date: string; // YYYY-MM-DD
  raw: number; // total deploy+upgrade events
  unique: number; // unique bytecode (Y)
  novel: number; // Z
  clones: number;
  variants: number;
  deploys: number; // new programs (new program id)
  upgrades: number; // upgrades of existing programs
  windowHours?: number; // requested window (drives the chart)
  aggregateWindowHours?: number; // window the bar aggregates actually cover
  capped?: boolean; // true when the requested window exceeds enriched data (48h)
  byCategory: Record<string, number>; // category -> count among new deploys
  byFramework?: Record<string, number>; // framework -> count among new deploys
  byIntegration?: Record<string, number>; // referenced known program -> count
  byCapability?: Record<string, number>;
  // 30-day hourly volume; deploys/upgrades split is absent on API builds
  // predating the split (chart falls back to counting everything as deploys)
  volume?: { t: number; count: number; deploys?: number; upgrades?: number }[];
  // both clusters' series, for the side-by-side comparison in the chart. Absent
  // on API builds predating it — the chart falls back to `volume` alone.
  volumeByNetwork?: Record<
    Network,
    { t: number; count: number; deploys?: number; upgrades?: number }[]
  >;
  // per-vector aggregates across the window's new deploys
  identity?: { named: number; withRepo: number; opaque: number };
  lineage?: { novel: number; variant: number; fork: number };
  control?: { mutable: number; frozen: number; verified: number };
  conviction?: { knownEntity: number; funderTraced: number; untraced: number };
  churn?: { redeploys: number; pumpfun: number; closed: number };
  // time series over the window — the stream, bucketed
  series?: {
    hoursAgo: number;
    deploys: number;
    framework: Record<string, number>;
    category: Record<string, number>;
  }[];
  // per-framework share change (first half vs second half of the window)
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
    closed: boolean; // ProgramData gutted, rent reclaimed
  }[];
}

export interface ApiCursorPage<T> {
  items: T[];
  /** true row count for the whole slice (items caps at the page limit) */
  total?: number;
  nextCursor: string | null;
}

const EMPTY_PAGE = { items: [], nextCursor: null };

const API_TIMEOUT_MS = 10_000;

/** Thrown when the backend is unreachable, timing out, or erroring. Pages let
 *  this propagate to the app error boundary (app/error.tsx) — an outage must
 *  render as an outage, never as "no data" or a 404. */
export class ApiUnavailableError extends Error {
  constructor(path: string, cause: string) {
    super(`On Record API unavailable (${cause}) for ${path}`);
    this.name = "ApiUnavailableError";
  }
}

async function getJson<T>(path: string): Promise<T | null> {
  if (API_MISCONFIGURED) throw new ApiUnavailableError(path, "API_URL not configured");
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      next: { revalidate: 30 },
      // a hung backend must not pin the render until the platform 504s it
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiUnavailableError(path, err instanceof Error ? err.name : "network error");
  }
  if (res.status === 404) return null; // the one honest "not on record"
  if (!res.ok) throw new ApiUnavailableError(path, `HTTP ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiUnavailableError(path, "unparseable response");
  }
}

export async function fetchRadar(
  opts: {
    window?: RadarWindow;
    type?: RadarType;
    cursor?: string;
    limit?: number;
    band?: Band;
    /** "only" = the closed graveyard; default hides closed programs */
    closed?: "only" | "include";
    /** devnet = the incubation stream (recency-sorted server-side) */
    network?: Network;
  } = {}
): Promise<ApiCursorPage<ApiProgram>> {
  const params = new URLSearchParams();
  params.set("window", opts.window ?? "today");
  params.set("type", opts.type ?? "deploy");
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.band) params.set("band", opts.band);
  if (opts.closed) params.set("closed", opts.closed === "only" ? "only" : "1");
  if (opts.network === "devnet") params.set("network", "devnet");
  params.set("limit", String(opts.limit ?? 50));
  const page = await getJson<ApiCursorPage<ApiProgram>>(
    `/api/radar?${params.toString()}`
  );
  return page ?? { ...EMPTY_PAGE };
}

export async function fetchProgram(
  id: string
): Promise<ApiProgramDetail | null> {
  return getJson<ApiProgramDetail>(`/api/programs/${encodeURIComponent(id)}`);
}

// --- search: by name, crate, repo, or what a program talks to --------------
export interface ApiSearchResult {
  items: ApiProgram[];
  query: string;
  truncated: boolean; // more matches exist than the limit returned
}

/** "relevance" ranks by interest score inside a match tier; "recent" ranks by
 *  deploy date. Tiers (exact name > prefix > substring > bytecode) sit above
 *  both, so a name search always surfaces its own program first. */
export type SearchSort = "relevance" | "recent";

export async function fetchSearch(
  q: string,
  opts: { network?: Network; limit?: number; sort?: SearchSort } = {}
): Promise<ApiSearchResult> {
  const query = q.trim();
  if (query.length < 2) return { items: [], query, truncated: false };
  const params = new URLSearchParams({ q: query });
  if (opts.network) params.set("network", opts.network);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.sort === "recent") params.set("sort", "recent");
  const res = await getJson<ApiSearchResult>(`/api/search?${params.toString()}`);
  return res ?? { items: [], query, truncated: false };
}

/** Base58 program ids are 32–44 chars — a pasted address skips the dropdown
 *  and goes straight to the dossier. Mirrors looksLikeProgramId server-side. */
export function looksLikeProgramId(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}

// --- Anchor IDL (the program's human-readable interface) -------------------
export interface IdlField {
  name?: string;
  type?: unknown; // string | { defined } | { vec } | { option } | { array } | ...
  docs?: string[];
}
export interface IdlAccountRef {
  name?: string;
  writable?: boolean;
  signer?: boolean;
  optional?: boolean;
  isMut?: boolean; // legacy anchor <0.30
  isSigner?: boolean;
  docs?: string[];
}
export interface IdlInstruction {
  name?: string;
  docs?: string[];
  accounts?: IdlAccountRef[];
  args?: IdlField[];
}
export interface IdlTypeDef {
  name?: string;
  docs?: string[];
  type?: { kind?: string; fields?: IdlField[]; variants?: { name?: string }[] };
}
export interface AnchorIdl {
  address?: string;
  metadata?: { name?: string; version?: string; spec?: string; description?: string };
  name?: string; // legacy anchor <0.30
  version?: string;
  instructions?: IdlInstruction[];
  accounts?: IdlTypeDef[];
  types?: IdlTypeDef[];
  events?: { name?: string; fields?: IdlField[] }[];
  errors?: { code?: number; name?: string; msg?: string }[];
}

export async function fetchIdl(id: string): Promise<AnchorIdl | null> {
  const res = await getJson<{ idl: AnchorIdl | null }>(
    `/api/programs/${encodeURIComponent(id)}/idl`
  );
  return res?.idl ?? null;
}

// --- instruction usage: the program's real shape, decoded from recent txns --
export interface InstructionUsage {
  window: {
    txnsSampled: number;
    txnsWithProgram: number;
    totalCalls: number;
    hoursSpan: number | null;
  };
  instructions: { name: string; count: number; pct: number }[];
  unusedCount: number;
  totalInstructions: number;
  unknownDisc: number;
}

export async function fetchUsage(id: string): Promise<InstructionUsage | null> {
  const res = await getJson<{ usage: InstructionUsage | null }>(
    `/api/programs/${encodeURIComponent(id)}/usage`
  );
  return res?.usage ?? null;
}

export async function fetchFunnel(
  window?: string,
  network?: Network
): Promise<ApiFunnel | null> {
  const params = new URLSearchParams();
  if (window) params.set("window", window);
  if (network === "devnet") params.set("network", "devnet");
  const qs = params.toString();
  return getJson<ApiFunnel>(`/api/funnel${qs ? `?${qs}` : ""}`);
}

export async function fetchCluster(id: string): Promise<ApiCluster | null> {
  return getJson<ApiCluster>(`/api/clusters/${encodeURIComponent(id)}`);
}

export async function fetchRawEvents(
  opts: { cursor?: string; limit?: number; network?: Network } = {}
): Promise<ApiCursorPage<ApiRawEvent>> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.network) params.set("network", opts.network);
  params.set("limit", String(opts.limit ?? 50));
  const page = await getJson<ApiCursorPage<ApiRawEvent>>(
    `/api/raw/events?${params.toString()}`
  );
  return page ?? { ...EMPTY_PAGE };
}

// Orb explorer deep links: every address and signature is a live receipt.
export function orbAddress(id: string): string {
  return `https://orb.helius.dev/address/${id}`;
}

export function orbTx(signature: string): string {
  return `https://orb.helius.dev/tx/${signature}`;
}

export const BAND_LABELS: Record<Band, string> = {
  clone: "CLONE",
  variant: "VARIANT",
  novel: "NOVEL",
};

export const CATEGORY_LABELS: Record<Category, string> = {
  defi: "DEFI",
  token: "TOKEN",
  nft: "NFT",
  infra: "INFRA",
  governance: "GOV",
  unknown: "UNKNOWN",
};

const BANDS: Band[] = ["clone", "variant", "novel"];

export function isBand(value: string | undefined): value is Band {
  return value !== undefined && (BANDS as string[]).includes(value);
}

const WINDOWS: RadarWindow[] = ["today", "week", "month", "all"];

export function isWindow(value: string | undefined): value is RadarWindow {
  return value !== undefined && (WINDOWS as string[]).includes(value);
}

const RADAR_TYPES: RadarType[] = ["deploy", "upgrade"];

export function isRadarType(value: string | undefined): value is RadarType {
  return value !== undefined && (RADAR_TYPES as string[]).includes(value);
}
