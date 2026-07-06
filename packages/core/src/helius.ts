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

async function rpc<T>(network: Network, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl(network), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcSeq, method, params }),
  });
  if (!res.ok) throw new Error(`helius rpc ${method}: HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`helius rpc ${method}: ${json.error.message}`);
  return json.result as T;
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
