import { createHash } from "node:crypto";
import bs58 from "bs58";
import { env } from "./config.js";
import { fetchAnchorIdl, normalizeIdl } from "./metadata.js";
import { getSignaturesForAddress } from "./helius.js";
import type { Network } from "./types.js";

/** camelCase / PascalCase → snake_case (the name Anchor hashes for the discriminator). */
function toSnakeCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** Anchor's instruction discriminator = first 8 bytes of sha256("global:<name>"). */
function anchorDiscriminator(name: string): string {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");
}

// --- discriminator matchers ---------------------------------------------------
// Anchor tags an instruction with 8 bytes at offset 0. Codama does not: it
// describes the tag structurally — a `fieldDiscriminatorNode` naming an
// argument, whose declared width, endianness and constant default give the
// bytes, at an explicit offset. That is usually a single u8 (Pinocchio-style
// tag dispatch), so a fixed 8-byte prefix match would never fire. Both dialects
// reduce to the same thing: expected bytes at an offset.
// ---------------------------------------------------------------------------

interface DiscMatcher {
  offset: number;
  hex: string;
  name: string;
}

const NUM_WIDTH: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8 };

/** Anchor emits events by CPI-ing the program into ITSELF with this 8-byte tag
 *  and the serialized event as payload. It shows up as an inner instruction on
 *  the program, but it is not an instruction call and no IDL declares it — so
 *  tallying it as an unknown discriminator overstates how much of the traffic
 *  we failed to decode. Observed on the Foundation's subscriptions program:
 *  7 of 22 sampled instructions were exactly this. */
const ANCHOR_EVENT_CPI_DISC = "e445a52e51cb9a1d";

/** Encode a Codama numeric discriminator constant to its on-the-wire bytes. */
function encodeNumber(value: number, format: string, endian: string): string | null {
  const width = NUM_WIDTH[format];
  if (!width || !Number.isFinite(value) || value < 0) return null;
  const buf = Buffer.alloc(width);
  try {
    if (width === 8) {
      if (endian === "be") buf.writeBigUInt64BE(BigInt(value));
      else buf.writeBigUInt64LE(BigInt(value));
    } else if (endian === "be") {
      buf.writeUIntBE(value, 0, width);
    } else {
      buf.writeUIntLE(value, 0, width);
    }
  } catch {
    return null; // value doesn't fit the declared width
  }
  return buf.toString("hex");
}

/** Codama: resolve one instruction's discriminator nodes to byte matchers. */
function codamaMatchers(ix: Record<string, unknown>, name: string): DiscMatcher[] {
  const out: DiscMatcher[] = [];
  const args = Array.isArray(ix.arguments) ? (ix.arguments as Record<string, unknown>[]) : [];
  const discs = Array.isArray(ix.discriminators) ? (ix.discriminators as Record<string, unknown>[]) : [];
  for (const d of discs) {
    if (d?.kind !== "fieldDiscriminatorNode" || typeof d.name !== "string") continue;
    const arg = args.find((a) => a?.name === d.name);
    const dv = arg?.defaultValue as { kind?: string; number?: unknown } | undefined;
    const type = arg?.type as { kind?: string; format?: unknown; endian?: unknown } | undefined;
    if (dv?.kind !== "numberValueNode" || typeof dv.number !== "number") continue;
    if (type?.kind !== "numberTypeNode" || typeof type.format !== "string") continue;
    const hex = encodeNumber(dv.number, type.format, typeof type.endian === "string" ? type.endian : "le");
    if (!hex) continue;
    out.push({ offset: typeof d.offset === "number" ? d.offset : 0, hex, name });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Instruction usage — the program's real "shape". Every Anchor instruction
// starts with an 8-byte discriminator, and the IDL lists the discriminator for
// each instruction. So we decode recent transactions against the IDL and tally
// which instructions actually get called: 100% deterministic (the names are the
// developer's, the counts are on-chain), no inference. See the experiment on
// voltr-vault: 84% of activity was one instruction, 20/28 never called.
// ---------------------------------------------------------------------------

export interface InstructionUsage {
  /** newest→oldest span the sample covers */
  window: {
    txnsSampled: number;
    txnsWithProgram: number;
    totalCalls: number;
    hoursSpan: number | null;
  };
  instructions: { name: string; count: number; pct: number }[]; // desc by count
  unusedCount: number; // IDL instructions never seen in the window
  totalInstructions: number; // instructions the IDL declares
  unknownDisc: number; // calls whose discriminator matched no IDL instruction
}

interface EnhancedIx {
  programId?: string;
  data?: string; // base58
  innerInstructions?: EnhancedIx[];
}
interface EnhancedTx {
  timestamp?: number;
  instructions?: EnhancedIx[];
}

/** Helius Enhanced Transactions API — parses up to 100 signatures per call and
 *  returns each instruction's raw base58 `data` (which carries the discriminator). */
async function parseTransactions(signatures: string[]): Promise<EnhancedTx[]> {
  const res = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${env.HELIUS_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactions: signatures }),
  });
  if (!res.ok) throw new Error(`enhanced transactions: HTTP ${res.status}`);
  return (await res.json()) as EnhancedTx[];
}

/** Decode which instructions of `programId` got called across its recent txns. */
export async function decodeInstructionUsage(
  network: Network,
  programId: string,
  opts: { sample?: number } = {},
): Promise<InstructionUsage | null> {
  const sample = Math.min(opts.sample ?? 400, 1000);

  const idl = normalizeIdl(await fetchAnchorIdl(network, programId));
  const declared = (idl?.instructions ?? []) as Record<string, unknown>[];
  if (!declared.length) return null;
  const declaredCount = new Set(
    declared.map((i) => i.name).filter((n): n is string => typeof n === "string"),
  ).size;

  const matchers: DiscMatcher[] = [];
  for (const ix of declared) {
    const name = typeof ix.name === "string" ? ix.name : null;
    if (!name) continue;
    if (idl!.standard === "codama") {
      matchers.push(...codamaMatchers(ix, name));
      continue;
    }
    const disc = ix.discriminator;
    if (Array.isArray(disc) && disc.length === 8) {
      // Anchor ≥0.30: the IDL carries the explicit discriminator
      matchers.push({ offset: 0, hex: Buffer.from(disc as number[]).toString("hex"), name });
    } else {
      // legacy IDL (no discriminator): compute Anchor's from the name. Cover both
      // the name as-is and its snake_case form (IDLs vary in casing).
      for (const variant of new Set([name, toSnakeCase(name)])) {
        matchers.push({ offset: 0, hex: anchorDiscriminator(variant), name });
      }
    }
  }
  if (!matchers.length) return null;

  // group by the window the tag occupies, so tallying reads each window once
  // rather than walking every matcher per instruction
  const windows = new Map<string, { offset: number; bytes: number; byHex: Map<string, string> }>();
  for (const m of matchers) {
    const bytes = m.hex.length / 2;
    const key = `${m.offset}:${bytes}`;
    let w = windows.get(key);
    if (!w) windows.set(key, (w = { offset: m.offset, bytes, byHex: new Map() }));
    w.byHex.set(m.hex, m.name);
  }
  // widest window first: a specific 8-byte discriminator must win over a 1-byte
  // tag that happens to share its leading byte
  const ordered = [...windows.values()].sort((a, b) => b.bytes - a.bytes);

  // recent signatures (newest first), successful only
  const sigs: string[] = [];
  let before: string | undefined;
  while (sigs.length < sample) {
    const page = await getSignaturesForAddress(network, programId, { limit: 1000, before });
    if (!page.length) break;
    sigs.push(...page.filter((s) => !("err" in s) || !(s as { err?: unknown }).err).map((s) => s.signature));
    before = page[page.length - 1]!.signature;
    if (page.length < 1000) break;
  }
  const sampled = sigs.slice(0, sample);
  if (!sampled.length) return null;

  const counts = new Map<string, number>();
  let unknownDisc = 0;
  let txnsWithProgram = 0;
  let newest: number | null = null;
  let oldest: number | null = null;

  const tally = (ix: EnhancedIx): boolean => {
    if (ix.programId !== programId || !ix.data) return false;
    try {
      const bytes = Buffer.from(bs58.decode(ix.data));
      // an event emission, not a call — neither counted nor held against us
      if (bytes.subarray(0, 8).toString("hex") === ANCHOR_EVENT_CPI_DISC) return false;
      let name: string | undefined;
      for (const w of ordered) {
        if (bytes.length < w.offset + w.bytes) continue;
        name = w.byHex.get(bytes.subarray(w.offset, w.offset + w.bytes).toString("hex"));
        if (name) break;
      }
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      else unknownDisc++;
      return Boolean(name);
    } catch {
      return false;
    }
  };

  for (let i = 0; i < sampled.length; i += 100) {
    let txs: EnhancedTx[];
    try {
      txs = await parseTransactions(sampled.slice(i, i + 100));
    } catch {
      continue;
    }
    for (const tx of txs) {
      if (tx.timestamp) {
        newest = newest ? Math.max(newest, tx.timestamp) : tx.timestamp;
        oldest = oldest ? Math.min(oldest, tx.timestamp) : tx.timestamp;
      }
      let touched = false;
      for (const ix of tx.instructions ?? []) {
        if (tally(ix)) touched = true;
        for (const inner of ix.innerInstructions ?? []) if (tally(inner)) touched = true;
      }
      if (touched) txnsWithProgram++;
    }
  }

  const totalCalls = [...counts.values()].reduce((a, b) => a + b, 0);
  const instructions = [...counts.entries()]
    .map(([name, count]) => ({ name, count, pct: totalCalls ? (count / totalCalls) * 100 : 0 }))
    .sort((a, b) => b.count - a.count);

  return {
    window: {
      txnsSampled: sampled.length,
      txnsWithProgram,
      totalCalls,
      hoursSpan: newest && oldest ? Math.round((newest - oldest) / 3600) : null,
    },
    instructions,
    unusedCount: Math.max(0, declaredCount - instructions.length),
    totalInstructions: declaredCount,
    unknownDisc,
  };
}
