// Classify each program in the snapshot as a NEW DEPLOY vs an UPGRADE of an
// existing program. ProgramData only stores the *last* deploy slot, so we ask
// the chain: does this program have transaction history OLDER than our window?
//   - has older history  → it existed before → this event is an UPGRADE
//   - all history in-window → brand new program → NEW DEPLOY
// Early-exits on the first page for almost every program (1 RPC call each).
import { readFileSync, writeFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, t = 4) { let e; for (let i = 0; i < t; i++) { try { return await fn(); } catch (x) { e = x; await sleep(200 * 2 ** i); } } throw e; }
async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (res.status === 429) throw new Error("429");
  const j = await res.json(); if (j.error) throw new Error(j.error.message); return j.result;
}

const snapUrl = new URL("../data/mainnet-snapshot.json", import.meta.url);
const snap = JSON.parse(readFileSync(snapUrl, "utf8"));
const SLOTS_PER_SEC = 2.5;
// small margin so a deploy landing just before window-start isn't misread
const windowStartSlot = snap.currentSlot - (snap.windowHours * 3600 + 1800) * SLOTS_PER_SEC;

async function classify(programId) {
  let before, pages = 0;
  while (pages++ < 4) {
    const sigs = await withRetry(() => rpc("getSignaturesForAddress", [programId, { limit: 1000, before }]));
    if (!sigs.length) return pages === 1 ? "deploy" : "deploy"; // no history at all → new
    const oldest = sigs[sigs.length - 1];
    if (oldest.slot < windowStartSlot) return "upgrade"; // has pre-window history
    if (sigs.length < 1000) return "deploy"; // exhausted history, all in-window → new
    before = oldest.signature; // full page, all in-window → keep walking
  }
  return "deploy"; // very active but no pre-window history seen → treat as new (active launch)
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; try { await fn(items[idx], idx); } catch {} }
  }));
}

// only classify programs not already done (idempotent — safe to re-run)
const todo = snap.programs.filter((p) => p.deployType !== "deploy" && p.deployType !== "upgrade");
console.log(`classifying ${todo.length} of ${snap.programs.length} (rest already done)…`);
let done = 0;
await pool(todo, 4, async (p) => {
  p.deployType = await classify(p.programId);
  if (++done % 25 === 0) console.log(`  ${done}/${todo.length}…`);
});
const deploys = snap.programs.filter((p) => p.deployType === "deploy").length;
const upgrades = snap.programs.filter((p) => p.deployType === "upgrade").length;

snap.splitEnrichedAt = snap.generatedAt;
writeFileSync(snapUrl, JSON.stringify(snap, null, 2));
console.log(`\nsplit ${snap.programs.length} programs:`);
console.log(`  NEW DEPLOYS: ${deploys}  (${((deploys / snap.programs.length) * 100).toFixed(0)}%)`);
console.log(`  UPGRADES:    ${upgrades}  (${((upgrades / snap.programs.length) * 100).toFixed(0)}%)`);
