import { createHash } from "node:crypto";
import bs58 from "bs58";
import { env } from "./config.js";
import { fetchAnchorIdl } from "./metadata.js";
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

  const idl = (await fetchAnchorIdl(network, programId)) as
    | { instructions?: { name?: string; discriminator?: number[] }[] }
    | null;
  const declared = idl?.instructions ?? [];
  if (!declared.length) return null;
  const declaredCount = new Set(declared.map((i) => i.name).filter(Boolean)).size;

  const discToName = new Map<string, string>();
  for (const ix of declared) {
    if (!ix.name) continue;
    if (Array.isArray(ix.discriminator) && ix.discriminator.length === 8) {
      // Anchor ≥0.30: the IDL carries the explicit discriminator
      discToName.set(Buffer.from(ix.discriminator).toString("hex"), ix.name);
    } else {
      // legacy IDL (no discriminator): compute Anchor's from the name. Cover both
      // the name as-is and its snake_case form (IDLs vary in casing).
      for (const variant of new Set([ix.name, toSnakeCase(ix.name)])) {
        discToName.set(anchorDiscriminator(variant), ix.name);
      }
    }
  }
  if (!discToName.size) return null;

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
      const bytes = bs58.decode(ix.data);
      if (bytes.length < 8) return false;
      const name = discToName.get(Buffer.from(bytes.subarray(0, 8)).toString("hex"));
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
