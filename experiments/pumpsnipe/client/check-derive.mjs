// Does the zero-RPC derivation agree with the proven one?
//
// `deriveFromEvent` rebuilds pump.fun's 27 accounts from log bytes whose layout
// was reverse-engineered, not documented. `deriveV2` reads the same facts back
// off chain. If they ever disagree the fast path is wrong, so this catches
// live launches and diffs the two account lists key by key.
//
//   node client/check-derive.mjs [howMany]

import fs from 'node:fs';
import os from 'node:os';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import './env.mjs';
import { loadPayer } from './keypair.mjs';
import { watchLaunches } from './stream.mjs';
import { deriveV2, deriveFromEvent, prewarm } from './lift.mjs';

const K = process.env.HELIUS_API_KEY;
const conn = new Connection(process.env.RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${K}`, 'processed');
const want = Number(process.argv[2] ?? 3);
// The real payer, so the prewarmed per-buyer PDAs are the ones under test.
const user = loadPayer().payer.publicKey;

const warm = await prewarm(conn, user);
console.log('prewarmed global config');
console.log(`  feeRecipient        ${warm.feeRecipient.toBase58()}`);
console.log(`  buybackFeeRecipient ${warm.buybackFeeRecipient.toBase58()}\n`);

let checked = 0, failures = 0;

const stop = await watchLaunches(async (e) => {
  if (checked >= want) return;
  const i = ++checked;

  const t0 = Date.now();
  const fast = deriveFromEvent(warm, e, user);
  const fastMs = Date.now() - t0;

  // The curve account has to exist before deriveV2 can read it.
  await new Promise((r) => setTimeout(r, 1_500));
  const t1 = Date.now();
  let slow;
  try {
    slow = await deriveV2(conn, e.mint, user);
  } catch (err) {
    console.log(`${i}. ${e.symbol} — deriveV2 failed: ${err.message}`);
    return;
  }
  const slowMs = Date.now() - t1;

  const diffs = [];
  for (let k = 0; k < Math.max(fast.keys.length, slow.keys.length); k++) {
    const a = fast.keys[k], b = slow.keys[k];
    if (!a || !b) { diffs.push(`${k}: length ${fast.keys.length} vs ${slow.keys.length}`); continue; }
    if (!a.pubkey.equals(b.pubkey)) diffs.push(`${k}: ${a.pubkey.toBase58()} vs ${b.pubkey.toBase58()}`);
    if (a.isSigner !== b.isSigner) diffs.push(`${k}: signer ${a.isSigner} vs ${b.isSigner}`);
    if (a.isWritable !== b.isWritable) diffs.push(`${k}: writable ${a.isWritable} vs ${b.isWritable}`);
  }

  const ok = diffs.length === 0
    && fast.baseTokenProgram.equals(slow.baseTokenProgram)
    && fast.quoteMint.equals(slow.quoteMint);
  if (!ok) failures++;

  console.log(`${i}. ${e.symbol.padEnd(10)} ${e.mint.toBase58()}`);
  console.log(`   ${ok ? 'IDENTICAL' : 'MISMATCH'}  ${fast.keys.length} accounts   event ${fastMs} ms vs rpc ${slowMs} ms`);
  console.log(`   baseTokenProgram ${fast.baseTokenProgram.toBase58()}`);
  console.log(`   quoteMint        ${fast.quoteMint.toBase58()}`);
  for (const d of diffs) console.log(`   ! ${d}`);

  if (checked >= want) {
    console.log(`\n${checked - failures}/${checked} identical`);
    stop();
    process.exit(failures ? 1 : 0);
  }
});

setTimeout(() => { console.log('timed out'); process.exit(1); }, 120_000);
