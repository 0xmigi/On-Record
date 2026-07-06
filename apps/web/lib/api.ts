// Typed fetch helpers for the On Record backend API.
// Every helper catches network/parse failures and returns a safe empty
// fallback so pages render a designed empty state instead of crashing.

const API_BASE = process.env.API_URL ?? "http://localhost:3001";

export type StoryType =
  | "update"
  | "launch"
  | "radar"
  | "became_real"
  | "corroboration"
  | "control_change"
  | "copy_wave";

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

export interface ApiStory {
  id: string;
  type: StoryType;
  headline: string;
  body: string;
  facts: StoryFact[];
  inference: StoryInference | null;
  subjects: { id: string; name: string | null }[];
  status: "published" | "killed" | "pinned" | "dead_letter";
  pinned: boolean;
  publishedAt: string;
}

export interface ApiRawEvent {
  id: string;
  network: "mainnet" | "devnet";
  type: "deploy" | "upgrade" | "set_authority" | "close";
  signature: string;
  slot: number;
  blockTime: string | null;
  programId: string;
  authorityBefore: string | null;
  authorityAfter: string | null;
  sha256After: string | null;
  enrichment: Record<string, unknown>;
}

export interface ApiStoryDetail extends ApiStory {
  events: ApiRawEvent[];
}

export interface ApiSubject {
  id: string;
  kind: "program" | "entity";
  name: string | null;
  network: "mainnet" | "devnet";
  verified: boolean;
  repoUrl: string | null;
  authorityClass: "none" | "squads" | "program" | "hot_wallet" | null;
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

export async function fetchStories(
  opts: { type?: StoryType; cursor?: string; limit?: number } = {}
): Promise<ApiCursorPage<ApiStory>> {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  if (opts.cursor) params.set("cursor", opts.cursor);
  params.set("limit", String(opts.limit ?? 30));
  const page = await getJson<ApiCursorPage<ApiStory>>(
    `/api/stories?${params.toString()}`
  );
  return page ?? { ...EMPTY_PAGE };
}

export async function fetchStory(id: string): Promise<ApiStoryDetail | null> {
  return getJson<ApiStoryDetail>(`/api/stories/${encodeURIComponent(id)}`);
}

export async function fetchDigest(date: string): Promise<ApiDigest | null> {
  return getJson<ApiDigest>(`/api/digest/${encodeURIComponent(date)}`);
}

export async function fetchSubject(id: string): Promise<ApiSubject | null> {
  return getJson<ApiSubject>(`/api/subjects/${encodeURIComponent(id)}`);
}

export async function fetchRawEvents(
  opts: { cursor?: string; limit?: number } = {}
): Promise<ApiCursorPage<ApiRawEvent>> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  params.set("limit", String(opts.limit ?? 50));
  const page = await getJson<ApiCursorPage<ApiRawEvent>>(
    `/api/raw/events?${params.toString()}`
  );
  return page ?? { ...EMPTY_PAGE };
}

export async function fetchStats(): Promise<ApiStats | null> {
  return getJson<ApiStats>("/api/stats");
}

export async function fetchLab(): Promise<ApiWatchlistItem[]> {
  const items = await getJson<ApiWatchlistItem[]>("/api/lab");
  return Array.isArray(items) ? items : [];
}

export const RSS_URL = `${API_BASE}/rss.xml`;

// Receipt link targets: transactions and accounts open in the Orb explorer,
// repo receipts are already full URLs.
export function receiptHref(receipt: Receipt): string {
  switch (receipt.kind) {
    case "tx":
      return `https://orb.helius.dev/tx/${receipt.ref}`;
    case "account":
      return `https://orb.helius.dev/address/${receipt.ref}`;
    case "repo":
      return receipt.ref;
  }
}

export const STORY_TYPE_LABELS: Record<StoryType, string> = {
  update: "UPDATE",
  launch: "LAUNCH",
  radar: "RADAR",
  became_real: "NOW LIVE",
  corroboration: "ON RECORD",
  control_change: "CONTROL",
  copy_wave: "COPIES",
};

const STORY_TYPES: StoryType[] = [
  "update",
  "launch",
  "radar",
  "became_real",
  "corroboration",
  "control_change",
  "copy_wave",
];

export function isStoryType(value: string | undefined): value is StoryType {
  return value !== undefined && (STORY_TYPES as string[]).includes(value);
}
