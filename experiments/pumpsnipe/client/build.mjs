// Building the snipe transaction. Shared by the live runner and the fork test,
// so what gets verified is exactly what gets fired.

import {
  PublicKey, TransactionInstruction, ComputeBudgetProgram,
} from '@solana/web3.js';
import { deriveFromEvent, IX, ATA_PROGRAM, SYSTEM } from './lift.mjs';
import { buildSigned, tipInstruction } from './sender.mjs';

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

/**
 * Curves do not all start from the same virtual reserve — mainnet shows both
 * 30 SOL and 4.292 SOL starting points — so the gate has to be relative rather
 * than absolute. A fixed threshold would reject every 30 SOL curve outright and
 * wave through a 7x move on a 4.292 SOL one.
 *
 * Relative to what is the part that matters. Most creators buy their own token
 * inside the create transaction, so the curve is already past its nominal start
 * before anyone else can act. Gating against the nominal start would reject
 * those launches for losing a race that was never run. We gate against
 * `baseQuoteReserves` — the curve as it stood when the create transaction
 * finished — so the gate measures only buying we could actually have been
 * beaten by.
 */
export function gateFor(e, gateLamports) {
  return e.baseQuoteReserves + gateLamports;
}

/**
 * Price the floor at the worst fill the gate still allows, not at the curve as
 * it was at launch. Constant product: if the curve is allowed to move to
 * `gate`, the token side has fallen to k/gate by then. Quoting off the launch
 * reserves instead would set a floor we cannot meet whenever anyone bought
 * ahead of us, and pump.fun's own slippage bound would reject the trade before
 * our gate got the chance.
 */
export function minTokensOut(e, gate, lamportsIn, slippagePct = 70n) {
  const k = e.baseTokenReserves * e.baseQuoteReserves;
  const tokensAtGate = k / gate;
  const quoted = (tokensAtGate * lamportsIn) / (gate + lamportsIn);
  return (quoted * slippagePct) / 100n;
}

export const createAta = (payer, owner, ataAddr, mint, tokenProgram) => new TransactionInstruction({
  programId: ATA_PROGRAM,
  keys: [
    { pubkey: payer,        isSigner: true,  isWritable: true  },
    { pubkey: ataAddr,      isSigner: false, isWritable: true  },
    { pubkey: owner,        isSigner: false, isWritable: false },
    { pubkey: mint,         isSigner: false, isWritable: false },
    { pubkey: SYSTEM,       isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ],
  data: Buffer.from([1]), // CreateIdempotent
});

/**
 * Build and sign the whole thing.
 *
 * Instruction order matters to the cost of losing. The gate is checked inside
 * the snipe instruction, and a failing instruction aborts the transaction, so
 * everything after it is rolled back — including the tip. Putting the tip last
 * means a lost race costs the fee only.
 */
export function buildSnipe({
  warm, launch, payer, programId, lamportsIn, gateLamports,
  priorityFee, tipLamports, computeUnits = 250_000, blockhash, sign = true,
}) {
  const gate = gateFor(launch, gateLamports);
  const acc = deriveFromEvent(warm, launch, payer.publicKey);
  const pumpData = Buffer.concat([
    IX.buy_exact_quote_in_v2,
    u64(lamportsIn),
    u64(minTokensOut(launch, gate, lamportsIn)),
  ]);
  const data = Buffer.concat([Buffer.from([acc.curveIndex]), u64(gate), pumpData]);

  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
    createAta(payer.publicKey, payer.publicKey, acc.userBaseAta, acc.baseMint, acc.baseTokenProgram),
    createAta(payer.publicKey, payer.publicKey, acc.userQuoteAta, acc.quoteMint, acc.quoteTokenProgram),
    new TransactionInstruction({ programId, keys: acc.keys, data }),
  ];
  if (tipLamports > 0n) ixs.push(tipInstruction(payer.publicKey, tipLamports));

  return { acc, gate, ixs, tx: buildSigned(payer, ixs, blockhash) };
}

/** Names for the program's custom errors, for readable failures. */
export const ERRORS = {
  1: 'BAD_IX_DATA',
  2: 'BAD_ACCOUNT_COUNT',
  3: 'CURVE_NOT_OWNED_BY_PUMP',
  4: 'CURVE_TOO_SMALL',
  5: 'NOT_A_BONDING_CURVE',
  6: 'CURVE_COMPLETE',
  7: 'LOST_THE_RACE',
  8: 'CURVE_DRAINED',
  9: 'NO_PUMP_ACCOUNT',
  10: 'CURVE_INDEX_OUT_OF_RANGE',
};
