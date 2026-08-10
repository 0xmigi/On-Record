// pumpsnipe client — derives every pump.fun account and fires one snipe.
//
// Usage:
//   node client/snipe.mjs <mint> <solIn> <maxVirtualQuoteReserves>
//
// solIn is in SOL. maxVirtualQuoteReserves is the freshness gate: the trade
// reverts unless the curve has seen less than that much buying pressure.
// Pass 0 for the gate to force the "lost the race" path.

import fs from 'node:fs';
import os from 'node:os';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SNIPE_PROGRAM = new PublicKey(
  fs.readFileSync(new URL('../Anchor.toml', import.meta.url), 'utf8').match(/pumpsnipe = "([^"]+)"/)[1]
);

// sha256("global:snipe")[..8] — anchor's discriminator for our instruction
const SNIPE_IX = Buffer.from('8aa9c0be430429f9', 'hex');

const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

const [, , mintArg, solArg = '0.01', gateArg] = process.argv;
if (!mintArg) { console.error('usage: node client/snipe.mjs <mint> [solIn] [maxVirtualQuoteReserves]'); process.exit(1); }

const conn = new Connection(RPC, 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, 'utf8'))));
const mint = new PublicKey(mintArg);
const lamportsIn = Math.floor(Number(solArg) * 1e9);

// --- read the live bonding curve -------------------------------------------
const bondingCurve = pda([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP);
const curveInfo = await conn.getAccountInfo(bondingCurve);
if (!curveInfo) throw new Error(`no bonding curve for ${mintArg}`);
const cd = curveInfo.data;
const virtualTokenReserves = cd.readBigUInt64LE(8);
const virtualQuoteReserves = cd.readBigUInt64LE(16);
const complete = cd[48] !== 0;
const creator = new PublicKey(cd.subarray(49, 81));

// constant-product quote, matching pump.fun's own maths, then a 20% cushion
// on max_sol_cost so honest price drift doesn't trip pump.fun's own bound.
const amount = (virtualTokenReserves * BigInt(lamportsIn)) / (virtualQuoteReserves + BigInt(lamportsIn));
const maxSolCost = BigInt(Math.floor(lamportsIn * 1.2));
const gate = gateArg !== undefined ? BigInt(gateArg) : virtualQuoteReserves;

console.log('curve      ', bondingCurve.toBase58());
console.log('complete   ', complete);
console.log('vTokenRes  ', virtualTokenReserves.toString());
console.log('vQuoteRes  ', virtualQuoteReserves.toString(), '(buying pressure so far)');
console.log('gate       ', gate.toString(), gate < virtualQuoteReserves ? '<-- below the curve, expect LostTheRace' : '');
console.log('buying     ', amount.toString(), 'tokens for <=', maxSolCost.toString(), 'lamports');

// --- derive every account pump.fun's buy wants ------------------------------
const global = pda([Buffer.from('global')], PUMP);
const globalInfo = await conn.getAccountInfo(global);
const feeRecipient = new PublicKey(globalInfo.data.subarray(8 + 1 + 32, 8 + 1 + 32 + 32));

// pump.fun mints can be classic SPL or Token-2022 — the ATA seeds and the
// token_program account both have to follow whichever one owns this mint.
const mintInfo = await conn.getAccountInfo(mint);
const TOKEN_PROGRAM = mintInfo.owner;
console.log('tokenProg  ', TOKEN_PROGRAM.toBase58());
const ata = (owner) => pda([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
const accounts = [
  { pubkey: global,                                            isSigner: false, isWritable: false },
  { pubkey: feeRecipient,                                      isSigner: false, isWritable: true  },
  { pubkey: mint,                                              isSigner: false, isWritable: false },
  { pubkey: bondingCurve,                                      isSigner: false, isWritable: true  },
  { pubkey: ata(bondingCurve),                                 isSigner: false, isWritable: true  },
  { pubkey: ata(payer.publicKey),                              isSigner: false, isWritable: true  },
  { pubkey: payer.publicKey,                                   isSigner: true,  isWritable: true  },
  { pubkey: SystemProgram.programId,                           isSigner: false, isWritable: false },
  { pubkey: TOKEN_PROGRAM,                                     isSigner: false, isWritable: false },
  { pubkey: pda([Buffer.from('creator-vault'), creator.toBuffer()], PUMP),        isSigner: false, isWritable: true  },
  { pubkey: pda([Buffer.from('__event_authority')], PUMP),                        isSigner: false, isWritable: false },
  { pubkey: PUMP,                                              isSigner: false, isWritable: false },
  { pubkey: pda([Buffer.from('global_volume_accumulator')], PUMP),                isSigner: false, isWritable: false },
  { pubkey: pda([Buffer.from('user_volume_accumulator'), payer.publicKey.toBuffer()], PUMP), isSigner: false, isWritable: true },
  { pubkey: pda([Buffer.from('fee_config'), PUMP.toBuffer()], FEE_PROGRAM),       isSigner: false, isWritable: false },
  { pubkey: FEE_PROGRAM,                                       isSigner: false, isWritable: false },
];

const data = Buffer.concat([SNIPE_IX, u64(amount), u64(maxSolCost), u64(gate), Buffer.from([1])]);

// the buyer's token account has to exist before pump.fun writes into it
const tx = new Transaction()
  .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }))
  .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(process.env.PRIORITY_FEE ?? 0) }))
  .add(new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer.publicKey,          isSigner: true,  isWritable: true  },
      { pubkey: ata(payer.publicKey),     isSigner: false, isWritable: true  },
      { pubkey: payer.publicKey,          isSigner: false, isWritable: false },
      { pubkey: mint,                     isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM,            isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  }))
  .add(new TransactionInstruction({ programId: SNIPE_PROGRAM, keys: accounts, data }));

const before = await conn.getBalance(payer.publicKey);
tx.feePayer = payer.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
const sim = await conn.simulateTransaction(tx);
if (sim.value.err) {
  console.log('\nSIM FAILED', JSON.stringify(sim.value.err));
  console.log((sim.value.logs ?? []).join('\n'));
  process.exit(1);
}
try {
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed', skipPreflight: true });
  const after = await conn.getBalance(payer.publicKey);
  const bal = await conn.getTokenAccountBalance(ata(payer.publicKey)).catch(() => null);
  console.log('\nLANDED', sig);
  console.log(' sol spent  ', ((before - after) / 1e9).toFixed(6));
  console.log(' tokens held', bal?.value?.uiAmountString ?? '0');
} catch (e) {
  const logs = e?.logs ?? e?.transactionLogs ?? [];
  const hit = logs.find((l) => /LostTheRace|CurveComplete|Error Code/.test(l));
  console.log('\nREVERTED —', hit ?? e.message.split('\n')[0]);
  if (process.env.VERBOSE) console.log(logs.join('\n'));
}
