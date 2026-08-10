// Fork test. Proves both halves of the gate against a real mint, with logs.
//
//   RPC_URL=http://127.0.0.1:8899 node client/verify.mjs <mint>
//
// Reconstructs the launch from chain state rather than from a log event, so it
// can be pointed at any existing mint. The event path is checked separately by
// check-derive.mjs, which diffs the two account lists key by key.

import fs from 'node:fs';
import os from 'node:os';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import './env.mjs';
import { loadPayer } from './keypair.mjs';
import { prewarm, PUMP, WSOL, SYSTEM } from './lift.mjs';
import { buildSnipe, ERRORS } from './build.mjs';
import { isLocal } from './sender.mjs';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
if (!isLocal(RPC)) {
  console.error('verify.mjs is for a local fork only; RPC_URL points at', RPC);
  process.exit(1);
}
const mintArg = process.argv[2];
if (!mintArg) {
  console.error('usage: RPC_URL=http://127.0.0.1:8899 node client/verify.mjs <mint>');
  process.exit(1);
}

const conn = new Connection(RPC, 'confirmed');
const { payer } = loadPayer();
const programId = new PublicKey(process.env.PROGRAM_ID
  ?? JSON.parse(fs.readFileSync(new URL('../program-id.json', import.meta.url), 'utf8')));
const mint = new PublicKey(mintArg);

// Rebuild the launch from the curve and the mint.
const bondingCurve = PublicKey.findProgramAddressSync(
  [Buffer.from('bonding-curve'), mint.toBuffer()], PUMP)[0];
const [curveInfo, mintInfo] = await Promise.all([
  conn.getAccountInfo(bondingCurve), conn.getAccountInfo(mint),
]);
if (!curveInfo) throw new Error(`no bonding curve for ${mintArg}`);
if (!mintInfo) throw new Error(`no mint account for ${mintArg}`);

const cd = curveInfo.data;
let quoteMint = cd.length >= 115 ? new PublicKey(cd.subarray(83, 115)) : WSOL;
const launch = {
  mint,
  bondingCurve,
  creator: new PublicKey(cd.subarray(49, 81)),
  baseTokenProgram: mintInfo.owner,
  quoteMint,
  virtualTokenReserves: cd.readBigUInt64LE(8),
  virtualQuoteReserves: cd.readBigUInt64LE(16),
  baseTokenReserves: cd.readBigUInt64LE(8),
  baseQuoteReserves: cd.readBigUInt64LE(16),
  devBuyLamports: 0n,
  // Curve byte 81 is the same flag the create event carries: which pool of fee
  // recipients pump.fun will accept for this launch.
  feePool: cd[81],
};

// A fork has no transaction history to harvest from, so the fee recipient pair
// comes off mainnet. The fork mirrors mainnet state, so they are the same
// accounts either way.
const K = process.env.HELIUS_API_KEY;
const warm = K
  ? await prewarm(new Connection(`https://mainnet.helius-rpc.com/?api-key=${K}`, 'confirmed'), payer.publicKey)
  : await prewarm(conn, payer.publicKey, { harvest: false });
const lamportsIn = BigInt(Math.floor(Number(process.env.PER_SNIPE_SOL ?? 0.05) * 1e9));
const complete = cd[48] !== 0;

console.log(`mint       ${mint.toBase58()}`);
console.log(`curve      ${bondingCurve.toBase58()}${complete ? '  (COMPLETE)' : ''}`);
console.log(`vQuote     ${launch.baseQuoteReserves}  (buying pressure so far)`);
console.log(`token prog ${launch.baseTokenProgram.toBase58()}`);
console.log(`quote mint ${quoteMint.equals(SYSTEM) ? 'unset -> WSOL' : quoteMint.toBase58()}`);
console.log(`spending   ${lamportsIn} lamports`);
console.log(`fee pool   ${launch.feePool === 1 ? 'B' : 'A'}  (curve byte 81 = ${cd[81]})`);
console.log(`fee recip  ${(launch.feePool === 1 ? warm.poolB : warm.poolA)[0].toBase58()}`);
console.log(`buyback    ${warm.buybackFeeRecipient.toBase58()}\n`);

async function run(label, gateLamports, expect) {
  const { blockhash } = await conn.getLatestBlockhash();
  const { tx, gate } = buildSnipe({
    warm, launch, payer, programId, lamportsIn, gateLamports,
    priorityFee: Number(process.env.PRIORITY_FEE ?? 500_000),
    // No tip on the fork: Sender is not in the path and it only adds noise.
    tipLamports: 0n,
    blockhash,
  });

  const sim = await conn.simulateTransaction(tx);
  const err = sim.value.err;
  const logs = sim.value.logs ?? [];
  const custom = JSON.stringify(err ?? '').match(/"Custom":(\d+)/)?.[1];
  const name = custom ? (ERRORS[custom] ?? `Custom(${custom})`) : null;

  const ok = expect === 'ok' ? !err : name === expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`      gate ${gate}  ->  ${err ? (name ?? JSON.stringify(err)) : 'succeeds'}`);
  console.log(`      ${tx.serialize().length} bytes, ${sim.value.unitsConsumed ?? '?'} CU`);
  if (!ok || process.env.VERBOSE) {
    console.log(logs.map((l) => '      ' + l).join('\n'));
  }
  return ok;
}

// Gate wide open: the curve cannot have moved past it, so the buy should go
// through and pump.fun should be invoked.
const a = await run('gate open, should reach pump.fun', 5_000_000_000n, 'ok');
// Gate set below where the curve already stands: the program should refuse
// before pump.fun is ever called.
launch.baseQuoteReserves = launch.baseQuoteReserves > 1_000_000n
  ? launch.baseQuoteReserves - 1_000_000n : 0n;
const b = await run('gate below the curve, should lose the race', 0n, 'LOST_THE_RACE');

process.exit(a && b ? 0 : 1);
