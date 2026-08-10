// Sell the positions back to the bonding curve, and close the emptied token
// accounts to reclaim their rent.
//
//   node client/sell.mjs           simulate everything, send nothing
//   node client/sell.mjs --send    actually sell
//
//   MIN_OUT_PCT   floor as a percentage of the quoted proceeds (default 85)
//   ONLY=<mint>   sell just one position
//
// This does NOT go through the sniper program — that program wraps `buy` only,
// and there is nothing to gate on the way out. It calls pump.fun's `sell_v2`
// directly: 26 accounts, discriminator 5df6823ce7e940b2, args
// (amount, min_sol_output). Layout lifted from a real sell_v2.
//
// The legacy 16-account `sell` does not work on these mints. It fails two ways:
// error 6073 wants a cashback user_volume_accumulator it has no slot for, and
// 6074 wants a `bonding_curve_v2` remaining account. `sell_v2` needs neither —
// the same retirement the buy side already ran into.
//
// The fee recipient obeys the same two-pool rule as the buy side — curve byte
// 81 picks the pool — so the same selection logic applies here.

import {
  Connection, PublicKey, TransactionInstruction, ComputeBudgetProgram,
} from '@solana/web3.js';
import './env.mjs';
import { loadPayer } from './keypair.mjs';
import { prewarm, PUMP, FEE_PROGRAM, SYSTEM, TOKEN } from './lift.mjs';
import { buildSigned, confirm } from './sender.mjs';
import { SystemProgram } from '@solana/web3.js';

const K = process.env.HELIUS_API_KEY;
const RPC = process.env.RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${K}`;
const SEND = process.argv.includes('--send');
const MIN_OUT_PCT = BigInt(process.env.MIN_OUT_PCT ?? 85);
const ONLY = process.env.ONLY ?? null;
// --sweep <address>: after selling, send everything left to that address.
const sweepIdx = process.argv.indexOf('--sweep');
const SWEEP_TO = sweepIdx >= 0 ? process.argv[sweepIdx + 1] : null;
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const conn = new Connection(RPC, 'confirmed');
const { payer } = loadPayer();
const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const ata = (owner, tp, mint) =>
  pda([owner.toBuffer(), tp.toBuffer(), mint.toBuffer()], new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'));
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

const warm = await prewarm(conn, payer.publicKey, { harvest: false });
/// sha256("global:sell_v2")[..8]. The legacy `sell` (16 accounts) is being
/// retired: it now demands a `bonding_curve_v2` remaining account that these
/// mints reject (error 6074), and a cashback accumulator it does not take
/// (6073). `sell_v2` needs neither.
const SELL_DISC = Buffer.from('5df6823ce7e940b2', 'hex');
const ATA_PROG = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * pump.fun `sell_v2`, 26 accounts — the 27-account buy layout with the GLOBAL
 * volume accumulator removed, which makes sense: a sell does not accrue global
 * volume. Everything from index 19 on shifts down by one. Both the shifted
 * accounts were checked against a real sell_v2:
 *   19 = user_volume_accumulator      20 = its wrapped-SOL account
 */
function sellIx({ mint, curve, tokenProgram, feePool, creator, amount, minOut }) {
  const fee = (feePool === 1 ? warm.poolB : warm.poolA)[0];
  const bb = warm.buybackFeeRecipient;
  const user = payer.publicKey;
  const userVolume = pda([Buffer.from('user_volume_accumulator'), user.toBuffer()], PUMP);
  const creatorVault = pda([Buffer.from('creator-vault'), creator.toBuffer()], PUMP);

  const keys = [
    warm.global,                              // 0
    mint,                                     // 1
    WSOL_MINT,                                // 2
    tokenProgram,                             // 3
    TOKEN,                                    // 4
    ATA_PROG,                                 // 5
    fee,                                      // 6
    ata(fee, TOKEN, WSOL_MINT),               // 7
    bb,                                       // 8
    ata(bb, TOKEN, WSOL_MINT),                // 9
    curve,                                    // 10
    ata(curve, tokenProgram, mint),           // 11
    ata(curve, TOKEN, WSOL_MINT),             // 12
    user,                                     // 13
    ata(user, tokenProgram, mint),            // 14
    ata(user, TOKEN, WSOL_MINT),              // 15
    creatorVault,                             // 16
    ata(creatorVault, TOKEN, WSOL_MINT),      // 17
    pda([Buffer.from('sharing-config'), mint.toBuffer()], FEE_PROGRAM),   // 18
    userVolume,                               // 19
    ata(userVolume, TOKEN, WSOL_MINT),        // 20
    pda([Buffer.from('fee_config'), PUMP.toBuffer()], FEE_PROGRAM),       // 21
    FEE_PROGRAM,                              // 22
    SYSTEM,                                   // 23
    pda([Buffer.from('__event_authority')], PUMP),                        // 24
    PUMP,                                     // 25
  ];
  // Same writability pattern as the buy, shifted for the dropped account.
  const writable = new Set([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20]);
  return new TransactionInstruction({
    programId: PUMP,
    keys: keys.map((pubkey, i) => ({ pubkey, isSigner: i === 13, isWritable: writable.has(i) })),
    data: Buffer.concat([SELL_DISC, u64(amount), u64(minOut)]),
  });
}

/** Token-2022 CloseAccount — reclaims the ~0.002 SOL of rent. */
function closeAta(account, tokenProgram) {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

const before = await conn.getBalance(payer.publicKey);
console.log(`payer ${payer.publicKey.toBase58()}  ${(before / 1e9).toFixed(6)} SOL`);
console.log(SEND ? 'MODE: SENDING\n' : 'MODE: simulate only, pass --send to sell\n');

const accounts = await conn.getParsedTokenAccountsByOwner(payer.publicKey, { programId: TOKEN_2022 });
let expected = 0n, sold = 0, failed = 0;

for (const { pubkey, account } of accounts.value) {
  const info = account.data.parsed.info;
  const amount = BigInt(info.tokenAmount.amount);
  const mint = new PublicKey(info.mint);
  if (ONLY && info.mint !== ONLY) continue;
  if (amount === 0n) continue;

  const curve = pda([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP);
  const ci = await conn.getAccountInfo(curve);
  if (!ci) { console.log(`${info.mint}  no curve, skipping`); continue; }
  const vT = ci.data.readBigUInt64LE(8);
  const vQ = ci.data.readBigUInt64LE(16);
  const complete = ci.data[48] !== 0;
  const creator = new PublicKey(ci.data.subarray(49, 81));
  const feePool = ci.data[81];

  if (complete) { console.log(`${info.mint}  curve complete (graduated), sell on the AMM instead`); continue; }

  const quoted = (vQ * amount) / (vT + amount);
  const minOut = (quoted * MIN_OUT_PCT) / 100n;
  expected += quoted;

  const { blockhash } = await conn.getLatestBlockhash();
  const tx = buildSigned(payer, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(process.env.PRIORITY_FEE ?? 200_000) }),
    sellIx({ mint, curve, tokenProgram: TOKEN_2022, feePool, creator, amount, minOut }),
    closeAta(pubkey, TOKEN_2022),
  ], blockhash);

  const label = `${info.mint.slice(0, 12)}…  pool ${feePool === 1 ? 'B' : 'A'}  ` +
    `${info.tokenAmount.uiAmountString} tokens  ->  ~${(Number(quoted) / 1e9).toFixed(6)} SOL`;

  if (!SEND) {
    const sim = await conn.simulateTransaction(tx);
    console.log(`${sim.value.err ? 'WOULD FAIL' : 'ok       '}  ${label}`);
    if (sim.value.err) {
      console.log('    ' + JSON.stringify(sim.value.err));
      console.log((sim.value.logs ?? []).filter((l) => /Error|failed/.test(l)).map((l) => '    ' + l).join('\n'));
      failed++;
    } else sold++;
    continue;
  }

  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const r = await confirm(conn, sig);
    console.log(`${r.landed ? 'SOLD     ' : 'failed   '}  ${label}`);
    console.log(`    ${sig}`);
    if (r.landed) sold++; else { failed++; console.log(`    ${JSON.stringify(r.err)}`); }
  } catch (e) {
    failed++;
    console.log(`failed     ${label}\n    ${e.message}`);
  }
}

let after = await conn.getBalance(payer.publicKey);

// Sweep last, so it carries the sale proceeds and the reclaimed rent with it.
if (SWEEP_TO) {
  const to = new PublicKey(SWEEP_TO);
  // Leave nothing behind: a system account has no rent minimum, but the fee for
  // this very transaction has to come out of the balance being sent.
  const FEE = 5_000;
  const lamports = after - FEE;
  if (lamports <= 0) {
    console.log(`\nnothing to sweep (${after} lamports)`);
  } else if (!SEND) {
    console.log(`\nwould sweep ${(lamports / 1e9).toFixed(6)} SOL to ${to.toBase58()}`);
  } else {
    const { blockhash } = await conn.getLatestBlockhash();
    const tx = buildSigned(payer, [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports }),
    ], blockhash);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const r = await confirm(conn, sig);
    console.log(`\n${r.landed ? 'SWEPT' : 'sweep failed'} ${(lamports / 1e9).toFixed(6)} SOL -> ${to.toBase58()}`);
    console.log(`  ${sig}`);
    after = await conn.getBalance(payer.publicKey);
  }
}

console.log(`\n${SEND ? 'sold' : 'would sell'} ${sold}, failed ${failed}`);
console.log(`quoted proceeds  ~${(Number(expected) / 1e9).toFixed(6)} SOL (before pump.fun's sell fee)`);
console.log(`plus token-account rent reclaimed at ~0.00204 SOL each`);
if (SEND) console.log(`balance ${(before / 1e9).toFixed(6)} -> ${(after / 1e9).toFixed(6)} SOL`);
