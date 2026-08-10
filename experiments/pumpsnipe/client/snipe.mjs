// pumpsnipe — fire one snipe at a mint.
//
//   node client/snipe.mjs <mint> [solIn] [maxVirtualQuoteReserves]
//
// solIn is in SOL. The third argument is the freshness gate: the trade reverts
// unless the curve has seen at most that much buying pressure. Omit it and it
// defaults to the curve's current level, which always passes — pass a lower
// number to force the "lost the race" path.

import fs from 'node:fs';
import os from 'node:os';
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { deriveV2, liftFromTx, IX, ATA_PROGRAM, SYSTEM } from './lift.mjs';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const SNIPE_PROGRAM = new PublicKey(
  process.env.PROGRAM_ID ??
    JSON.parse(fs.readFileSync(new URL('../program-id.json', import.meta.url), 'utf8')),
);

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

const [, , mintArg, solArg = '0.01', gateArg] = process.argv;
if (!mintArg) {
  console.error('usage: node client/snipe.mjs <mint> [solIn] [maxVirtualQuoteReserves]');
  process.exit(1);
}

const conn = new Connection(RPC, 'confirmed');
const payer = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync(process.env.KEYPAIR ?? `${os.homedir()}/.config/solana/id.json`, 'utf8'))));
const mint = new PublicKey(mintArg);
const lamportsIn = BigInt(Math.floor(Number(solArg) * 1e9));

// Derive the v2 account list from the mint. Falls back to copying a real buy
// if pump.fun has changed shape again.
let acc;
try {
  acc = await deriveV2(conn, mint, payer.publicKey);
} catch (e) {
  console.log('derive failed (' + e.message + '), lifting from a real buy');
  acc = await liftFromTx(conn, mint, payer.publicKey);
}
console.log('accounts   ', acc.nAccounts, 'via', acc.via);

const cd = (await conn.getAccountInfo(acc.bondingCurve)).data;
const virtualTokenReserves = cd.readBigUInt64LE(8);
const virtualQuoteReserves = cd.readBigUInt64LE(16);
const complete = cd[48] !== 0;

// Constant product, then accept 30% fewer tokens than quoted so ordinary drift
// between building and landing doesn't trip pump.fun's own bound. The gate is
// what actually protects us from a bad fill.
const quoted = (virtualTokenReserves * lamportsIn) / (virtualQuoteReserves + lamportsIn);
const minTokensOut = (quoted * 70n) / 100n;
const gate = gateArg !== undefined ? BigInt(gateArg) : virtualQuoteReserves;

console.log('curve      ', acc.bondingCurve.toBase58(), complete ? '(COMPLETE)' : '');
console.log('vQuoteRes  ', virtualQuoteReserves.toString(), '(buying pressure so far)');
console.log('gate       ', gate.toString(), gate < virtualQuoteReserves ? '<-- below the curve, expect LostTheRace' : '');
console.log('spending   ', lamportsIn.toString(), 'lamports for >=', minTokensOut.toString(), 'tokens');

// pump.fun's own payload, forwarded untouched by our program.
const pumpData = Buffer.concat([IX.buy_exact_quote_in_v2, u64(lamportsIn), u64(minTokensOut)]);
// our header: where the curve sits in the account list, and the gate.
const data = Buffer.concat([Buffer.from([acc.curveIndex]), u64(gate), pumpData]);

const createAta = (owner, ataAddr, m, tokenProgram) => new TransactionInstruction({
  programId: ATA_PROGRAM,
  keys: [
    { pubkey: payer.publicKey, isSigner: true,  isWritable: true  },
    { pubkey: ataAddr,         isSigner: false, isWritable: true  },
    { pubkey: owner,           isSigner: false, isWritable: false },
    { pubkey: m,               isSigner: false, isWritable: false },
    { pubkey: SYSTEM,          isSigner: false, isWritable: false },
    { pubkey: tokenProgram,    isSigner: false, isWritable: false },
  ],
  data: Buffer.from([1]), // CreateIdempotent
});

const tx = new Transaction()
  .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }))
  .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(process.env.PRIORITY_FEE ?? 0) }))
  .add(createAta(payer.publicKey, acc.userBaseAta, acc.baseMint, acc.baseTokenProgram))
  .add(createAta(payer.publicKey, acc.userQuoteAta, acc.quoteMint, acc.quoteTokenProgram))
  .add(new TransactionInstruction({ programId: SNIPE_PROGRAM, keys: acc.keys, data }));

tx.feePayer = payer.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;

const sim = await conn.simulateTransaction(tx);
if (sim.value.err) {
  const logs = sim.value.logs ?? [];
  const hit = logs.find((l) => /Error Code|custom program error/.test(l));
  console.log('\nREVERTED —', hit ?? JSON.stringify(sim.value.err));
  if (process.env.VERBOSE) console.log(logs.join('\n'));
  process.exit(1);
}

const before = await conn.getBalance(payer.publicKey);
const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed', skipPreflight: true });
const after = await conn.getBalance(payer.publicKey);
const bal = await conn.getTokenAccountBalance(acc.userBaseAta).catch(() => null);
console.log('\nLANDED', sig);
console.log(' sol spent  ', ((before - after) / 1e9).toFixed(6));
console.log(' tokens held', bal?.value?.uiAmountString ?? '0');
