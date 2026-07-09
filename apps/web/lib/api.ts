// Typed fetch helpers for the On Record backend API.
// Every helper catches network/parse failures and returns a safe empty
// fallback so pages render a designed empty state instead of crashing.

const API_BASE = process.env.API_URL ?? "http://localhost:3001";

export type Network = "mainnet" | "devnet";
export type Band = "clone" | "variant" | "novel";
export type Category =
  | "defi"
  | "gaming"
  | "payments"
  | "token"
  | "nft"
  | "infra"
  | "governance"
  | "unknown";
export type AuthorityClass = "none" | "squads" | "program" | "hot_wallet" | null;

export type RadarWindow = "today" | "week" | "all";
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
  authorityClass: AuthorityClass;
  deployerFundingSource: string | null; // known entity label (e.g. "Coinbase"), else null
  funderAddress: string | null; // the wallet that funded the deployer (traced)
  fundingAmountSol: number | null;
  earlySigners: number | null;
  verified: boolean;
  bucketId: string | null;
  clusterSize: number | null; // members in its clone cluster, if any
  deployType: RadarType; // "deploy" = new program id, "upgrade" = existing program changed
  firstDeployAt: string | null; // ISO — the ORIGINAL deploy (deployedAt is the latest)
  upgradeCount: number; // times re-deployed after the original
  // identity recovered from the program binary (the de-opaquer)
  repoUrl: string | null;
  social: string | null; // x.com / twitter
  website: string | null;
  hasSecurityTxt: boolean;
  // structured program profile (ELF-parsed)
  framework: "anchor" | "pinocchio" | "native" | "unknown" | null;
  capabilities: string[];
  integrations: string[];
  syscallCount: number | null;
  // fuzzy lineage — nearest known program by code similarity
  nearest: {
    name: string | null;
    id: string | null;
    similarity: number; // 0..1
    isReference: boolean; // true = a famous protocol, false = a peer deploy
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

export interface ApiProgramDetail extends ApiProgram {
  authority: string | null;
  sha256: string | null;
  events: ApiRawEvent[]; // deploy/upgrade/authority timeline, newest first
  neighbors: ApiNeighbor[]; // nearest bytecode fingerprints
  idlInstructions: string[];
  strings: string[]; // notable printable strings from bytecode
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
  volume?: { t: number; count: number }[]; // 30-day hourly deploy/upgrade volume
  // per-vector aggregates across the window's new deploys
  identity?: { named: number; withRepo: number; opaque: number };
  lineage?: { novel: number; variant: number; fork: number };
  control?: { mutable: number; frozen: number; verified: number };
  conviction?: { knownEntity: number; funderTraced: number; untraced: number };
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
  members: { programId: string; deployedAt: string | null }[];
}

export interface ApiCursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

const EMPTY_PAGE = { items: [], nextCursor: null };

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchRadar(
  opts: {
    window?: RadarWindow;
    type?: RadarType;
    cursor?: string;
    limit?: number;
  } = {}
): Promise<ApiCursorPage<ApiProgram>> {
  const params = new URLSearchParams();
  params.set("window", opts.window ?? "today");
  params.set("type", opts.type ?? "deploy");
  if (opts.cursor) params.set("cursor", opts.cursor);
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

export async function fetchFunnel(window?: string): Promise<ApiFunnel | null> {
  const qs = window ? `?window=${encodeURIComponent(window)}` : "";
  return getJson<ApiFunnel>(`/api/funnel${qs}`);
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
  gaming: "GAMING",
  payments: "PAY",
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

const WINDOWS: RadarWindow[] = ["today", "week", "all"];

export function isWindow(value: string | undefined): value is RadarWindow {
  return value !== undefined && (WINDOWS as string[]).includes(value);
}

const RADAR_TYPES: RadarType[] = ["deploy", "upgrade"];

export function isRadarType(value: string | undefined): value is RadarType {
  return value !== undefined && (RADAR_TYPES as string[]).includes(value);
}
