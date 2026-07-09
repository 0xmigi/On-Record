// What does a real program deploy cost? The ProgramData account must be
// rent-exempt — that SOL is locked for the life of the program. Sample real
// ProgramData accounts and read their locked lamports + allocated size.
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const core = await import("../packages/core/dist/index.js");
const { getProgramDataAddress } = core;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, t = 4) { let e; for (let i = 0; i < t; i++) { try { return await fn(); } catch (x) { e = x; await sleep(200 * 2 ** i); } } throw e; }
async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (res.status === 429) throw new Error("429");
  const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result;
}

const SOL_USD = 82.28; // from orbmarkets.io/stats at time of writing

const snap = JSON.parse(readFileSync(new URL("../data/mainnet-snapshot.json", import.meta.url), "utf8"));
// sample across the size range
const sample = snap.programs.filter((p) => p.sizeBytes).sort((a, b) => a.sizeBytes - b.sizeBytes)
  .filter((_, i, arr) => i % Math.ceil(arr.length / 30) === 0).slice(0, 30);

const rows = [];
for (const p of sample) {
  try {
    const pda = await getProgramDataAddress("mainnet", p.programId);
    if (!pda) continue;
    const info = await withRetry(() => rpc("getAccountInfo", [pda, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }]));
    if (!info?.value) continue;
    rows.push({ name: p.name, codeKb: Math.round(p.sizeBytes / 1024), allocKb: Math.round(info.value.space / 1024), sol: info.value.lamports / 1e9 });
  } catch { /* skip */ }
}

rows.sort((a, b) => a.sol - b.sol);
const sols = rows.map((r) => r.sol);
const med = sols[Math.floor(sols.length / 2)];
const avg = sols.reduce((a, b) => a + b, 0) / sols.length;
console.log(`sampled ${rows.length} real ProgramData accounts (SOL @ $${SOL_USD})\n`);
console.log("  code KB  alloc KB   SOL locked   USD      name");
for (const r of rows) console.log(`  ${String(r.codeKb).padStart(6)}  ${String(r.allocKb).padStart(7)}   ${r.sol.toFixed(3).padStart(8)}   $${Math.round(r.sol * SOL_USD).toString().padStart(5)}   ${r.name ?? ""}`);
console.log(`\n  median: ${med.toFixed(2)} SOL  (~$${Math.round(med * SOL_USD)})`);
console.log(`  average: ${avg.toFixed(2)} SOL  (~$${Math.round(avg * SOL_USD)})`);
console.log(`  range: ${sols[0].toFixed(2)}–${sols[sols.length - 1].toFixed(2)} SOL`);
console.log(`\n  (rent is refundable if the program is closed — so it's locked capital, not burned. Still a real conviction cost.)`);
