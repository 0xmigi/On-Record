import bs58 from "bs58";
import { env } from "./config.js";
import { getSignaturesForAddress } from "./helius.js";
import type { Network } from "./types.js";

// ---------------------------------------------------------------------------
// What a program's transactions actually LOOK like — with no IDL required.
//
// `decodeInstructionUsage` (usage.ts) answers "which named instructions get
// called", and returns null the moment a program publishes no IDL. That is 93%
// of mainnet deploys, i.e. exactly the population worth investigating, so the
// most useful question has been unanswerable on the programs that most need it.
//
// This answers the IDL-free version: how often, how regularly, by whom, with
// what payload shape, and — the important one — whether the program is being
// INVOKED at all.
//
// Both of the analysis errors this codebase has made were caught by looking at
// transaction shape rather than transaction count:
//
//   gator    2,176 txns/day looked like adoption. Every one was byte-identical,
//            one every 39.7 seconds — a publisher on a timer, not users.
//   mayhem   ~1,666 txns/day on a program with zero syscalls. The transactions
//            were the deployer's own BPF-loader close operations sweeping rent;
//            the program was never invoked once.
//
// So `invocationShare` and `cadence` are not extras. They are the two fields
// that stop a usage number from lying, and anything reporting activity should
// read them before it reports a count.
// ---------------------------------------------------------------------------

export interface TrafficSample {
  /** signatures pulled from the program id's history (newest first) */
  signaturesSeen: number;
  /** how many of those were parsed — the API is batched and can drop pages */
  parsed: number;
  /** share of sampled signatures that failed on-chain */
  errorShare: number | null;
  /** wall-clock hours the sample spans; null if the chain returned no times */
  spanHours: number | null;
  /** implied transactions/day over the sampled span */
  perDay: number | null;

  /** median seconds between consecutive transactions (0 = multiple per second) */
  medianGapSeconds: number | null;
  /** share of gaps within ±20% of the median — 1.0 is a metronome */
  regularity: number | null;
  /** true when the cadence is regular enough to be machine-driven */
  looksScheduled: boolean;
  /**
   * Cadence of the single busiest fee payer, measured separately.
   *
   * A program can be busy AND have a metronome inside it: gator ran a publisher
   * writing every 39.7s while unrelated swap traffic flowed through the same
   * program id. Aggregate gaps average that away — the timer is only visible
   * per-payer, which is why this is computed on its own.
   */
  dominantPayer: {
    address: string;
    invocations: number;
    share: number;
    medianGapSeconds: number | null;
    regularity: number | null;
    looksScheduled: boolean;
  } | null;

  /** transactions in which this program was actually executed */
  invocations: number;
  /**
   * invocations / parsed. Below ~0.5 the "activity" is mostly something else
   * happening NEAR the program (loader writes, closes, rent sweeps) rather than
   * anyone using it. This is the field that catches a fake usage number.
   */
  invocationShare: number | null;

  /**
   * Distinct 8-byte leading discriminators, most-used first (hex).
   *
   * Only meaningful for Anchor-style dispatch. A native or Pinocchio program
   * usually switches on the FIRST BYTE, so eight bytes of a one-byte tag plus
   * arguments reads as noise — `leadingBytes` is the right field there, and the
   * caller should prefer it when the program is not Anchor.
   */
  discriminators: { disc: string; count: number; pct: number }[];
  /** first payload byte — the instruction tag under native/Pinocchio dispatch */
  leadingBytes: { byte: string; count: number; pct: number }[];
  /** instruction payload sizes across invocations */
  payload: { min: number; max: number; distinct: number; modalBytes: number | null } | null;
  /** account-list length per invocation */
  accounts: { min: number; max: number } | null;
  /** who pays. One dominant fee payer means one operator, not an audience. */
  topFeePayers: { address: string; count: number; pct: number }[];
}

interface EnhancedIx {
  programId?: string;
  data?: string; // base58
  accounts?: string[];
  innerInstructions?: EnhancedIx[];
}
interface EnhancedTx {
  timestamp?: number;
  feePayer?: string;
  instructions?: EnhancedIx[];
}

async function parseTransactions(signatures: string[]): Promise<EnhancedTx[]> {
  const res = await fetch(`https://api.helius.xyz/v0/transactions?api-key=${env.HELIUS_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactions: signatures }),
  });
  if (!res.ok) throw new Error(`enhanced transactions: HTTP ${res.status}`);
  return (await res.json()) as EnhancedTx[];
}

function median(sorted: number[]): number | null {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * How metronomic a series of gaps is: the share sitting within ±20% of the
 * median. Deliberately not a p90/p10 ratio — on a busy program most gaps are
 * 0 seconds, p10 is 0, and the ratio is undefined exactly when the question
 * matters. A share is defined at every traffic level.
 */
function regularityOf(gaps: number[], med: number | null): number | null {
  if (med === null || gaps.length < 20) return null;
  if (med === 0) return null; // sub-second traffic: cadence is not measurable here
  const band = med * 0.2;
  return gaps.filter((g) => Math.abs(g - med) <= band).length / gaps.length;
}

function cadenceOf(times: number[]): {
  medianGapSeconds: number | null;
  regularity: number | null;
  looksScheduled: boolean;
} {
  const sorted = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]! - sorted[i - 1]!);
  gaps.sort((a, b) => a - b);
  const med = median(gaps);
  const regularity = regularityOf(gaps, med);
  return {
    medianGapSeconds: med,
    regularity: regularity === null ? null : Math.round(regularity * 100) / 100,
    // 80% of intervals inside a ±20% band is not something human-driven traffic
    // does; a publisher on a timer clears it trivially.
    looksScheduled: regularity !== null && regularity >= 0.8,
  };
}

/**
 * Sample a program's recent transactions and describe their shape.
 *
 * `signatures` bounds the cheap half (one RPC page per 1000) and `parse` bounds
 * the metered half (one Helius Enhanced call per 100). Parsing every signature
 * of a busy program is pointless — shape converges long before volume does — so
 * the default parses a 200-transaction slice of a 1000-signature window.
 */
export async function sampleProgramTraffic(
  network: Network,
  programId: string,
  opts: { signatures?: number; parse?: number } = {},
): Promise<TrafficSample | null> {
  const want = Math.min(opts.signatures ?? 1000, 5000);
  const toParse = Math.min(opts.parse ?? 200, 500);

  const sigs: { signature: string; blockTime: number | null; err: boolean }[] = [];
  let before: string | undefined;
  while (sigs.length < want) {
    const page = await getSignaturesForAddress(network, programId, { limit: 1000, before });
    if (!page.length) break;
    for (const s of page) {
      sigs.push({
        signature: s.signature,
        blockTime: s.blockTime ?? null,
        err: Boolean((s as { err?: unknown }).err),
      });
    }
    before = page[page.length - 1]!.signature;
    if (page.length < 1000) break;
  }
  if (!sigs.length) return null;

  // --- cadence, from signature times alone (free — no parsing needed) -------
  const times = sigs.map((s) => s.blockTime).filter((t): t is number => typeof t === "number");
  times.sort((a, b) => a - b);
  const spanSeconds = times.length >= 2 ? times[times.length - 1]! - times[0]! : null;
  const cadence = cadenceOf(times);

  // --- shape, from a parsed slice -------------------------------------------
  const sampled = sigs.slice(0, toParse);
  const discCounts = new Map<string, number>();
  const byteCounts = new Map<string, number>();
  const payerCounts = new Map<string, number>();
  const payerTimes = new Map<string, number[]>();
  const payloadSizes: number[] = [];
  const accountCounts: number[] = [];
  let parsed = 0;
  let invocations = 0;

  const visit = (ix: EnhancedIx): boolean => {
    if (ix.programId !== programId) return false;
    if (ix.accounts) accountCounts.push(ix.accounts.length);
    if (!ix.data) return true; // ran, but carried no payload
    try {
      const bytes = bs58.decode(ix.data);
      payloadSizes.push(bytes.length);
      if (bytes.length >= 1) {
        const b = Buffer.from(bytes.subarray(0, 1)).toString("hex");
        byteCounts.set(b, (byteCounts.get(b) ?? 0) + 1);
      }
      if (bytes.length >= 8) {
        const disc = Buffer.from(bytes.subarray(0, 8)).toString("hex");
        discCounts.set(disc, (discCounts.get(disc) ?? 0) + 1);
      }
    } catch {
      /* undecodable payload — still counts as an invocation */
    }
    return true;
  };

  for (let i = 0; i < sampled.length; i += 100) {
    let txs: EnhancedTx[];
    try {
      txs = await parseTransactions(sampled.slice(i, i + 100).map((s) => s.signature));
    } catch {
      continue; // a dropped batch shrinks the sample; it must not fail the call
    }
    for (const tx of txs) {
      parsed++;
      let ran = false;
      for (const ix of tx.instructions ?? []) {
        if (visit(ix)) ran = true;
        for (const inner of ix.innerInstructions ?? []) if (visit(inner)) ran = true;
      }
      if (ran) {
        invocations++;
        if (tx.feePayer) {
          payerCounts.set(tx.feePayer, (payerCounts.get(tx.feePayer) ?? 0) + 1);
          if (tx.timestamp) {
            const seen = payerTimes.get(tx.feePayer) ?? [];
            seen.push(tx.timestamp);
            payerTimes.set(tx.feePayer, seen);
          }
        }
      }
    }
  }

  const totalDisc = [...discCounts.values()].reduce((a, b) => a + b, 0);
  const totalBytes = [...byteCounts.values()].reduce((a, b) => a + b, 0);

  const payers = [...payerCounts.entries()].sort((a, b) => b[1] - a[1]);
  const top = payers[0];
  const dominantPayer = top
    ? {
        address: top[0],
        invocations: top[1],
        share: invocations ? top[1] / invocations : 0,
        ...cadenceOf(payerTimes.get(top[0]) ?? []),
      }
    : null;

  const modal = payloadSizes.length
    ? [...payloadSizes.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map<number, number>())]
        .sort((a, b) => b[1] - a[1])[0]![0]
    : null;

  return {
    signaturesSeen: sigs.length,
    parsed,
    errorShare: sigs.length ? sigs.filter((s) => s.err).length / sigs.length : null,
    spanHours: spanSeconds !== null ? Math.round((spanSeconds / 3600) * 10) / 10 : null,
    perDay:
      spanSeconds && spanSeconds > 0
        ? Math.round((sigs.length / spanSeconds) * 86_400)
        : null,
    ...cadence,
    dominantPayer,
    invocations,
    invocationShare: parsed ? invocations / parsed : null,
    discriminators: [...discCounts.entries()]
      .map(([disc, count]) => ({ disc, count, pct: totalDisc ? (count / totalDisc) * 100 : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    leadingBytes: [...byteCounts.entries()]
      .map(([byte, count]) => ({ byte, count, pct: totalBytes ? (count / totalBytes) * 100 : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    payload: payloadSizes.length
      ? {
          min: Math.min(...payloadSizes),
          max: Math.max(...payloadSizes),
          distinct: new Set(payloadSizes).size,
          modalBytes: modal,
        }
      : null,
    accounts: accountCounts.length
      ? { min: Math.min(...accountCounts), max: Math.max(...accountCounts) }
      : null,
    topFeePayers: payers
      .map(([address, count]) => ({
        address,
        count,
        pct: invocations ? (count / invocations) * 100 : 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}
