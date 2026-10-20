import crypto from "node:crypto";
import zlib from "node:zlib";
import { logger } from "./logger.js";

/**
 * A program's history from the Old Faithful backfill: every deploy, upgrade,
 * close and authority change the loaders recorded, and every version's bytecode
 * rebuilt from its buffer's Write instructions and run through the same
 * analysis the pipeline uses (fingerprint strings → source paths, profile,
 * bytecode identity).
 *
 * Read on demand, never scanned. The history lives in Cloudflare R2 as 4,096
 * zstd-compressed JSON bundles keyed by the first three hex digits of
 * sha256(program id) — one GET returns a program's whole history (and ~16
 * others'). Nothing here touches Postgres, so a program page costs one small
 * download and adds no database memory.
 *
 * Coverage is stated on every record, and holds for the programs it lists: no
 * record means no loader instruction acted on that program inside the range,
 * not that the program does not exist.
 */

export type HistoryVersion = {
  kind: "deploy" | "upgrade";
  slot: number;
  at: string | null;
  signature: string;
  authority: string | null;
  invoked_by: string | null;
  buffer: string;
  writes: number;
  /** bytes no Write covered — the rebuild missed part of the image */
  holes: number;
  sha256: string | null;
  size: number;
  sizeBytes?: number;
  tlsh?: string | null;
  sourcePaths?: string[];
  framework?: string;
  instructionNames?: string[];
  instructionCount?: number | null;
  integrations?: string[];
  capabilities?: string[];
  syscalls?: string[];
  name?: string | null;
  crate?: string | null;
  repoUrl?: string | null;
  hasSecurityTxt?: boolean;
};

export type HistoryLoaderRow = {
  kind: string;
  outcome: "ok" | "failed" | "no_meta";
  slot: number;
  at: string | null;
  tx: number;
  outer: number;
  inner: number;
  signature: string;
  fee_payer: string;
  signers: string[];
  invoked_by: string | null;
  tx_version: string;
  accounts: string[];
  data: string;
  err: unknown;
};

export type ProgramHistory = {
  program: string;
  programdata: string;
  coverage: { first_slot: number; last_slot: number; source: string };
  deployed_in_range: boolean;
  first_deploy: { slot: number; at: string | null; signature: string; authority: string | null } | null;
  closed: { slot: number; at: string | null; signature: string } | null;
  versions: HistoryVersion[];
  loader: HistoryLoaderRow[];
};

type Shard = Record<string, ProgramHistory>;

const BUCKET = process.env.R2_HISTORY_BUCKET ?? "onrecord-history";
const PREFIX = "v1/shards";
const CACHE_SHARDS = 256;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const cache = new Map<string, { at: number; shard: Shard | null }>();

export function historyConfigured(): boolean {
  return Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);
}

export const historyShardOf = (programId: string): string =>
  crypto.createHash("sha256").update(programId).digest("hex").slice(0, 3);

const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac("sha256", key).update(data).digest();
const sha256hex = (data: string) => crypto.createHash("sha256").update(data).digest("hex");

/** A SigV4-signed GET against R2's S3 API — enough for reading one object,
 *  without pulling in an SDK. Returns null for a missing object. */
async function r2Get(key: string): Promise<Buffer | null> {
  const account = process.env.R2_ACCOUNT_ID!;
  const host = `${account}.r2.cloudflarestorage.com`;
  const path = `/${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = "UNSIGNED-PAYLOAD";
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonical = ["GET", path, "", `host:${host}`, `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${amzDate}`, "", signedHeaders, payloadHash].join("\n");
  const scope = `${day}/auto/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const kDate = hmac(`AWS4${process.env.R2_SECRET_ACCESS_KEY}`, day);
  const kSigning = hmac(hmac(hmac(kDate, "auto"), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(toSign).digest("hex");
  const res = await fetch(`https://${host}${path}`, {
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      authorization: `AWS4-HMAC-SHA256 Credential=${process.env.R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`R2 GET ${key}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function loadShard(shard: string): Promise<Shard | null> {
  const hit = cache.get(shard);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    cache.delete(shard); // re-insert: Map order doubles as LRU order
    cache.set(shard, hit);
    return hit.shard;
  }
  const raw = await r2Get(`${PREFIX}/${shard}.json.zst`);
  const body = raw ? (JSON.parse(zlib.zstdDecompressSync(raw).toString("utf8")) as Shard) : null;
  cache.set(shard, { at: Date.now(), shard: body });
  while (cache.size > CACHE_SHARDS) cache.delete(cache.keys().next().value!);
  return body;
}

/** One program's backfilled history, or null when the backfill holds none for
 *  it (or history is not configured on this deployment). Never throws: a
 *  failed read logs and returns null, so a page renders with live data only. */
export async function loadHistory(programId: string): Promise<ProgramHistory | null> {
  if (!historyConfigured()) return null;
  try {
    const shard = await loadShard(historyShardOf(programId));
    return shard?.[programId] ?? null;
  } catch (err) {
    logger.warn({ err: String(err), programId }, "history read failed");
    return null;
  }
}
