// The runner. Detect, decide and fire, all in one process.
//
// This replaces watch.mjs, which spawned `node client/snipe.mjs` per launch and
// then did four sequential RPC calls inside the child before sending. Node
// takes ~40 ms just to start, and the derive alone measured ~300 ms; the race
// is usually over inside one 400 ms slot. Nothing on the hot path here touches
// the network:
//
//   detect      launch event decoded out of the log line          0 calls
//   derive      27 accounts from the event + prewarmed config     0 calls
//   blockhash   refreshed on a timer in the background            0 calls
//   send        one POST to Helius Sender                         1 call
//
// The client never reads the bonding curve before firing, which is the point of
// putting the gate on chain: the program re-reads the curve at execution time,
// so a client-side check would cost a round trip to learn something staler than
// what the program already sees.
//
//   RPC_URL         defaults to Helius mainnet using HELIUS_API_KEY
//   TRANSPORT       ws | atlas | laserstream          (default ws)
//   BUDGET_SOL      total spend cap for the run       (default 0.1)
//   PER_SNIPE_SOL   size of each buy                  (default 0.01)
//   MAX_SNIPES      stop after this many fires        (default 10)
//   RUN_MINUTES     stop after this long              (default 30)
//   GATE_SOL        buying pressure tolerated, above the curve's own
//                   starting point                   (default 2)
//   TIP_SOL         Sender tip                        (default 0.001)
//   PRIORITY_FEE    microlamports per compute unit    (default 500000)
//   DRY_RUN=1       build and price everything, send nothing

import fs from 'node:fs';
import os from 'node:os';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import './env.mjs';
import { loadPayer } from './keypair.mjs';
import { watchLaunches, TRANSPORT } from './stream.mjs';
import { prewarm, harvestFeeRecipients, wsolAta } from './lift.mjs';
import {
  pickRegion, sendViaSender, sendViaRpc, isLocal, confirm, wireSize, MIN_TIP_LAMPORTS,
} from './sender.mjs';
import { buildSnipe } from './build.mjs';

const K = process.env.HELIUS_API_KEY;
const RPC = process.env.RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${K}`;
// Sender forwards to mainnet, so a run pointed at a local fork must never use
// it — otherwise the "safe" test sends real transactions to the real chain.
const LOCAL = isLocal(RPC);
const SNIPE_PROGRAM = new PublicKey(process.env.PROGRAM_ID
  ?? JSON.parse(fs.readFileSync(new URL('../program-id.json', import.meta.url), 'utf8')));

const BUDGET_SOL = Number(process.env.BUDGET_SOL ?? 0.1);
const PER_SNIPE_SOL = Number(process.env.PER_SNIPE_SOL ?? 0.01);
const MAX_SNIPES = Number(process.env.MAX_SNIPES ?? 10);
const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? 30);
const GATE_SOL = Number(process.env.GATE_SOL ?? 2);
const MAX_DEV_BUY_SOL = Number(process.env.MAX_DEV_BUY_SOL ?? -1);
const TIP_LAMPORTS = BigInt(Math.floor(Number(process.env.TIP_SOL ?? 0.001) * 1e9));
const PRIORITY_FEE = Number(process.env.PRIORITY_FEE ?? 500_000);
/// Stop if the wallet would fall below this. BUDGET_SOL only counts the buy and
/// the tip; it does not see fees or the ~0.002 SOL of rent each new mint's token
/// account locks up. This is the backstop that actually keeps the run solvent.
const MIN_BALANCE_SOL = Number(process.env.MIN_BALANCE_SOL ?? 0.015);
const DRY_RUN = process.env.DRY_RUN === '1';
/// Measured peak on a real snipe was ~137k CU. The priority fee is charged on
/// the limit you ask for, not the amount you burn, so asking for 250k was
/// paying 25% over the odds and making the transaction harder to schedule.
const COMPUTE_UNITS = Number(process.env.COMPUTE_UNITS ?? 200_000);

const LAMPORTS_IN = BigInt(Math.floor(PER_SNIPE_SOL * 1e9));
const GATE_LAMPORTS = BigInt(Math.floor(GATE_SOL * 1e9));
const MAX_DEV_BUY_LAMPORTS = MAX_DEV_BUY_SOL < 0 ? -1n : BigInt(Math.floor(MAX_DEV_BUY_SOL * 1e9));

const conn = new Connection(RPC, 'confirmed');
// A brand new bonding curve is not visible at `confirmed` yet, so the dry run's
// measurement reads at `processed`.
const processed = new Connection(RPC, 'processed');
/// How long after detection the dry run looks at the curve — about the point a
/// real transaction would have landed.
const LAND_PROBE_MS = Number(process.env.LAND_PROBE_MS ?? 800);
const { payer, path: keypairPath, kind: keypairKind } = loadPayer();

const started = Date.now();
const log = [];
let spent = 0, fired = 0, seen = 0, landed = 0, inflight = 0;
let balanceSol = Infinity;

// --- blockhash, kept warm ---------------------------------------------------
let blockhash = null;
async function refreshBlockhash() {
  try {
    const r = await conn.getLatestBlockhash('confirmed');
    blockhash = r.blockhash;
  } catch { /* keep the old one; it is valid for ~60s */ }
}

// --- the strategy -----------------------------------------------------------
function shouldSnipe(e) {
  if (e.baseTokenReserves === 0n) return 'curve has no tokens';
  if (LAMPORTS_IN <= 0n) return 'nothing to spend';
  if (spent + PER_SNIPE_SOL > BUDGET_SOL) return 'would exceed budget';
  // A creator holding a large bundled position is the one best placed to sell
  // it into whoever buys next. This is the only judgement here, and a crude one.
  if (MAX_DEV_BUY_LAMPORTS >= 0n && e.devBuyLamports > MAX_DEV_BUY_LAMPORTS) {
    return `dev bundled ${(Number(e.devBuyLamports) / 1e9).toFixed(3)} SOL`;
  }
  return null;
}

/** Same builder the fork test verifies, so what fires is what was proven. */
function build(warm, e) {
  return buildSnipe({
    warm, launch: e, payer, programId: SNIPE_PROGRAM,
    lamportsIn: LAMPORTS_IN, gateLamports: GATE_LAMPORTS,
    priorityFee: PRIORITY_FEE,
    computeUnits: COMPUTE_UNITS,
    tipLamports: LOCAL ? 0n : TIP_LAMPORTS,
    blockhash,
  });
}

// --- limits -----------------------------------------------------------------
function stopReason() {
  if (balanceSol < MIN_BALANCE_SOL) return `wallet floor (${balanceSol.toFixed(4)} < ${MIN_BALANCE_SOL})`;
  if (fired >= MAX_SNIPES) return `hit MAX_SNIPES (${MAX_SNIPES})`;
  if (spent >= BUDGET_SOL) return `hit BUDGET_SOL (${BUDGET_SOL})`;
  if (Date.now() - started > RUN_MINUTES * 60_000) return `hit RUN_MINUTES (${RUN_MINUTES})`;
  return null;
}

// --- run --------------------------------------------------------------------
// Against a fork there is no local transaction history to harvest a fee
// recipient pair from, so take it off mainnet — the fork mirrors mainnet, so
// they are the same accounts.
const harvestConn = LOCAL && K ? new Connection(`https://mainnet.helius-rpc.com/?api-key=${K}`, 'confirmed') : conn;
const warm = await prewarm(harvestConn, payer.publicKey);
await refreshBlockhash();
setInterval(refreshBlockhash, 2_000).unref();

// pump.fun accepts any authorised fee recipient, and which ones are authorised
// changes. Re-harvest a matched pair periodically so a long run cannot go
// stale mid-flight. Off the hot path, so its cost does not matter.
async function refreshFeeRecipients() {
  const h = await harvestFeeRecipients(harvestConn).catch(() => null);
  if (!h) return;
  warm.feeRecipient = h.feeRecipient;
  warm.buybackFeeRecipient = h.buybackFeeRecipient;
  warm.feeSource = h.source;
  if (warm.sol) {
    warm.sol.feeRecipientAta = wsolAta(h.feeRecipient);
    warm.sol.buybackFeeRecipientAta = wsolAta(h.buybackFeeRecipient);
  }
}
setInterval(refreshFeeRecipients, 5 * 60_000).unref();

// Keep the real balance in view; the accounting above cannot see rent or fees.
setInterval(async () => {
  const b = await conn.getBalance(payer.publicKey).catch(() => null);
  if (b != null) balanceSol = b / 1e9;
}, 10_000).unref();

const region = (LOCAL || DRY_RUN) && !(process.env.SENDER_REGION && !LOCAL)
  ? { region: LOCAL ? 'local' : 'n/a', url: null, ms: null }
  : await pickRegion({ verbose: true });

const balance = await conn.getBalance(payer.publicKey);
balanceSol = balance / 1e9;
console.log(`\npumpsnipe — ${DRY_RUN ? 'DRY RUN, nothing will be sent' : LOCAL ? 'LOCAL FORK' : 'LIVE — REAL MONEY'}`);
console.log(`  payer      ${payer.publicKey.toBase58()}  ${(balance / 1e9).toFixed(4)} SOL`);
console.log(`  key        ${keypairPath}${keypairKind === 'CLI DEFAULT' ? '   <-- MACHINE DEFAULT KEY, not the dedicated one' : ''}`);
console.log(`  program    ${SNIPE_PROGRAM.toBase58()}`);
console.log(`  transport  ${TRANSPORT}`);
console.log(`  rpc        ${RPC.replace(/api-key=[^&]+/, 'api-key=…')}`);
console.log(`  submit     ${LOCAL ? 'local RPC (Sender bypassed)' : region.url ?? '—'}${region.ms != null ? ` (${region.ms} ms)` : ''}`);
console.log(`  size       ${PER_SNIPE_SOL} SOL x ${MAX_SNIPES} max, budget ${BUDGET_SOL} SOL`);
console.log(`  gate       post-create baseline + ${GATE_SOL} SOL`);
console.log(`  dev buy    ${MAX_DEV_BUY_SOL < 0 ? 'no limit' : `skip above ${MAX_DEV_BUY_SOL} SOL`}`);
console.log(`  tip        ${Number(TIP_LAMPORTS) / 1e9} SOL   priority ${PRIORITY_FEE} microlamports/CU\n`);

if (!DRY_RUN && TIP_LAMPORTS < BigInt(MIN_TIP_LAMPORTS)) {
  console.log(`  ! tip is below Sender's ${MIN_TIP_LAMPORTS / 1e9} SOL full-routing minimum\n`);
}

const stop = await watchLaunches(async (e) => {
  if (stopReason()) return;
  seen++;

  const skip = shouldSnipe(e);
  if (skip) {
    log.push({ t: new Date().toISOString(), mint: e.mint.toBase58(), symbol: e.symbol, action: 'skip', reason: skip });
    return;
  }

  fired++;
  inflight++;
  const n = fired;
  const t0 = Date.now();
  let built;
  try {
    built = build(warm, e);
  } catch (err) {
    console.log(`${n}. ${e.symbol} — build failed: ${err.message}`);
    log.push({ t: new Date().toISOString(), mint: e.mint.toBase58(), symbol: e.symbol, action: 'error', error: err.message });
    inflight--;
    return;
  }
  const buildMs = Date.now() - t0;
  const size = wireSize(built.tx);

  const entry = {
    t: new Date().toISOString(),
    mint: e.mint.toBase58(),
    symbol: e.symbol,
    creator: e.creator.toBase58(),
    curveNominalStart: e.virtualQuoteReserves + '',
    curveBaseline: e.baseQuoteReserves + '',
    devBuySol: Number(e.devBuyLamports) / 1e9,
    feePool: e.feePool === 1 ? 'B' : 'A',
    gate: built.gate + '',
    detectToBuildMs: Date.now() - e.seenAt,
    buildMs,
    txBytes: size,
    action: 'snipe',
  };

  // Launches overlap, and their probes finish out of order, so each one's lines
  // are buffered and printed as a block rather than interleaved.
  const say = [
    `${n}. ${e.symbol.padEnd(12)} ${e.mint.toBase58()}`,
    `   dev bundled ${(Number(e.devBuyLamports) / 1e9).toFixed(3)} SOL` +
      `  ->  baseline ${(Number(e.baseQuoteReserves) / 1e9).toFixed(3)} SOL,` +
      ` gate ${(Number(built.gate) / 1e9).toFixed(3)} SOL`,
    `   built in ${buildMs} ms, ${Date.now() - e.seenAt} ms after detect, ${size} bytes`,
  ];
  const flush = () => console.log(say.join('\n'));

  if (DRY_RUN) {
    // Not racing, so we can afford to look. Read the curve at roughly the point
    // a real transaction would have landed and record what other buyers did to
    // it in the meantime. This is the number that decides whether any of this
    // is viable, so it is measured rather than assumed.
    await new Promise((r) => setTimeout(r, LAND_PROBE_MS));

    // Simulate what we actually built. Building alone proves the transaction is
    // well-formed, not that pump.fun would accept it — and the fee-recipient
    // pool only shows up here. Must be `processed`: a mint this new is not
    // visible at `confirmed` yet, and the ATA create fails with
    // IncorrectProgramId against state that does not know the mint.
    const sim = await processed.simulateTransaction(built.tx).catch(() => null);
    const errStr = sim?.value?.err ? JSON.stringify(sim.value.err) : null;
    const custom = errStr?.match(/"Custom":(\d+)/)?.[1];
    entry.simulated = !errStr ? 'accepted'
      : custom === '7' ? 'lost the race (gate held)'
      : custom === '6000' ? 'NotAuthorized (fee pool wrong)'
      : `err ${errStr.slice(0, 44)}`;
    say.push(`   pool ${e.feePool === 1 ? 'B' : 'A'}, simulated: ${entry.simulated}`);

    const info = await processed.getAccountInfo(built.acc.bondingCurve).catch(() => null);
    if (info && info.data.length > 48) {
      const now = info.data.readBigUInt64LE(16);
      const moved = now - e.baseQuoteReserves;
      entry.probeAfterMs = LAND_PROBE_MS;
      entry.curveAtProbe = now + '';
      entry.racedLamports = moved + '';
      entry.wouldHavePassed = now <= built.gate;
      say.push(`   +${LAND_PROBE_MS} ms: others bought ${(Number(moved) / 1e9).toFixed(4)} SOL` +
        `  ->  gate would ${entry.wouldHavePassed ? 'PASS' : 'REJECT'}`);
    } else {
      entry.curveAtProbe = null;
      say.push(`   +${LAND_PROBE_MS} ms: curve not readable`);
    }
    flush();
    log.push(entry);
    inflight--;
    return;
  }

  try {
    const sig = LOCAL
      ? await sendViaRpc(conn, built.tx)
      : await sendViaSender(region.url, built.tx);
    entry.signature = sig;
    entry.sendMs = Date.now() - t0;
    say.push(`   sent ${sig} (${entry.sendMs} ms)`);
    const r = await confirm(conn, sig);
    entry.landed = r.landed;
    entry.err = r.err ?? null;
    if (r.landed) {
      landed++;
      spent += PER_SNIPE_SOL + Number(TIP_LAMPORTS) / 1e9;
      const bal = await conn.getTokenAccountBalance(built.acc.userBaseAta).catch(() => null);
      entry.tokens = bal?.value?.uiAmountString ?? '0';
      say.push(`   LANDED — ${entry.tokens} tokens`);
    } else {
      // A revert rolls the tip back with everything else; only the fee is gone.
      say.push(`   lost — ${JSON.stringify(r.err)}`);
    }
  } catch (err) {
    entry.error = err.message;
    say.push(`   send failed: ${err.message}`);
  }
  flush();
  log.push(entry);
  inflight--;

  // Other snipes may still be mid-flight; exiting now would throw away their
  // results. The interval below finishes the run once they have all landed.
  const done = stopReason();
  if (done && inflight === 0) finish(done);
});

let finished = false;
function finish(reason) {
  if (finished) return;
  finished = true;
  const fires = log.filter((l) => l.action === 'snipe');
  const lat = fires.map((l) => l.detectToBuildMs).filter((n) => n != null).sort((a, b) => a - b);
  const median = lat.length ? lat[lat.length >> 1] : null;

  console.log(`\n--- stopped: ${reason}`);
  console.log(`launches seen ${seen} · fired ${fired} · landed ${landed} · spent ${spent.toFixed(6)} SOL`);
  if (median != null) console.log(`detect to built, median ${median} ms over ${lat.length}`);
  if (DRY_RUN) {
    const pass = fires.filter((l) => l.wouldHavePassed === true).length;
    const checked = fires.filter((l) => l.wouldHavePassed != null).length;
    if (checked) {
      const raced = fires.filter((l) => l.racedLamports != null)
        .map((l) => Number(l.racedLamports) / 1e9).sort((a, b) => a - b);
      console.log(`gate would have passed ${pass}/${checked} at +${LAND_PROBE_MS} ms`);
      if (raced.length) {
        console.log(`others bought, median ${raced[raced.length >> 1].toFixed(4)} SOL` +
          `  (min ${raced[0].toFixed(4)}, max ${raced[raced.length - 1].toFixed(4)})`);
      }
    }
    const sims = {};
    for (const l of fires) if (l.simulated) sims[l.simulated] = (sims[l.simulated] ?? 0) + 1;
    if (Object.keys(sims).length) {
      console.log('simulated: ' + Object.entries(sims).map(([k, v]) => `${k} ${v}`).join(' · '));
    }
    const pools = {};
    for (const l of fires) if (l.feePool) pools[l.feePool] = (pools[l.feePool] ?? 0) + 1;
    console.log('fee pools seen: ' + Object.entries(pools).map(([k, v]) => `${k}:${v}`).join(' '));
    const devs = fires.map((l) => l.devBuySol).filter((n) => n != null).sort((a, b) => a - b);
    if (devs.length) {
      console.log(`dev bundle, median ${devs[devs.length >> 1].toFixed(3)} SOL` +
        `  (${fires.filter((l) => l.devBuySol > 0).length}/${fires.length} bundled at all)`);
    }
  }

  const path = `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(path, JSON.stringify({
    reason, dryRun: DRY_RUN, transport: TRANSPORT, region: region.region,
    config: { BUDGET_SOL, PER_SNIPE_SOL, MAX_SNIPES, RUN_MINUTES, GATE_SOL, PRIORITY_FEE, tipSol: Number(TIP_LAMPORTS) / 1e9 },
    seen, fired, landed, spent, medianDetectToBuiltMs: median, log,
  }, null, 1));
  console.log(`log written to ${path}`);
  try { stop(); } catch {}
  process.exit(0);
}

setInterval(() => { const s = stopReason(); if (s && inflight === 0) finish(s); }, 2_000);
process.on('SIGINT', () => finish('interrupted'));
