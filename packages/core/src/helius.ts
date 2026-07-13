import { decompress } from "fzstd";
import { env } from "./config.js";
import type { Network } from "./types.js";

// ---------------------------------------------------------------------------
// Thin Helius RPC client. Everything the pipeline reads from chain goes
// through here: ProgramData bytes (base64+zstd), transaction existence checks,
// and account existence checks for receipt verification.
// ---------------------------------------------------------------------------

export const LOADER_PROGRAM_ID = "BPFLoaderUpgradeab1e11111111111111111111111";

export function rpcUrl(network: Network): string {
  const host = network === "mainnet" ? "mainnet.helius-rpc.com" : "devnet.helius-rpc.com";
  return `https://${host}/?api-key=${env.HELIUS_API_KEY}`;
}

let rpcSeq = 0;

const RPC_MAX_ATTEMPTS = Number(process.env.HELIUS_RPC_MAX_ATTEMPTS ?? 5);
const RPC_BASE_DELAY_MS = Number(process.env.HELIUS_RPC_BASE_DELAY_MS ?? 400);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retry transient RPC failures with exponential backoff + jitter. 429 (shared
// rate limit) and 5xx are the ones worth retrying — the burst backfill and the
// poller's bootstrap tick will hit 429s, and dropping those programs silently
// leaves permanent gaps (the poller's high-water mark never revisits them).
async function rpc<T>(network: Network, method: string, params: unknown[]): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(rpcUrl(network), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcSeq, method, params }),
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt === RPC_MAX_ATTEMPTS) {
          throw new Error(`helius rpc ${method}: HTTP ${res.status} (after ${attempt} attempts)`);
        }
        const retryAfter = Number(res.headers.get("retry-after"));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : RPC_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
        await sleep(backoff);
        continue;
      }
      if (!res.ok) throw new Error(`helius rpc ${method}: HTTP ${res.status}`);
      const json = (await res.json()) as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(`helius rpc ${method}: ${json.error.message}`);
      return json.result as T;
    } catch (err) {
      // network-level failure (fetch threw): retry with backoff, else rethrow
      lastErr = err;
      const retryable = err instanceof TypeError; // fetch network errors are TypeError
      if (!retryable || attempt === RPC_MAX_ATTEMPTS) throw err;
      await sleep(RPC_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`helius rpc ${method}: exhausted retries`);
}

interface AccountInfo {
  data: [string, string]; // [payload, encoding]
  owner: string;
  lamports: number;
}

/** Fetch raw account bytes, requesting zstd compression on the wire —
 *  ProgramData accounts run to megabytes and this is the cheap way to move
 *  them (spec §4.1). */
export async function getAccountBytes(network: Network, address: string): Promise<Buffer | null> {
  const result = await rpc<{ value: AccountInfo | null }>(network, "getAccountInfo", [
    address,
    { encoding: "base64+zstd", commitment: "confirmed" },
  ]);
  if (!result.value) return null;
  const [payload, encoding] = result.value.data;
  const raw = Buffer.from(payload, "base64");
  if (encoding === "base64+zstd") return Buffer.from(decompress(raw));
  return raw;
}

/** Fetch several small accounts in one round-trip (getMultipleAccounts).
 *  For metadata-sized accounts — do not use for ProgramData (no zstd here). */
export async function getMultipleAccountBytes(
  network: Network,
  addresses: string[],
): Promise<(Buffer | null)[]> {
  if (!addresses.length) return [];
  const result = await rpc<{ value: (AccountInfo | null)[] }>(network, "getMultipleAccounts", [
    addresses,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  return result.value.map((acc) => (acc ? Buffer.from(acc.data[0], "base64") : null));
}

/** Is a ProgramData account still a live program image? Closing a program
 *  does NOT remove the account — it leaves a 4-byte husk (state tag 0 =
 *  Uninitialized, 0 lamports), so a bare existence check reads "alive"
 *  forever. Alive = account present, funded, and state tag 3 (ProgramData). */
export async function programDataAlive(network: Network, address: string): Promise<boolean> {
  const result = await rpc<{ value: (AccountInfo & { lamports: number }) | null }>(
    network,
    "getAccountInfo",
    [address, { encoding: "base64", dataSlice: { offset: 0, length: 4 }, commitment: "confirmed" }],
  );
  if (!result.value || result.value.lamports === 0) return false;
  const head = Buffer.from(result.value.data[0], "base64");
  return head.length >= 4 && head.readUInt32LE(0) === 3;
}

export async function accountExists(network: Network, address: string): Promise<boolean> {
  const result = await rpc<{ value: AccountInfo | null }>(network, "getAccountInfo", [
    address,
    { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" },
  ]);
  return result.value !== null;
}

export async function transactionExists(network: Network, signature: string): Promise<boolean> {
  const result = await rpc<unknown>(network, "getTransaction", [
    signature,
    { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" },
  ]);
  return result !== null;
}

// ---------------------------------------------------------------------------
// Backfill — ProgramData enumeration (SPEC §3). The loader's *signature*
// history is not queryable (getSignaturesForAddress rejects the native loader),
// so we read chain state instead: every ProgramData account is owned by the
// loader and its 45-byte header encodes the last-deployed slot + authority.
// getProgramAccounts(loader, memcmp tag=3) + a header-only dataSlice enumerates
// every deploy without touching megabytes of bytecode.
// ---------------------------------------------------------------------------

export interface ProgramDataHeader {
  programDataAddress: string;
  deployedSlot: number;
  upgradeAuthority: string | null;
}

export async function getSlot(network: Network): Promise<number> {
  return rpc<number>(network, "getSlot", [{ commitment: "confirmed" }]);
}

/** Unix seconds a slot was produced, or null for skipped/pruned slots. */
export async function getBlockTime(network: Network, slot: number): Promise<number | null> {
  try {
    return await rpc<number | null>(network, "getBlockTime", [slot]);
  } catch {
    return null; // skipped slot — callers fall back to a default clock
  }
}

export interface ProgramAccountRef {
  programId: string;
  programDataAddress: string;
}

type RawProgramAccount = { pubkey: string; account: { data: [string, string] } };

/** Loader account enumeration, strategy per network (measured 2026-07-13):
 *  - mainnet: monolithic V1 call. The result is small (~19k ProgramData) and
 *    V2 would scan-page across the loader's ENTIRE owned set — millions of
 *    leftover deploy buffers — taking minutes to return almost nothing.
 *  - devnet: paginated V2 (1 credit / page). ~400k ProgramData accounts;
 *    the V1 one-shot response would be enormous, while the owned set is
 *    nearly all matches so V2 finishes in ~41 pages.
 */
async function programAccountsPaged(
  network: Network,
  config: Record<string, unknown>,
): Promise<RawProgramAccount[]> {
  if (network === "mainnet") {
    return rpc<RawProgramAccount[]>(network, "getProgramAccounts", [LOADER_PROGRAM_ID, config]);
  }
  const out: RawProgramAccount[] = [];
  let paginationKey: string | null = null;
  do {
    const page: Record<string, unknown> = { ...config, limit: 10_000 };
    if (paginationKey) page.paginationKey = paginationKey;
    const result: { accounts?: RawProgramAccount[]; paginationKey?: string | null } = await rpc(
      network,
      "getProgramAccountsV2",
      [LOADER_PROGRAM_ID, page],
    );
    out.push(...(result.accounts ?? []));
    paginationKey = result.paginationKey ?? null;
  } while (paginationKey);
  return out;
}

/** Enumerate Program accounts (loader enum tag 2, 36 bytes: tag + ProgramData
 *  pointer). Gives the programId ↔ ProgramData mapping the backfill joins
 *  against the ProgramData slot headers. */
export async function enumerateProgramAccounts(network: Network): Promise<ProgramAccountRef[]> {
  const result = await programAccountsPaged(network, {
    encoding: "base64",
    filters: [{ dataSize: 36 }], // Program account is exactly 36 bytes
    commitment: "confirmed",
  });
  const out: ProgramAccountRef[] = [];
  for (const row of result) {
    const buf = Buffer.from(row.account.data[0], "base64");
    const parsed = parseProgramAccount(buf);
    if (parsed) {
      out.push({ programId: row.pubkey, programDataAddress: base58Encode(parsed.programDataAddress) });
    }
  }
  return out;
}

/** Enumerate ProgramData account headers. Returns the deploy slot + authority
 *  for every program on the network; filter by slot window for a backfill.
 *  UpgradeableLoaderState::ProgramData is bincode enum variant 3 → u32 LE
 *  [3,0,0,0] at offset 0; the memcmp tag is computed at call time (not module
 *  load) so it can't drift and doesn't trip the base58Encode temporal dead zone. */
export async function enumerateProgramData(network: Network): Promise<ProgramDataHeader[]> {
  const programDataTag = base58Encode(Buffer.from([3, 0, 0, 0]));
  const result = await programAccountsPaged(network, {
    encoding: "base64",
    // ProgramData variant tag (enum 3) at offset 0, header-only slice
    filters: [{ memcmp: { offset: 0, bytes: programDataTag } }],
    dataSlice: { offset: 0, length: PROGRAMDATA_HEADER_LEN },
    commitment: "confirmed",
  });
  const out: ProgramDataHeader[] = [];
  for (const row of result) {
    const buf = Buffer.from(row.account.data[0], "base64");
    const parsed = parseProgramDataHeader(buf);
    if (parsed) out.push({ programDataAddress: row.pubkey, ...parsed });
  }
  return out;
}

/** Parse only the 45-byte ProgramData header (no bytecode). */
export function parseProgramDataHeader(
  data: Buffer,
): { deployedSlot: number; upgradeAuthority: string | null } | null {
  if (data.length < PROGRAMDATA_HEADER_LEN || data.readUInt32LE(0) !== 3) return null;
  const deployedSlot = Number(data.readBigUInt64LE(4));
  const hasAuthority = data[12] === 1;
  const upgradeAuthority = hasAuthority ? base58Encode(data.subarray(13, 45)) : null;
  return { deployedSlot, upgradeAuthority };
}

/** The Program account (enum tag 2) points at its ProgramData address. Used to
 *  resolve programId ↔ ProgramData during backfill. */
export async function getProgramDataAddress(
  network: Network,
  programId: string,
): Promise<string | null> {
  const bytes = await getAccountBytes(network, programId);
  if (!bytes) return null;
  const parsed = parseProgramAccount(bytes);
  return parsed ? base58Encode(parsed.programDataAddress) : null;
}

// ---------------------------------------------------------------------------
// Scoring reads: early usage + deployer funding trail (SPEC §2).
// ---------------------------------------------------------------------------

interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
}

export async function getSignaturesForAddress(
  network: Network,
  address: string,
  opts: { limit?: number; before?: string; until?: string } = {},
): Promise<SignatureInfo[]> {
  return rpc<SignatureInfo[]>(network, "getSignaturesForAddress", [
    address,
    { limit: opts.limit ?? 1000, before: opts.before, until: opts.until, commitment: "confirmed" },
  ]);
}

export interface DeployHistory {
  firstDeployAt: Date | null;
  firstDeploySlot: number | null;
  lastDeploySlot: number | null;
  /** newest deploy/upgrade transaction — the tx that shipped the current code */
  lastSignature: string | null;
  /** deploy + upgrade + set-authority txns on the ProgramData; upgrades ≈ count-1 */
  txCount: number;
}

/** A program's ProgramData account only appears in deploy / upgrade / set-authority
 *  / close transactions — never in program invocations — so its signature history
 *  IS the program's deploy history. Oldest signature = the original deploy; a count
 *  above 1 means the program has been upgraded. Cheap and exact, unlike walking the
 *  program id's (usage-flooded) history. */
export async function getDeployHistory(
  network: Network,
  programDataAddress: string,
): Promise<DeployHistory> {
  const all: SignatureInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    const sigs = await getSignaturesForAddress(network, programDataAddress, { limit: 1000, before });
    if (!sigs.length) break;
    all.push(...sigs);
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1]!.signature;
  }
  if (!all.length) {
    return { firstDeployAt: null, firstDeploySlot: null, lastDeploySlot: null, lastSignature: null, txCount: 0 };
  }
  const oldest = all[all.length - 1]!;
  return {
    firstDeployAt: oldest.blockTime ? new Date(oldest.blockTime * 1000) : null,
    firstDeploySlot: oldest.slot,
    lastDeploySlot: all[0]!.slot,
    lastSignature: all[0]!.signature,
    txCount: all.length,
  };
}

/** Early-usage proxy: how many transactions hit the program in its first
 *  `windowHours`. (Distinct-signer counting needs per-tx fetches; signature
 *  count is the cheap, honest proxy the score treats as "early activity".) */
export async function getEarlyActivity(
  network: Network,
  programId: string,
  deployedAtMs: number,
  windowHours: number,
): Promise<number> {
  try {
    const cutoff = deployedAtMs + windowHours * 3_600_000;
    let count = 0;
    let before: string | undefined;
    // page back from newest until we pass the window or run dry (cap 5 pages)
    for (let page = 0; page < 5; page++) {
      const sigs = await getSignaturesForAddress(network, programId, { limit: 1000, before });
      if (sigs.length === 0) break;
      for (const s of sigs) {
        if (s.blockTime && s.blockTime * 1000 <= cutoff) count++;
      }
      before = sigs[sigs.length - 1]?.signature;
      // if the oldest on this page is already before deploy, we've covered it
      const oldest = sigs[sigs.length - 1]?.blockTime;
      if (oldest && oldest * 1000 < deployedAtMs) break;
      if (sigs.length < 1000) break;
    }
    return count;
  } catch {
    return 0;
  }
}

// Known Solana funding sources — a small curated set is enough to separate
// "credible team" from "fresh bot wallet" for the score (SPEC §2).
const KNOWN_SOURCES: Record<string, "cex" | "bridge" | "known_multisig"> = {
  // exchanges (hot wallets)
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9": "cex", // Binance
  H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS: "cex", // Coinbase
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S": "cex", // Coinbase 2
  AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2: "cex", // Bybit
  // bridges
  "8s3jH5aM6zBLYQkYSCPTd7GXwKY4WNbT7BwqL7Wt7RSs": "bridge",
};

export type FundingClass = "cex" | "bridge" | "known_multisig" | "fresh" | "unknown";

export interface FundingTrail {
  source: FundingClass;
  /** the wallet that sent the authority its first SOL (largest balance drop) */
  funderAddress: string | null;
  /** lamports the authority received in that transaction */
  fundingLamports: number | null;
}

const NO_TRAIL: FundingTrail = { source: "unknown", funderAddress: null, fundingLamports: null };

/** Trace where the deploy authority's SOL first came from. Best-effort: reads
 *  the oldest signature and inspects the funding transfer's balances. */
export async function getFundingTrail(
  network: Network,
  authority: string | null,
): Promise<FundingTrail> {
  if (!authority) return NO_TRAIL;
  try {
    // walk to the oldest page of signatures
    let before: string | undefined;
    let oldest: SignatureInfo | undefined;
    for (let page = 0; page < 3; page++) {
      const sigs = await getSignaturesForAddress(network, authority, { limit: 1000, before });
      if (sigs.length === 0) break;
      oldest = sigs[sigs.length - 1];
      if (sigs.length < 1000) break;
      before = oldest?.signature;
    }
    if (!oldest) return NO_TRAIL;
    const tx = await rpc<{
      transaction: { message: { accountKeys: string[] } };
      meta: { preBalances: number[]; postBalances: number[] } | null;
    } | null>(network, "getTransaction", [
      oldest.signature,
      { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" },
    ]);
    if (!tx?.meta) return NO_TRAIL;
    const keys = tx.transaction.message.accountKeys;
    const { preBalances, postBalances } = tx.meta;

    // how much the authority received in its first transaction
    const authorityIdx = keys.indexOf(authority);
    const received = authorityIdx >= 0 ? (postBalances[authorityIdx] ?? 0) - (preBalances[authorityIdx] ?? 0) : 0;

    // the funder is the account whose balance dropped the most (fee payer in a
    // plain transfer; still correct when a program routed the SOL)
    let funderAddress: string | null = null;
    let biggestDrop = 0;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      if (key === authority) continue;
      const drop = (preBalances[i] ?? 0) - (postBalances[i] ?? 0);
      if (drop > biggestDrop) {
        biggestDrop = drop;
        funderAddress = key;
      }
    }

    let source: FundingClass = "fresh";
    for (const key of keys) {
      const known = KNOWN_SOURCES[key];
      if (known) {
        source = known;
        break;
      }
    }
    return { source, funderAddress, fundingLamports: received > 0 ? received : null };
  } catch {
    return NO_TRAIL;
  }
}

// --- Deploy cost -------------------------------------------------------------

/** Rent-exempt lamports a deploy locks on chain: the 36-byte Program account +
 *  the ProgramData account (header + allocated bytecode). Solana's rent math:
 *  (128-byte account overhead + data_len) × 3,480 lamports/byte-year × 2 years.
 *  Deterministic from account size — no RPC needed. */
export function deployRentLamports(programDataAccountBytes: number): number {
  const LAMPORTS_PER_BYTE_2Y = 3_480 * 2;
  const PROGRAM_ACCOUNT_BYTES = 36;
  return (128 + PROGRAM_ACCOUNT_BYTES + 128 + programDataAccountBytes) * LAMPORTS_PER_BYTE_2Y;
}

// --- Upgradeable-loader account parsing -------------------------------------

/** Program account layout: u32 enum tag (2 = Program) + programdata address. */
export function parseProgramAccount(data: Buffer): { programDataAddress: Buffer } | null {
  if (data.length < 36 || data.readUInt32LE(0) !== 2) return null;
  return { programDataAddress: data.subarray(4, 36) };
}

/** ProgramData metadata header: u32 tag (3) + u64 slot + Option<Pubkey>. */
export const PROGRAMDATA_HEADER_LEN = 4 + 8 + 1 + 32; // 45 bytes

export interface ProgramData {
  deployedSlot: number;
  upgradeAuthority: string | null;
  /** raw bytecode with the metadata header stripped and zero-padding trimmed,
   *  so re-deploys with a different maxDataLen fingerprint identically */
  bytecode: Buffer;
}

export function parseProgramDataAccount(data: Buffer): ProgramData | null {
  if (data.length < PROGRAMDATA_HEADER_LEN || data.readUInt32LE(0) !== 3) return null;
  const deployedSlot = Number(data.readBigUInt64LE(4));
  const hasAuthority = data[12] === 1;
  const upgradeAuthority = hasAuthority ? base58Encode(data.subarray(13, 45)) : null;
  let end = data.length;
  while (end > PROGRAMDATA_HEADER_LEN && data[end - 1] === 0) end--;
  return { deployedSlot, upgradeAuthority, bytecode: data.subarray(PROGRAMDATA_HEADER_LEN, end) };
}

// Minimal base58 (no dependency cycle with bs58 usage elsewhere is fine, but
// keep encode local for account parsing).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let num = BigInt("0x" + Buffer.from(bytes).toString("hex").padStart(2, "0"));
  let out = "";
  while (num > 0n) {
    out = B58[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out || "1";
}
