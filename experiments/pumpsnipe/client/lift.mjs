// Build pump.fun's buy account list for a mint.
//
// pump.fun runs several buy instructions at once and is migrating between them.
// `buy` (16 accounts per the IDL, 18 in practice) is being retired — it now
// demands a bonding_curve_v2 that doesn't exist for older mints. `buy_v2` and
// `buy_exact_quote_in_v2` take 27 accounts and are fully documented in the
// on-chain IDL, so those we derive rather than guess.
//
// Two strategies, in order of preference:
//   deriveV2   — compute all 27 accounts from the mint. Works for a token that
//                has never traded, which is the whole point of a sniper.
//   liftFromTx — copy the account list off a buy that already succeeded for
//                this mint. Fallback, and useful when pump.fun changes shape
//                again.

import { PublicKey } from '@solana/web3.js';

export const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SYSTEM = new PublicKey('11111111111111111111111111111111');
export const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
export const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/// sha256("global:<name>")[..8], from pump.fun's on-chain IDL.
export const IX = {
  buy:                   Buffer.from('66063d1201daebea', 'hex'),
  buy_v2:                Buffer.from('b817ee6167c5d33d', 'hex'),
  buy_exact_quote_in_v2: Buffer.from('c2ab1c46684d5b2f', 'hex'),
};

/// Where things sit in the 27-account v2 layout.
export const V2 = {
  N: 27,
  BONDING_CURVE: 10,
  USER: 13,
  WRITABLE: [
    false, false, false, false, false, false, true, true, true, true,
    true, true, true, true, true, true, true, true, false, false,
    true, true, false, false, false, false, false,
  ],
};

const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const ata = (owner, tokenProgram, mint) =>
  pda([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM);

/// An owner's wrapped-SOL account. WSOL is always classic SPL Token.
export const wsolAta = (owner) => ata(owner, TOKEN, WSOL);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  const b = Buffer.from(h, 'hex');
  let z = 0;
  for (const c of s) { if (c === '1') z++; else break; }
  return Buffer.concat([Buffer.alloc(z), b]);
}

/**
 * Derive all 27 accounts for pump.fun's v2 buy, from the mint alone.
 * Needs no prior trade, so it works on a token seconds old.
 */
export async function deriveV2(conn, baseMint, user) {
  const global = pda([Buffer.from('global')], PUMP);
  const globalInfo = await conn.getAccountInfo(global);
  if (!globalInfo) throw new Error('pump.fun global config not found');
  const g = globalInfo.data;

  // Global: reserved_fee_recipient at 483, buyback_fee_recipients[8] at 741.
  const feeRecipient = new PublicKey(g.subarray(483, 515));
  const buybackFeeRecipient = new PublicKey(g.subarray(741, 773));

  const bondingCurve = pda([Buffer.from('bonding-curve'), baseMint.toBuffer()], PUMP);
  const curveInfo = await conn.getAccountInfo(bondingCurve);
  if (!curveInfo) throw new Error(`no bonding curve for ${baseMint.toBase58()}`);
  // BondingCurve: creator at 49, quote_mint at 83.
  const creator = new PublicKey(curveInfo.data.subarray(49, 81));
  // quote_mint is only set on curves quoted in a real SPL token. Left unset
  // (all zeroes, which renders as the system program) it means native SOL,
  // and pump.fun's v2 accounts want wrapped SOL in that slot.
  let quoteMint = curveInfo.data.length >= 115
    ? new PublicKey(curveInfo.data.subarray(83, 115))
    : WSOL;
  if (quoteMint.equals(SYSTEM) || quoteMint.equals(new PublicKey(0))) quoteMint = WSOL;

  const baseMintInfo = await conn.getAccountInfo(baseMint);
  const baseTokenProgram = baseMintInfo.owner;
  const quoteMintInfo = await conn.getAccountInfo(quoteMint);
  const quoteTokenProgram = quoteMintInfo && !quoteMintInfo.owner.equals(SYSTEM)
    ? quoteMintInfo.owner : TOKEN;

  const creatorVault = pda([Buffer.from('creator-vault'), creator.toBuffer()], PUMP);
  const userVolume = pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP);

  const keys = [
    global,
    baseMint,
    quoteMint,
    baseTokenProgram,
    quoteTokenProgram,
    ATA_PROGRAM,
    feeRecipient,
    ata(feeRecipient, quoteTokenProgram, quoteMint),
    buybackFeeRecipient,
    ata(buybackFeeRecipient, quoteTokenProgram, quoteMint),
    bondingCurve,
    ata(bondingCurve, baseTokenProgram, baseMint),
    ata(bondingCurve, quoteTokenProgram, quoteMint),
    user,
    ata(user, baseTokenProgram, baseMint),
    ata(user, quoteTokenProgram, quoteMint),
    creatorVault,
    ata(creatorVault, quoteTokenProgram, quoteMint),
    pda([Buffer.from('sharing-config'), baseMint.toBuffer()], FEE_PROGRAM),
    pda([Buffer.from('global_volume_accumulator')], PUMP),
    userVolume,
    ata(userVolume, quoteTokenProgram, quoteMint),
    pda([Buffer.from('fee_config'), PUMP.toBuffer()], FEE_PROGRAM),
    FEE_PROGRAM,
    SYSTEM,
    pda([Buffer.from('__event_authority')], PUMP),
    PUMP,
  ].map((pubkey, i) => ({
    pubkey,
    isSigner: i === V2.USER,
    isWritable: V2.WRITABLE[i],
  }));

  return {
    keys,
    nAccounts: keys.length,
    curveIndex: V2.BONDING_CURVE,
    bondingCurve,
    baseMint,
    quoteMint,
    baseTokenProgram,
    quoteTokenProgram,
    userBaseAta: ata(user, baseTokenProgram, baseMint),
    userQuoteAta: ata(user, quoteTokenProgram, quoteMint),
    via: 'derived',
  };
}

/**
 * Find a fee recipient pair pump.fun will actually accept, by copying one off a
 * buy that already succeeded.
 *
 * There is no fixed offset to read. pump.fun rotates the fee recipient per
 * trade: eight consecutive live buys used six different ones, sitting at Global
 * offsets 41, 194, 226, 322, 580 and 676, with the buyback recipients spread
 * across 805 through 965 on a 32-byte stride. Reading any single offset gets
 * you `NotAuthorized` from fee_recipient.rs as soon as the value there isn't a
 * current member — which is how the previously hardcoded 483 stopped working.
 *
 * So we don't guess the struct. We take the pair out of a transaction the chain
 * has already accepted, which is true by construction, and take both from the
 * same transaction so they're a combination known to work together.
 */
export async function harvestFeeRecipients(conn, { lookback = 200, batch = 6 } = {}) {
  // Most recent pump.fun transactions fail — 22 of 25 in one sample, which is
  // what snipers losing races looks like from the outside. So look back far
  // enough to find a landed buy and fetch in parallel.
  const sigs = (await conn.getSignaturesForAddress(PUMP, { limit: lookback }))
    .filter((s) => !s.err);
  const disc = IX.buy_exact_quote_in_v2.toString('hex');

  const pairFrom = (tx, signature) => {
    if (!tx) return null;
    const msg = tx.transaction.message;
    const keys = [
      ...msg.staticAccountKeys.map((k) => k.toBase58()),
      ...(tx.meta?.loadedAddresses?.writable ?? []).map((k) => k.toBase58()),
      ...(tx.meta?.loadedAddresses?.readonly ?? []).map((k) => k.toBase58()),
    ];
    const inner = (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions);
    for (const ix of [...msg.compiledInstructions, ...inner]) {
      if (keys[ix.programIdIndex] !== PUMP.toBase58()) continue;
      const raw = ix.data instanceof Uint8Array ? Buffer.from(ix.data) : b58decode(ix.data);
      if (raw.subarray(0, 8).toString('hex') !== disc) continue;
      const a = (ix.accountKeyIndexes ?? ix.accounts).map((i) => keys[i]);
      if (a.length < 27) continue;
      return {
        feeRecipient: new PublicKey(a[6]),
        buybackFeeRecipient: new PublicKey(a[8]),
        source: signature,
        slot: tx.slot,
      };
    }
    return null;
  };

  for (let i = 0; i < sigs.length; i += batch) {
    const slice = sigs.slice(i, i + batch);
    const txs = await Promise.all(slice.map((s) => conn.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0, commitment: 'confirmed',
    }).catch(() => null)));
    for (let j = 0; j < txs.length; j++) {
      const hit = pairFrom(txs[j], slice[j].signature);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Read the parts of pump.fun's global config that don't change per launch.
 * Done once at startup so the hot path never touches the network.
 */
export async function prewarm(conn, user, { harvest = true } = {}) {
  const global = pda([Buffer.from('global')], PUMP);
  const info = await conn.getAccountInfo(global);
  if (!info) throw new Error('pump.fun global config not found');

  // pump.fun keeps TWO pools of fee recipients and each launch accepts exactly
  // one of them. Which pool is chosen by a single byte on the bonding curve
  // (offset 81), and that byte is also in the create event, so the choice is
  // free at detection time. Offsets confirmed by locating, in Global, every
  // recipient that appeared in a landed buy:
  //
  //   pool A  162..386 stride 32   used when the flag byte is 0
  //   pool B  516..740 stride 32   used when the flag byte is 1
  //
  // The B array starts at 516, not 484: the key at 484 is rejected, and 772
  // would run into the buyback region that begins at 773. Both bases are
  // confirmed by simulation — A[0]=162 and B[0]=516 each land on a launch of
  // their own kind.
  //
  // Getting this wrong is not a soft failure — pump.fun rejects the whole
  // transaction with NotAuthorized, from fee_recipient.rs:19 if you offered A
  // and it wanted B, or :35 for the reverse.
  const poolAt = (from, to) => {
    const out = [];
    for (let o = from; o <= to; o += 32) {
      const k = new PublicKey(info.data.subarray(o, o + 32));
      if (!k.equals(SYSTEM)) out.push(k);
    }
    return out;
  };
  const poolA = poolAt(162, 386);
  const poolB = poolAt(516, 740);
  if (!poolA.length || !poolB.length) throw new Error('fee recipient pools not found in Global');

  const buybackFeeRecipient = new PublicKey(info.data.subarray(805, 837));
  let feeSource = null;
  // Any member of the right pool is accepted, but prefer one a landed buy has
  // actually used when we can cheaply confirm it.
  const harvested = harvest ? await harvestFeeRecipients(conn).catch(() => null) : null;
  if (harvested) feeSource = harvested.source;
  const feeRecipient = poolA[0];

  const w = {
    feeSource, poolA, poolB,
    global, feeRecipient, buybackFeeRecipient,
    globalVolumeAccumulator: pda([Buffer.from('global_volume_accumulator')], PUMP),
    feeConfig: pda([Buffer.from('fee_config'), PUMP.toBuffer()], FEE_PROGRAM),
    eventAuthority: pda([Buffer.from('__event_authority')], PUMP),
    at: Date.now(),
  };

  // Every PDA that depends only on the config, the buyer and WSOL is the same
  // for every launch in the run. Deriving them once takes eleven of the
  // seventeen hashes out of the hot path; what's left is the six that genuinely
  // depend on the mint. Only valid while the curve is quoted in SOL, which is
  // the overwhelmingly common case — `deriveFromEvent` recomputes otherwise.
  if (user) {
    const userVolume = pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP);
    w.user = user;
    w.sol = {
      userVolume,
      // One recipient per pool, with its token account, so the hot path only
      // picks an index rather than hashing.
      fee: [
        { recipient: poolA[0], ata: ata(poolA[0], TOKEN, WSOL) },
        { recipient: poolB[0], ata: ata(poolB[0], TOKEN, WSOL) },
      ],
      buybackFeeRecipientAta: ata(buybackFeeRecipient, TOKEN, WSOL),
      userQuoteAta: ata(user, TOKEN, WSOL),
      userVolumeAta: ata(userVolume, TOKEN, WSOL),
    };
  }
  return w;
}

/**
 * The hot path. Build all 27 accounts from a decoded CreateEvent and the
 * prewarmed config, with **no RPC calls at all**.
 *
 * `deriveV2` below needs three round trips — global, the curve (for creator
 * and quote mint) and the mint (for its token program). The create event
 * carries all three, so during a race none of them are needed. On a launch
 * that is being contested in the same slot, that is the difference between
 * arriving and not.
 *
 * We can skip reading the curve because the program re-reads it on chain; the
 * client has nothing to check that the gate does not check better.
 */
export function deriveFromEvent(warm, e, user) {
  const baseMint = e.mint;
  const baseTokenProgram = e.baseTokenProgram;
  // Unset quote mint means the curve is quoted in native SOL, and pump.fun's
  // v2 account list wants wrapped SOL in that slot. WSOL is always classic
  // SPL Token, never Token-2022.
  const quoteMint = e.quoteMint.equals(SYSTEM) ? WSOL : e.quoteMint;
  const quoteTokenProgram = TOKEN;

  // Use the prewarmed set when this is an ordinary SOL-quoted curve for the
  // buyer we warmed for; otherwise fall back to deriving them here.
  // Which fee-recipient pool this launch accepts, straight off the event.
  const pool = e.feePool === 1 ? 1 : 0;
  const pre = (warm.sol && warm.user?.equals(user) && quoteMint.equals(WSOL))
    ? warm.sol
    : (() => {
        const uv = pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP);
        const fr = (pool === 1 ? warm.poolB : warm.poolA)[0];
        return {
          userVolume: uv,
          fee: [{ recipient: fr, ata: ata(fr, quoteTokenProgram, quoteMint) }],
          poolOverride: 0,
          buybackFeeRecipientAta: ata(warm.buybackFeeRecipient, quoteTokenProgram, quoteMint),
          userQuoteAta: ata(user, quoteTokenProgram, quoteMint),
          userVolumeAta: ata(uv, quoteTokenProgram, quoteMint),
        };
      })();

  const creatorVault = pda([Buffer.from('creator-vault'), e.creator.toBuffer()], PUMP);
  const bondingCurve = e.bondingCurve;
  const fee = pre.fee[pre.poolOverride !== undefined ? pre.poolOverride : pool];

  const keys = [
    warm.global,
    baseMint,
    quoteMint,
    baseTokenProgram,
    quoteTokenProgram,
    ATA_PROGRAM,
    fee.recipient,
    fee.ata,
    warm.buybackFeeRecipient,
    pre.buybackFeeRecipientAta,
    bondingCurve,
    ata(bondingCurve, baseTokenProgram, baseMint),
    ata(bondingCurve, quoteTokenProgram, quoteMint),
    user,
    ata(user, baseTokenProgram, baseMint),
    pre.userQuoteAta,
    creatorVault,
    ata(creatorVault, quoteTokenProgram, quoteMint),
    pda([Buffer.from('sharing-config'), baseMint.toBuffer()], FEE_PROGRAM),
    warm.globalVolumeAccumulator,
    pre.userVolume,
    pre.userVolumeAta,
    warm.feeConfig,
    FEE_PROGRAM,
    SYSTEM,
    warm.eventAuthority,
    PUMP,
  ].map((pubkey, i) => ({ pubkey, isSigner: i === V2.USER, isWritable: V2.WRITABLE[i] }));

  return {
    keys,
    nAccounts: keys.length,
    curveIndex: V2.BONDING_CURVE,
    bondingCurve, baseMint, quoteMint, baseTokenProgram, quoteTokenProgram,
    userBaseAta: ata(user, baseTokenProgram, baseMint),
    userQuoteAta: pre.userQuoteAta,
    via: 'event',
  };
}

/**
 * Copy the account list off a buy that already succeeded for this mint, and
 * swap in our own buyer. Fallback for when pump.fun changes shape again.
 */
export async function liftFromTx(conn, baseMint, user, { lookback = 40 } = {}) {
  const bondingCurve = pda([Buffer.from('bonding-curve'), baseMint.toBuffer()], PUMP);
  const sigs = await conn.getSignaturesForAddress(bondingCurve, { limit: lookback });

  for (const s of sigs) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0, commitment: 'confirmed',
    });
    if (!tx) continue;
    const msg = tx.transaction.message;
    const keys = [
      ...msg.staticAccountKeys.map((k) => k.toBase58()),
      ...(tx.meta?.loadedAddresses?.writable ?? []).map((k) => k.toBase58()),
      ...(tx.meta?.loadedAddresses?.readonly ?? []).map((k) => k.toBase58()),
    ];
    const inner = (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions);
    for (const ix of [...msg.compiledInstructions, ...inner]) {
      if (keys[ix.programIdIndex] !== PUMP.toBase58()) continue;
      const raw = ix.data instanceof Uint8Array ? Buffer.from(ix.data) : b58decode(ix.data);
      const disc = raw.subarray(0, 8).toString('hex');
      const variant = Object.entries(IX).find(([, d]) => d.toString('hex') === disc)?.[0];
      if (!variant || !variant.endsWith('v2')) continue;

      const addrs = (ix.accountKeyIndexes ?? ix.accounts).map((i) => keys[i]);
      const baseTokenProgram = new PublicKey(addrs[3]);
      const quoteTokenProgram = new PublicKey(addrs[4]);
      const quoteMint = new PublicKey(addrs[2]);
      const userVolume = pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP);
      const swap = {
        13: user,
        14: ata(user, baseTokenProgram, baseMint),
        15: ata(user, quoteTokenProgram, quoteMint),
        20: userVolume,
        21: ata(userVolume, quoteTokenProgram, quoteMint),
      };
      return {
        keys: addrs.map((a, i) => ({
          pubkey: swap[i] ?? new PublicKey(a),
          isSigner: i === V2.USER,
          isWritable: i < V2.WRITABLE.length ? V2.WRITABLE[i] : true,
        })),
        nAccounts: addrs.length,
        curveIndex: V2.BONDING_CURVE,
        bondingCurve, baseMint, quoteMint, baseTokenProgram, quoteTokenProgram,
        userBaseAta: swap[14], userQuoteAta: swap[15],
        via: `lifted:${variant}`,
        source: s.signature,
      };
    }
  }
  throw new Error(`no v2 buy found in the last ${lookback} txns for this mint`);
}
