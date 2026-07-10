import zlib from "node:zlib";
import bs58 from "bs58";
import { anchorIdlAddress, findProgramAddress, type IdlProbe } from "./fingerprint.js";
import { getMultipleAccountBytes } from "./helius.js";
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
// adoption grows. Layout verified against mainnet (Drift's PMP IDL) 2026-07-09.
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

/** Decode a PMP metadata account's payload to text. Handles the compression
 *  (none/gzip/zlib) and encoding (utf8/base58/base64) header bytes. Returns
 *  null for layouts we don't support (url/external data sources, non-JSON). */
function decodePmpContent(data: Buffer): string | null {
  if (data.length <= PMP_HEADER_LEN || data[0] !== PMP_DISCRIMINATOR_METADATA) return null;
  const encoding = data[83]!;
  const compression = data[84]!;
  const dataSource = data[86]!;
  if (dataSource !== 0) return null; // url/external payloads: not yet supported
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
  return payload.toString("utf8");
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

    let idl: unknown | null = null;
    let idlSource: IdlSource | null = null;
    if (pmpIdlAcc) {
      idl = parseJson(decodePmpContent(pmpIdlAcc));
      if (idl !== null) idlSource = "pmp";
    }
    if (idl === null && legacyAcc) {
      idl = parseJson(decodeLegacyIdl(legacyAcc));
      if (idl !== null) idlSource = "anchor-legacy";
    }

    const security = pmpSecAcc ? parseJson<PmpSecurityMeta>(decodePmpContent(pmpSecAcc)) : null;
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
