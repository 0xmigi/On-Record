import zlib from "node:zlib";
import bs58 from "bs58";
import { anchorIdlAddress, findProgramAddress, type IdlProbe } from "./fingerprint.js";
import { getMultipleAccountBytes } from "./helius.js";
import { logger } from "./logger.js";
import type { Network } from "./types.js";

// ---------------------------------------------------------------------------
// Unified program-metadata probe. Two on-chain IDL generations coexist:
//
//  1. Program Metadata Program (PMP, `ProgM6JCC…`) — where Anchor ≥1.0.0
//     (Apr 2026) publishes IDLs. Canonical PDA = [program, seed₁₆] under PMP;
//     the "security" seed carries name/logo/contacts as the account-based
//     successor to the embedded security.txt.
//  2. Legacy Anchor IDL account — createWithSeed(base, "anchor:idl", program);
//     what most pre-1.0 programs still have.
//
// One getMultipleAccounts round-trip covers all three candidate accounts —
// cheaper than the old single-account legacy probe, and future-proof as PMP
// adoption grows. Layout verified against mainnet (Drift's PMP IDL) 2026-07-09
// and the program's generated types at a41788e (2026-07-17).
//
// PMP payloads carry a data_source: Direct (inline on-chain) resolves in
// process; Url (an off-chain link) is followed with a guarded fetch so we don't
// drop official metadata that merely lives behind a link. External (a pointer
// to another account) is still skipped. Only canonical (upgrade-authority) PDAs
// are read — third-party/non-canonical metadata is intentionally not surfaced.
// ---------------------------------------------------------------------------

export const PROGRAM_METADATA_PROGRAM_ID = "ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S";

/** PMP seeds are zero-padded to 16 bytes. */
function pmpSeed(seed: string): Uint8Array {
  const out = new Uint8Array(16);
  Buffer.from(seed, "utf8").copy(out);
  return out;
}

/** Canonical PMP metadata PDA for (program, seed) — authority omitted. */
export function pmpCanonicalAddress(programId: string, seed: "idl" | "security"): string {
  const pid = bs58.decode(programId);
  const pmp = bs58.decode(PROGRAM_METADATA_PROGRAM_ID);
  return bs58.encode(findProgramAddress([pid, pmpSeed(seed)], pmp));
}

// --- PMP account decoding ----------------------------------------------------
// Header (96 bytes): disc u8(=2 metadata) · program 32 · authority 32 ·
// mutable u8 · canonical u8 · seed 16 · encoding u8 · compression u8 ·
// format u8 · dataSource u8 · dataLength u32le · 5 reserved. Payload at 96.

const PMP_HEADER_LEN = 96;
const PMP_DISCRIMINATOR_METADATA = 2;

// data_source byte (offset 86): 0=Direct (inline on-chain), 1=Url (payload is
// an off-chain link), 2=External (pointer to another account). Verified against
// the program's generated DataSource enum at a41788e (2026-07-17).
const DATA_SOURCE_DIRECT = 0;
const DATA_SOURCE_URL = 1;

/** Off-chain content following the URL data source. Guarded: https/http only,
 *  short timeout, and a size cap so a hostile or huge link can't stall or bloat
 *  ingestion. Returns null on any failure — the program just loses this signal. */
const URL_FETCH_TIMEOUT_MS = 5000;
const URL_MAX_BYTES = 2 * 1024 * 1024; // IDLs run to a few hundred KB; 2MB is slack

async function fetchOffchainContent(url: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
      headers: { accept: "application/json, text/plain, */*" },
    });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > URL_MAX_BYTES) return null;
    const text = await res.text();
    if (text.length > URL_MAX_BYTES) return null;
    return text;
  } catch (err) {
    logger.warn({ url, err: String(err) }, "pmp off-chain metadata fetch failed");
    return null;
  }
}

/** Decode a PMP metadata account header + payload. Handles compression
 *  (none/gzip/zlib) and encoding (utf8/base58/base64), returning the decoded
 *  text alongside the data_source so the caller knows whether that text is the
 *  content itself (Direct) or a link to follow (Url). Returns null for the
 *  External data source (account pointer — not supported). */
function decodePmpPayload(data: Buffer): { text: string; dataSource: number } | null {
  if (data.length <= PMP_HEADER_LEN || data[0] !== PMP_DISCRIMINATOR_METADATA) return null;
  const encoding = data[83]!;
  const compression = data[84]!;
  const dataSource = data[86]!;
  if (dataSource !== DATA_SOURCE_DIRECT && dataSource !== DATA_SOURCE_URL) return null; // External: unsupported
  const declaredLen = data.readUInt32LE(87);
  const end =
    declaredLen > 0 && PMP_HEADER_LEN + declaredLen <= data.length
      ? PMP_HEADER_LEN + declaredLen
      : data.length;
  let payload: Buffer = data.subarray(PMP_HEADER_LEN, end);
  if (compression === 1) payload = zlib.gunzipSync(payload);
  else if (compression === 2) payload = zlib.inflateSync(payload);
  if (encoding === 2) payload = Buffer.from(bs58.decode(payload.toString("ascii")));
  else if (encoding === 3) payload = Buffer.from(payload.toString("ascii"), "base64");
  return { text: payload.toString("utf8"), dataSource };
}

/** Decode a PMP metadata account to its final text content, following the URL
 *  data source off-chain when needed. Direct payloads resolve synchronously
 *  in-process; Url payloads incur one guarded off-chain fetch. */
async function resolvePmpContent(data: Buffer): Promise<string | null> {
  const decoded = decodePmpPayload(data);
  if (!decoded) return null;
  if (decoded.dataSource === DATA_SOURCE_URL) return fetchOffchainContent(decoded.text.trim());
  return decoded.text;
}

/** Legacy Anchor IdlAccount: 8-byte discriminator + 32-byte authority +
 *  u32 len + zlib-deflated JSON. */
function decodeLegacyIdl(data: Buffer): string | null {
  if (data.length < 44) return null;
  const len = data.readUInt32LE(40);
  if (len === 0 || 44 + len > data.length) return null;
  return zlib.inflateSync(data.subarray(44, 44 + len)).toString("utf8");
}

// --- The probe ----------------------------------------------------------------

export type IdlSource = "pmp" | "anchor-legacy";

/** The PMP "security" seed content — the developer's own account-based
 *  metadata (name, logo, contacts…). Shape follows the PMP standard; kept
 *  loose because it's third-party JSON. */
export interface PmpSecurityMeta {
  name?: string;
  logo?: string;
  description?: string;
  contacts?: string;
  policy?: string;
  source_code?: string;
  auditors?: string;
  [key: string]: unknown;
}

export interface ProgramMetadata {
  idl: unknown | null;
  idlSource: IdlSource | null;
  security: PmpSecurityMeta | null;
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Fetch every on-chain metadata account a program can have — PMP idl, PMP
 *  security, legacy Anchor IDL — in ONE RPC round-trip. PMP wins over legacy. */
export async function fetchProgramMetadata(
  network: Network,
  programId: string,
): Promise<ProgramMetadata> {
  try {
    const [pmpIdlAcc, pmpSecAcc, legacyAcc] = await getMultipleAccountBytes(network, [
      pmpCanonicalAddress(programId, "idl"),
      pmpCanonicalAddress(programId, "security"),
      anchorIdlAddress(programId),
    ]);

    // Resolve both PMP accounts in parallel — either may follow a URL off-chain.
    const [pmpIdlText, pmpSecText] = await Promise.all([
      pmpIdlAcc ? resolvePmpContent(pmpIdlAcc) : Promise.resolve(null),
      pmpSecAcc ? resolvePmpContent(pmpSecAcc) : Promise.resolve(null),
    ]);

    let idl: unknown | null = null;
    let idlSource: IdlSource | null = null;
    if (pmpIdlText) {
      idl = parseJson(pmpIdlText);
      if (idl !== null) idlSource = "pmp";
    }
    if (idl === null && legacyAcc) {
      idl = parseJson(decodeLegacyIdl(legacyAcc));
      if (idl !== null) idlSource = "anchor-legacy";
    }

    const security = pmpSecText ? parseJson<PmpSecurityMeta>(pmpSecText) : null;
    return { idl, idlSource, security };
  } catch {
    return { idl: null, idlSource: null, security: null };
  }
}

/** Summarized probe for the fingerprint stage: instruction/account names
 *  (same shape the old legacy-only probe produced) + source + security meta. */
export interface MetadataProbe {
  idl: IdlProbe | null;
  idlSource: IdlSource | null;
  security: PmpSecurityMeta | null;
}

/** Fetch the FULL on-chain IDL JSON (instructions, args, accounts, types,
 *  events, errors), PMP-first with legacy-Anchor fallback. Same name and
 *  signature as the old legacy-only fetcher — existing callers (the /idl
 *  route, instruction-usage decoding) pick up PMP support transparently. */
export async function fetchAnchorIdl(network: Network, programId: string): Promise<unknown | null> {
  return (await fetchProgramMetadata(network, programId)).idl;
}

export async function probeProgramMetadata(
  network: Network,
  programId: string,
): Promise<MetadataProbe> {
  const md = await fetchProgramMetadata(network, programId);
  const idl = md.idl as { instructions?: { name?: string }[]; accounts?: { name?: string }[] } | null;
  return {
    idl: idl
      ? {
          instructions: (idl.instructions ?? []).map((i) => i.name ?? "").filter(Boolean).slice(0, 64),
          accounts: (idl.accounts ?? []).map((a) => a.name ?? "").filter(Boolean).slice(0, 64),
        }
      : null,
    idlSource: md.idlSource,
    security: md.security,
  };
}
