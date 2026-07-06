import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import bs58 from "bs58";
import { getAccountBytes, LOADER_PROGRAM_ID } from "./helius.js";
import type { Network } from "./types.js";

const execFileAsync = promisify(execFile);

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// TLSH — generation shells out to the reference `tlsh` CLI (spec §11 default;
// the worker image installs it). Distance between stored digests is computed
// here in TS so the corpus scan never touches the filesystem.
// ---------------------------------------------------------------------------

export async function tlshHash(bytes: Uint8Array): Promise<string | null> {
  if (bytes.length < 256) return null; // TLSH needs ≥256 bytes of input
  const dir = await mkdtemp(path.join(tmpdir(), "tlsh-"));
  const file = path.join(dir, "blob");
  try {
    await writeFile(file, bytes);
    const { stdout } = await execFileAsync("tlsh", ["-f", file]);
    // output: "<digest>\t<filename>"
    const digest = stdout.trim().split(/\s+/)[0] ?? "";
    return /^T1[0-9A-F]{70}$/i.test(digest) || /^[0-9A-F]{70}$/i.test(digest) ? digest : null;
  } catch {
    return null; // CLI missing or hashing failed — fingerprint degrades to sha256 only
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface ParsedTlsh {
  checksum: number;
  lvalue: number;
  q1: number;
  q2: number;
  body: Uint8Array; // 32 bytes = 128 buckets × 2 bits
}

function parseTlsh(digest: string): ParsedTlsh | null {
  const hex = digest.startsWith("T1") || digest.startsWith("t1") ? digest.slice(2) : digest;
  if (!/^[0-9A-Fa-f]{70}$/.test(hex)) return null;
  const bytes = Buffer.from(hex, "hex");
  const qByte = bytes[2]!;
  return {
    checksum: bytes[0]!,
    lvalue: bytes[1]!,
    q1: qByte >> 4,
    q2: qByte & 0x0f,
    body: bytes.subarray(3),
  };
}

function modDiff(x: number, y: number, range: number): number {
  const dl = Math.abs(x - y);
  return Math.min(dl, range - dl);
}

/** TLSH distance per the reference implementation's totalDiff (len included). */
export function tlshDistance(a: string, b: string): number | null {
  const pa = parseTlsh(a);
  const pb = parseTlsh(b);
  if (!pa || !pb) return null;

  let diff = 0;
  if (pa.checksum !== pb.checksum) diff += 1;

  const ldiff = modDiff(pa.lvalue, pb.lvalue, 256);
  diff += ldiff <= 1 ? ldiff : ldiff * 12;

  const q1diff = modDiff(pa.q1, pb.q1, 16);
  diff += q1diff <= 1 ? q1diff : (q1diff - 1) * 12;
  const q2diff = modDiff(pa.q2, pb.q2, 16);
  diff += q2diff <= 1 ? q2diff : (q2diff - 1) * 12;

  for (let i = 0; i < 32; i++) {
    const x = pa.body[i]!;
    const y = pb.body[i]!;
    for (let shift = 0; shift < 8; shift += 2) {
      const d = Math.abs(((x >> shift) & 3) - ((y >> shift) & 3));
      diff += d === 3 ? 6 : d;
    }
  }
  return diff;
}

// ---------------------------------------------------------------------------
// Printable-strings extraction: ASCII runs ≥ 8 chars, deduped, longest first,
// top 100 (spec §4.1). Feeds the Radar triage read.
// ---------------------------------------------------------------------------

export function extractStrings(bytes: Uint8Array, minLen = 8, top = 100): string[] {
  const found = new Set<string>();
  let start = -1;
  for (let i = 0; i <= bytes.length; i++) {
    const c = i < bytes.length ? bytes[i]! : 0;
    const printable = c >= 0x20 && c <= 0x7e;
    if (printable && start === -1) start = i;
    if (!printable && start !== -1) {
      if (i - start >= minLen) found.add(Buffer.from(bytes.subarray(start, i)).toString("ascii"));
      start = -1;
    }
  }
  return [...found].sort((x, y) => y.length - x.length).slice(0, top);
}

// ---------------------------------------------------------------------------
// Anchor IDL probe (spec §4.1). The IDL account address is
// createWithSeed(base, "anchor:idl", programId) where base is the program's
// zero-seed PDA. PDA derivation needs an ed25519 on-curve check, implemented
// below with bigint field math — no web3.js dependency.
// ---------------------------------------------------------------------------

const P = 2n ** 255n - 19n;
const D = mod(-121665n * inverse(121666n));

function mod(n: number | bigint): bigint {
  const r = BigInt(n) % P;
  return r < 0n ? r + P : r;
}

function power(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

function inverse(n: bigint): bigint {
  return power(n, P - 2n);
}

const SQRT_M1 = power(2n, (P - 1n) / 4n);

/** True if the 32-byte compressed point decodes to a point on ed25519. */
export function isOnCurve(pubkey: Uint8Array): boolean {
  if (pubkey.length !== 32) return false;
  const bytes = Buffer.from(pubkey);
  const yBytes = Buffer.from(bytes);
  yBytes[31]! &= 0x7f;
  const y = BigInt("0x" + Buffer.from(yBytes).reverse().toString("hex"));
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // candidate sqrt of u/v for p ≡ 5 (mod 8): x = u·v³·(u·v⁷)^((p−5)/8)  (RFC 8032)
  let x = (((u * power(v, 3n)) % P) * power((u * power(v, 7n)) % P, (P - 5n) / 8n)) % P;
  const vx2 = (v * x * x) % P;
  if (vx2 === u) {
    // ok
  } else if (vx2 === mod(-u)) {
    x = (x * SQRT_M1) % P;
  } else {
    return false;
  }
  if (x === 0n && (bytes[31]! & 0x80) !== 0) return false;
  return true;
}

function sha256Bytes(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

const PDA_MARKER = Buffer.from("ProgramDerivedAddress", "ascii");

export function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array): Uint8Array {
  for (let bump = 255; bump >= 0; bump--) {
    const candidate = sha256Bytes(...seeds, Buffer.from([bump]), programId, PDA_MARKER);
    if (!isOnCurve(candidate)) return candidate;
  }
  throw new Error("no viable PDA bump");
}

export function createWithSeed(base: Uint8Array, seed: string, owner: Uint8Array): Uint8Array {
  return sha256Bytes(base, Buffer.from(seed, "utf8"), owner);
}

export function anchorIdlAddress(programId: string): string {
  const pid = bs58.decode(programId);
  const base = findProgramAddress([], pid);
  return bs58.encode(createWithSeed(base, "anchor:idl", pid));
}

export interface IdlProbe {
  instructions: string[];
  accounts: string[];
}

/** Fetch and decompress the on-chain Anchor IDL if one exists. */
export async function probeAnchorIdl(network: Network, programId: string): Promise<IdlProbe | null> {
  try {
    const address = anchorIdlAddress(programId);
    const data = await getAccountBytes(network, address);
    // IdlAccount: 8-byte discriminator + 32-byte authority + u32 len + zlib data
    if (!data || data.length < 44) return null;
    const len = data.readUInt32LE(40);
    if (len === 0 || 44 + len > data.length) return null;
    const json = zlib.inflateSync(data.subarray(44, 44 + len)).toString("utf8");
    const idl = JSON.parse(json) as {
      instructions?: { name?: string }[];
      accounts?: { name?: string }[];
    };
    return {
      instructions: (idl.instructions ?? []).map((i) => i.name ?? "").filter(Boolean).slice(0, 64),
      accounts: (idl.accounts ?? []).map((a) => a.name ?? "").filter(Boolean).slice(0, 64),
    };
  } catch {
    return null;
  }
}

// re-export so callers only need one import for loader constants
export { LOADER_PROGRAM_ID };
