// What is actually in the wallet right now? Run this any time.
//
//   node client/status.mjs
//
// Answers the only three questions that matter after a session: how much SOL is
// there, is anything still held, and is the program still costing rent. Reads
// only — it cannot change anything.

import './env.mjs';
import { Connection, PublicKey } from '@solana/web3.js';
import { loadPayer } from './keypair.mjs';
import { PUMP } from './lift.mjs';

const conn = new Connection(process.env.RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, 'confirmed');
const { payer } = loadPayer();
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const PROGRAM = 'EtGHq2pnMpctk7fAHX4HKbc3NGAtd5CzkqRuwidgXeSa';

const bal = await conn.getBalance(payer.publicKey);
console.log(`wallet  ${payer.publicKey.toBase58()}`);
console.log(`SOL     ${(bal / 1e9).toFixed(6)}\n`);

const accounts = await conn.getParsedTokenAccountsByOwner(payer.publicKey, { programId: TOKEN_2022 });
const held = [], empty = [];
let worth = 0n;

for (const { pubkey, account } of accounts.value) {
  const i = account.data.parsed.info;
  const amount = BigInt(i.tokenAmount.amount);
  if (amount === 0n) { empty.push({ pubkey, mint: i.mint }); continue; }
  const curve = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(i.mint).toBuffer()], PUMP)[0];
  const ci = await conn.getAccountInfo(curve).catch(() => null);
  let out = 0n;
  if (ci && ci.data.length > 48) {
    const vT = ci.data.readBigUInt64LE(8), vQ = ci.data.readBigUInt64LE(16);
    out = (vQ * amount) / (vT + amount);
    worth += out;
  }
  held.push({ mint: i.mint, tokens: i.tokenAmount.uiAmountString, out });
}

if (held.length) {
  console.log(`STILL HOLDING ${held.length} position${held.length > 1 ? 's' : ''} — not sold:`);
  for (const h of held) {
    console.log(`  ${h.mint}  ${String(h.tokens).padStart(16)} tokens  ~${(Number(h.out) / 1e9).toFixed(6)} SOL`);
  }
  console.log(`  marked total ~${(Number(worth) / 1e9).toFixed(6)} SOL\n`);
} else {
  console.log('positions: none held — everything is sold\n');
}

if (empty.length) {
  console.log(`${empty.length} emptied token account${empty.length > 1 ? 's' : ''} still open,`
    + ` holding ~${(empty.length * 0.00203928).toFixed(6)} SOL of rent.`);
  console.log('  `node client/sell.mjs --send` closes these too.\n');
}

// A closed program is NOT deleted. The program account survives, and so does
// its ProgramData, as a husk with zero lamports — so "does the account exist"
// always says yes and is the wrong question. Ask whether ProgramData still
// holds rent.
const prog = await conn.getAccountInfo(new PublicKey(PROGRAM)).catch(() => null);
let alive = false;
if (prog && prog.data?.length >= 36) {
  const programData = new PublicKey(prog.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(programData).catch(() => null);
  alive = !!pd && pd.lamports > 0 && pd.data.length > 4;
}
console.log(`program ${PROGRAM}`);
console.log(`        ${alive ? 'STILL DEPLOYED — rent not reclaimed' : 'closed, rent reclaimed'}`);

const recoverable = bal / 1e9 + Number(worth) / 1e9 + empty.length * 0.00203928;
console.log(`\nrecoverable right now  ~${recoverable.toFixed(6)} SOL`);
console.log(held.length ? '  (SOL in wallet + positions at current curve prices + token-account rent)'
  : '  (SOL in wallet + token-account rent)');
