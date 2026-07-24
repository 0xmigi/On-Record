import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import bs58 from "bs58";
import { LOADER_PROGRAM_ID } from "./helius.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// TLSH — generation shells out to the reference `tlsh` CLI (spec §11 default;
// the worker image installs it). Distance between stored digests is computed
// here in TS so the corpus scan never touches the filesystem.
// ---------------------------------------------------------------------------

/** Raised when the tlsh CLI cannot be run at all (missing binary, or exec
 *  failing repeatedly). Distinct from a null return, which means TLSH ran fine
 *  and legitimately refused the input. Callers must let this propagate: a
 *  fingerprint without lineage is corrupt data, not a partial result. */
export class TlshUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `tlsh CLI unavailable (${cause}). Refusing to fingerprint without lineage — ` +
        `a subject written now would read as novel code forever. The binary ships ` +
        `in the worker image; run this inside the container (railway ssh) or install it.`,
    );
    this.name = "TlshUnavailableError";
  }
}

/** Returns a digest, or null when TLSH itself refuses the input (too small or
 *  too little variance) — the only honest "no hash" cases. Anything else
 *  THROWS.
 *
 *  Why it throws rather than returning null: a null from a missing binary is
 *  indistinguishable, downstream, from a null TLSH chose. classifyFingerprint
 *  skips its whole nearest-neighbour block when tlsh is null, so the program
 *  scores structuralNovelty=1 and lands as "novel" with no lineage and no
 *  bucket — permanently, because nothing revisits it. That is worse than
 *  failing: the pipeline reports outcome "ok" and writes corrupt rows at full
 *  speed. This happened on 2026-07-24 — a backfill run outside the container
 *  wrote 116 such subjects before anyone noticed the warn lines.
 *
 *  It also still retries, because transient exec failures under concurrency are
 *  real: measured on the live corpus, 80 of 4,985 entries (1.6%) had a null
 *  tlsh with a size distribution matching the successes almost exactly (median
 *  311 KB vs 293 KB) — those were flaky spawns, not refused inputs. */
export async function tlshHash(bytes: Uint8Array): Promise<string | null> {
  if (bytes.length < 256) return null; // TLSH needs ≥256 bytes of input
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const dir = await mkdtemp(path.join(tmpdir(), "tlsh-"));
    const file = path.join(dir, "blob");
    try {
      await writeFile(file, bytes);
      const { stdout } = await execFileAsync("tlsh", ["-f", file], {
        maxBuffer: 1 << 20,
        timeout: 30_000,
      });
      // output: "<digest>\t<filename>"
      const digest = stdout.trim().split(/\s+/)[0] ?? "";
      if (/^T1[0-9A-F]{70}$/i.test(digest) || /^[0-9A-F]{70}$/i.test(digest)) return digest;
      // A well-formed run that produced no digest means TLSH genuinely refused
      // this input (too little variance). Retrying cannot change that.
      return null;
    } catch (err) {
      // A missing binary is not transient — retrying it just delays the same
      // answer three times and buries the cause in the last error.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw new TlshUnavailableError("binary not found on PATH");
      }
      lastError = err;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  throw new TlshUnavailableError(`exec failed 3× — ${String(lastError).slice(0, 200)}`);
}

/** Preflight for anything that runs the pipeline: prove the CLI works BEFORE
 *  touching the chain or the database, so a misconfigured environment fails at
 *  boot instead of part-way through a backfill with rows already written. */
export async function assertTlshAvailable(): Promise<void> {
  // deterministic, incompressible enough for TLSH to accept: 1 KB of a
  // counter-driven byte pattern. A fixed blob keeps the check free of RNG.
  const probe = new Uint8Array(1024);
  for (let i = 0; i < probe.length; i++) probe[i] = (i * 37 + (i >> 3) * 11) & 0xff;
  const digest = await tlshHash(probe); // throws TlshUnavailableError if broken
  if (!digest) {
    logger.warn("tlsh preflight: CLI ran but refused the probe input — treating as available");
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

/** Source paths are the identity signal (crate name + file tree → lineage,
 *  see sourcetree.ts) and they are SHORT, so a plain longest-N cut drops them.
 *  Drift is the proof: its stored sample of 100 contained not one
 *  `programs/<crate>/src/…` path, so the fork detector had nothing to match
 *  on. Keep these regardless of where they rank by length. */
const SOURCE_PATH_RE = /(?:^|[^a-z0-9_/-])(?:programs?\/[a-z0-9_-]+\/)?src\/[a-z0-9_/-]+?\.rs/i;

/** Printable strings from the bytecode, longest first.
 *
 *  `top` bounds what we persist — the raw set runs to thousands and most of it
 *  is Rust panic boilerplate. Anything matching a source path is exempt from
 *  that bound: those are cheap (tens of bytes) and carry the lineage signal. */
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
  const byLength = [...found].sort((x, y) => y.length - x.length);
  const kept = byLength.slice(0, top);
  const keptSet = new Set(kept);
  // add back any source-path string the length cut discarded
  for (const s of byLength) {
    if (keptSet.has(s)) continue;
    if (SOURCE_PATH_RE.test(s)) kept.push(s);
  }
  return kept;
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

// NOTE: the on-chain IDL fetchers (probeAnchorIdl → probeProgramMetadata,
// fetchAnchorIdl) live in metadata.ts now — they check the Program Metadata
// Program (Anchor ≥1.0) first, then the legacy anchor:idl account above.

// re-export so callers only need one import for loader constants
export { LOADER_PROGRAM_ID };
