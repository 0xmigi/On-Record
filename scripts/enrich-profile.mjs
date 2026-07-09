// Compute a Program Profile (framework, syscalls, capabilities, integrations)
// for every program in the snapshot by re-parsing its bytecode ELF, and report
// the real distribution across the window.
import { readFileSync, writeFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const core = await import("../packages/core/dist/index.js");
const { getProgramDataAddress, getAccountBytes, extractStrings, profileProgram } = core;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, t = 4) { let e; for (let i = 0; i < t; i++) { try { return await fn(); } catch (x) { e = x; await sleep(200 * 2 ** i); } } throw e; }

const snapUrl = new URL("../data/mainnet-snapshot.json", import.meta.url);
const snap = JSON.parse(readFileSync(snapUrl, "utf8"));

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; try { await fn(items[idx], idx); } catch {} }
  }));
}

const todo = snap.programs.filter((p) => !p.profile);
console.log(`profiling ${todo.length} of ${snap.programs.length} programs…`);
let done = 0;
await pool(todo, 5, async (p) => {
  const pda = await withRetry(() => getProgramDataAddress("mainnet", p.programId));
  if (!pda) return;
  const bytes = await withRetry(() => getAccountBytes("mainnet", pda));
  if (!bytes) return;
  let end = bytes.length;
  while (end > 45 && bytes[end - 1] === 0) end--;
  const body = bytes.subarray(45, end);
  const strings = extractStrings(body);
  const prof = profileProgram(body, { strings, idlInstructions: p.idlInstructions });
  p.profile = {
    framework: prof.framework,
    capabilities: prof.capabilities,
    integrations: prof.integrations,
    syscalls: prof.syscalls,
  };
  if (++done % 40 === 0) console.log(`  ${done}/${todo.length}…`);
});

writeFileSync(snapUrl, JSON.stringify(snap, null, 2));

// --- distribution report -----------------------------------------------------
const profiled = snap.programs.filter((p) => p.profile);
const n = profiled.length;
const pct = (c) => `${((c / n) * 100).toFixed(0)}%`;
const tally = (fn) => {
  const t = {};
  for (const p of profiled) for (const v of [].concat(fn(p) ?? [])) t[v] = (t[v] ?? 0) + 1;
  return Object.entries(t).sort((a, b) => b[1] - a[1]);
};

console.log(`\n=== PROGRAM PROFILES (${n} of ${snap.programs.length}) ===`);
console.log("\n— framework —");
for (const [k, v] of tally((p) => p.profile.framework)) console.log(`  ${k.padEnd(10)} ${v}  ${pct(v)}`);
console.log("\n— capabilities —");
for (const [k, v] of tally((p) => p.profile.capabilities)) console.log(`  ${k.padEnd(16)} ${v}  ${pct(v)}`);
console.log("\n— integrations (known programs referenced) —");
for (const [k, v] of tally((p) => p.profile.integrations)) console.log(`  ${k.padEnd(20)} ${v}  ${pct(v)}`);
const avgSys = profiled.reduce((a, p) => a + p.profile.syscalls.length, 0) / n;
console.log(`\n— avg syscalls per program: ${avgSys.toFixed(1)} —`);
