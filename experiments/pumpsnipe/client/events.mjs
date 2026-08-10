// pump.fun's CreateEvent, read straight out of the transaction logs.
//
// Every pump.fun launch emits an Anchor event as a `Program data:` log line.
// That line carries the mint, the bonding curve, the creator, the base token
// program and the quote mint — which is everything needed to build the buy.
//
// This matters more than it sounds. The obvious way to find the mint is to see
// the create, then call getTransaction for the account list. That round trip
// measured 36–132 ms against Helius, and it happens at the exact moment the
// race is being decided. Reading it out of the log costs nothing.
//
// Layout was recovered by decoding live events, not from the IDL. Verified
// against three mainnet launches: the curve in the event equals the curve
// derived from the mint in every case, which is a free consistency check we
// keep at runtime — see `decodeCreateEvent`.

import { PublicKey } from '@solana/web3.js';

/// sha256("event:CreateEvent")[..8].
export const CREATE_EVENT_DISC = Buffer.from('1b72a94ddeeb6376', 'hex');
/// sha256("event:TradeEvent")[..8].
export const TRADE_EVENT_DISC = Buffer.from('bddb7fd34ee661ee', 'hex');

const PREFIX = 'Program data: ';

/**
 * Decode a `Program data:` log line into a launch, or return null if it isn't
 * a CreateEvent or doesn't decode cleanly.
 *
 * Field offsets after the three variable-length strings:
 *   mint, bondingCurve, user, creator     4 x 32
 *   timestamp, vToken, vQuote,
 *     realToken, totalSupply             5 x u64
 *   baseTokenProgram                          32
 *   two flag bytes                             2
 *   quoteMint                                 32
 *   one more u64                               8
 */
export function decodeCreateEvent(line) {
  if (!line.startsWith(PREFIX)) return null;
  let b;
  try {
    b = Buffer.from(line.slice(PREFIX.length), 'base64');
  } catch {
    return null;
  }
  if (b.length < 8 || !b.subarray(0, 8).equals(CREATE_EVENT_DISC)) return null;

  try {
    let o = 8;
    const str = () => {
      const n = b.readUInt32LE(o);
      o += 4;
      if (n > 512 || o + n > b.length) throw new Error('bad string length');
      const s = b.subarray(o, o + n).toString('utf8');
      o += n;
      return s;
    };
    const key = () => {
      const k = new PublicKey(b.subarray(o, o + 32));
      o += 32;
      return k;
    };
    const u64 = () => {
      const v = b.readBigUInt64LE(o);
      o += 8;
      return v;
    };

    const name = str();
    const symbol = str();
    const uri = str();
    const mint = key();
    const bondingCurve = key();
    const user = key();
    const creator = key();
    const timestamp = u64();
    const virtualTokenReserves = u64();
    const virtualQuoteReserves = u64();
    const realTokenReserves = u64();
    const tokenTotalSupply = u64();
    const baseTokenProgram = key();
    // The first of these two bytes selects which pool of fee recipients
    // pump.fun will accept for this launch: 0 -> array A, 1 -> array B. It is
    // the same byte as offset 81 on the bonding curve (verified 6/6 against
    // live launches), which is what makes the pool knowable at detection time
    // rather than after a round trip. The second byte varies independently and
    // has no bearing on the pool.
    const feePool = b[o];
    o += 2;
    const quoteMint = key();

    return {
      name, symbol, uri,
      mint, bondingCurve, user, creator,
      timestamp,
      virtualTokenReserves, virtualQuoteReserves, realTokenReserves, tokenTotalSupply,
      baseTokenProgram, quoteMint, feePool,
    };
  } catch {
    // A layout change lands here. Better to miss a launch than to fire at a
    // misparse — see `launchFromLogs`, which drops anything that fails.
    return null;
  }
}

/**
 * Decode a TradeEvent. Layout confirmed against the bonding curve account:
 * `virtualSolReserves` and `virtualTokenReserves` read back byte-identical to
 * the curve on launches where nobody else had bought yet.
 *
 *   8   discriminator
 *   32  mint
 *   8   solAmount        8   tokenAmount      1  isBuy
 *   32  user             8   timestamp
 *   8   virtualSolReserves                    8  virtualTokenReserves
 */
export function decodeTradeEvent(line) {
  if (!line.startsWith(PREFIX)) return null;
  let b;
  try {
    b = Buffer.from(line.slice(PREFIX.length), 'base64');
  } catch {
    return null;
  }
  if (b.length < 113 || !b.subarray(0, 8).equals(TRADE_EVENT_DISC)) return null;
  try {
    return {
      mint: new PublicKey(b.subarray(8, 40)),
      solAmount: b.readBigUInt64LE(40),
      tokenAmount: b.readBigUInt64LE(48),
      isBuy: b[56] !== 0,
      user: new PublicKey(b.subarray(57, 89)),
      virtualQuoteReserves: b.readBigUInt64LE(97),
      virtualTokenReserves: b.readBigUInt64LE(105),
    };
  } catch {
    return null;
  }
}

/**
 * Pull the launch out of a transaction's log lines.
 *
 * Most creators buy their own token in the same transaction that creates it —
 * measured at 3 of 4 live launches, in sizes from 0.5 to 12.8 SOL. That buying
 * is atomic with the create and cannot be raced by anyone, so the curve is
 * already past its starting point the instant it becomes visible.
 *
 * So the launch reports two different things:
 *   `virtualQuoteReserves`  where the curve was defined to start
 *   `baseQuoteReserves`     where it actually stood once the create
 *                           transaction finished — the first state anyone
 *                           could possibly trade against
 * The gate is measured against the second. Measured against the first it would
 * reject nearly every launch on account of buying nobody could have beaten.
 *
 * Returns null unless the create event decodes AND the bonding curve it claims
 * is the one the mint derives to — the guard against pump.fun shifting the
 * layout under us. A shifted field yields a mismatched curve and we skip the
 * launch rather than build a transaction around garbage.
 */
export function launchFromLogs(logs, pumpProgram) {
  let create = null;
  const trades = [];
  for (const line of logs) {
    if (!line.startsWith(PREFIX)) continue;
    if (!create) {
      const c = decodeCreateEvent(line);
      if (c) { create = c; continue; }
    }
    const t = decodeTradeEvent(line);
    if (t) trades.push(t);
  }
  if (!create) return null;

  const derived = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), create.mint.toBuffer()], pumpProgram)[0];
  if (!derived.equals(create.bondingCurve)) return null;

  // Only trades against this mint count; a create transaction can in principle
  // carry others.
  const own = trades.filter((t) => t.mint.equals(create.mint));
  const last = own[own.length - 1] ?? null;
  const devBuyLamports = own
    .filter((t) => t.isBuy)
    .reduce((a, t) => a + t.solAmount, 0n);

  return {
    ...create,
    devBuyLamports,
    bundledTrades: own.length,
    baseQuoteReserves: last?.virtualQuoteReserves ?? create.virtualQuoteReserves,
    baseTokenReserves: last?.virtualTokenReserves ?? create.virtualTokenReserves,
  };
}
