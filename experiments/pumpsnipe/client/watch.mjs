// The detector — the "aiming" half.
//
// Subscribes to pump.fun's logs, spots each new token as it is created, applies
// a filter, and fires the sniper at whatever passes. Everything about strategy
// lives in `shouldSnipe` below; the rest is plumbing.
//
//   RPC_URL=https://… WS_URL=wss://… node client/watch.mjs
//
// Env:
//   BUDGET_SOL      total to spend across the whole run   (default 0.1)
//   PER_SNIPE_SOL   size of each buy                      (default 0.01)
//   MAX_SNIPES      stop after this many                  (default 10)
//   RUN_MINUTES     stop after this long                  (default 30)
//   GATE_LAMPORTS   max buying pressure we'll accept on a curve (default 5e9)
//   DRY_RUN=1       simulate only, never send

import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { Connection, PublicKey } from '@solana/web3.js';
import { PUMP } from './lift.mjs';

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
const WS = process.env.WS_URL ?? RPC.replace(/^http/, 'ws').replace(':8899', ':8900');

const BUDGET_SOL = Number(process.env.BUDGET_SOL ?? 0.1);
const PER_SNIPE_SOL = Number(process.env.PER_SNIPE_SOL ?? 0.01);
const MAX_SNIPES = Number(process.env.MAX_SNIPES ?? 10);
const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? 30);
const GATE_LAMPORTS = BigInt(process.env.GATE_LAMPORTS ?? 5_000_000_000n);
const DRY_RUN = process.env.DRY_RUN === '1';

const conn = new Connection(RPC, { wsEndpoint: WS, commitment: 'confirmed' });
const started = Date.now();
const log = [];
let spent = 0;
let fired = 0;
let seen = 0;

/**
 * The strategy. Everything above is plumbing; this is the only opinionated
 * part, and it is deliberately crude — spray with mechanical filters, which is
 * what most of the snipers on chain are doing.
 *
 * Return a reason string to skip, or null to fire.
 */
function shouldSnipe({ virtualQuoteReserves, complete }) {
  if (complete) return 'curve already complete';
  // Anything past the gate means somebody beat us to it by more than we're
  // willing to pay up for. The program enforces this too — this just saves
  // a wasted transaction fee.
  if (virtualQuoteReserves > GATE_LAMPORTS) return 'curve already moved';
  return null;
}

function stopReason() {
  if (fired >= MAX_SNIPES) return `hit MAX_SNIPES (${MAX_SNIPES})`;
  if (spent >= BUDGET_SOL) return `hit BUDGET_SOL (${BUDGET_SOL})`;
  if (Date.now() - started > RUN_MINUTES * 60_000) return `hit RUN_MINUTES (${RUN_MINUTES})`;
  return null;
}

function snipe(mint) {
  return new Promise((resolve) => {
    const args = ['client/snipe.mjs', mint, String(PER_SNIPE_SOL), String(GATE_LAMPORTS)];
    const child = spawn('node', args, {
      env: { ...process.env, ...(DRY_RUN ? { DRY_RUN: '1' } : {}) },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      const landed = /LANDED/.test(out);
      const reverted = out.match(/REVERTED — (.*)/)?.[1] ?? null;
      const solSpent = Number(out.match(/sol spent\s+([\d.]+)/)?.[1] ?? 0);
      const tokens = out.match(/tokens held\s+([\d.]+)/)?.[1] ?? '0';
      resolve({ code, landed, reverted, solSpent, tokens });
    });
  });
}

// pump.fun emits this on every token creation.
const CREATE_LOG = /Program log: Instruction: Create(V2)?$/;

console.log(`watching pump.fun on ${WS}`);
console.log(`budget ${BUDGET_SOL} SOL · ${PER_SNIPE_SOL} per snipe · max ${MAX_SNIPES} · ${RUN_MINUTES} min${DRY_RUN ? ' · DRY RUN' : ''}\n`);

const subId = await conn.onLogs(PUMP, async (logsResult) => {
  const stop = stopReason();
  if (stop) return;
  if (logsResult.err) return;
  if (!logsResult.logs.some((l) => CREATE_LOG.test(l))) return;

  // The create transaction names the mint; pull it back out.
  const tx = await conn.getTransaction(logsResult.signature, {
    maxSupportedTransactionVersion: 0, commitment: 'confirmed',
  }).catch(() => null);
  if (!tx) return;
  const keys = tx.transaction.message.staticAccountKeys.map((k) => k.toBase58());
  const mintStr = keys.find((k) => k.endsWith('pump')) ?? keys[1];
  if (!mintStr) return;

  seen++;
  const mint = new PublicKey(mintStr);
  const curve = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()], PUMP)[0];
  const info = await conn.getAccountInfo(curve).catch(() => null);
  if (!info) return;

  const state = {
    virtualQuoteReserves: info.data.readBigUInt64LE(16),
    complete: info.data[48] !== 0,
  };
  const skip = shouldSnipe(state);
  if (skip) {
    console.log(`skip  ${mintStr.slice(0, 8)}…  ${skip}`);
    log.push({ t: new Date().toISOString(), mint: mintStr, action: 'skip', reason: skip });
    return;
  }

  fired++;
  console.log(`fire  ${mintStr.slice(0, 8)}…  (${fired}/${MAX_SNIPES})`);
  const r = await snipe(mintStr);
  spent += r.solSpent;
  console.log(`  ${r.landed ? 'LANDED' : 'missed'}  spent ${r.solSpent} SOL  tokens ${r.tokens}` +
    (r.reverted ? `  [${r.reverted.slice(0, 60)}]` : ''));
  log.push({ t: new Date().toISOString(), mint: mintStr, action: 'snipe', ...r });

  const done = stopReason();
  if (done) finish(done);
}, 'confirmed');

function finish(reason) {
  const landed = log.filter((l) => l.landed).length;
  const missed = log.filter((l) => l.action === 'snipe' && !l.landed).length;
  console.log(`\n--- stopped: ${reason}`);
  console.log(`launches seen ${seen} · fired ${fired} · landed ${landed} · missed ${missed} · spent ${spent.toFixed(6)} SOL`);
  const path = `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path, JSON.stringify({ reason, seen, fired, landed, missed, spent, log }, null, 1));
  console.log(`log written to ${path}`);
  conn.removeOnLogsListener(subId).finally(() => process.exit(0));
}

setInterval(() => { const s = stopReason(); if (s) finish(s); }, 5_000);
process.on('SIGINT', () => finish('interrupted'));
