// Fuzzy novelty: fingerprint every program (MinHash over bytecode) plus a
// corpus of famous reference programs, then for each new program find its
// nearest known relative. novelty = 1 − similarity to that relative.
//   "no known relative" = genuinely novel; "88% ~ Raydium CLMM" = a fork.
import { readFileSync, writeFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const core = await import("../packages/core/dist/index.js");
const { getProgramDataAddress, getAccountBytes, minhashSignature, minhashSimilarity } = core;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, t = 4) { let e; for (let i = 0; i < t; i++) { try { return await fn(); } catch (x) { e = x; await sleep(200 * 2 ** i); } } throw e; }

// famous programs to lineage against (mostly upgradeable; non-upgradeable handled too)
const REFERENCES = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CPMM",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap AMM",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Metadata",
  SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: "Squads v4",
  GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw: "SPL Governance",
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcqYwqW: "Drift v2",
  PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: "Phoenix",
  KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD: "Kamino Lend",
};

async function getCode(programId) {
  try {
    const pda = await withRetry(() => getProgramDataAddress("mainnet", programId));
    if (pda) {
      const b = await withRetry(() => getAccountBytes("mainnet", pda));
      if (b && b.length > 45) {
        let end = b.length;
        while (end > 45 && b[end - 1] === 0) end--;
        return b.subarray(45, end);
      }
    }
  } catch {}
  try {
    const b = await withRetry(() => getAccountBytes("mainnet", programId));
    if (b && b.length > 4 && b.readUInt32BE(0) === 0x7f454c46) return b;
  } catch {}
  return null;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; try { await fn(items[idx], idx); } catch {} }
  }));
}

const snapUrl = new URL("../data/mainnet-snapshot.json", import.meta.url);
const snap = JSON.parse(readFileSync(snapUrl, "utf8"));

// 1. reference signatures (cached in snap._refs — idempotent)
const refs = snap._refs ?? [];
const haveRefs = new Set(refs.map((r) => r.name));
const missingRefs = Object.entries(REFERENCES).filter(([, name]) => !haveRefs.has(name));
console.log(`fingerprinting ${missingRefs.length} reference programs (${refs.length} cached)…`);
await pool(missingRefs, 4, async ([id, name]) => {
  const code = await getCode(id);
  if (code) refs.push({ name, sig: minhashSignature(code) });
});
snap._refs = refs;
console.log(`  ${refs.length} references total`);

// 2. signatures for every program in the window — skip ones already done
const todo = snap.programs.filter((p) => !p._sig);
console.log(`fingerprinting ${todo.length} window programs (${snap.programs.length - todo.length} cached)…`);
let done = 0;
await pool(todo, 4, async (p) => {
  const code = await getCode(p.programId);
  if (code) p._sig = minhashSignature(code);
  if (++done % 50 === 0) console.log(`  ${done}/${todo.length}…`);
});

// 3. nearest known relative for each program (references + peers, excluding self)
const withSig = snap.programs.filter((p) => p._sig && p._sig.length);
for (const p of snap.programs) {
  if (!p._sig || !p._sig.length) { p.novelty = null; p.nearest = null; continue; }
  let best = { sim: 0, name: null, id: null, isRef: false };
  for (const r of refs) {
    const s = minhashSimilarity(p._sig, r.sig);
    if (s > best.sim) best = { sim: s, name: r.name, id: null, isRef: true };
  }
  for (const q of withSig) {
    if (q.programId === p.programId) continue;
    const s = minhashSimilarity(p._sig, q._sig);
    if (s > best.sim) best = { sim: s, name: q.name ?? null, id: q.programId, isRef: false };
  }
  p.novelty = Number((1 - best.sim).toFixed(3));
  p.nearest = best.sim > 0.15 ? { name: best.name, id: best.id, similarity: Number(best.sim.toFixed(3)), isReference: best.isRef } : null;
}
// keep _sig + _refs cached so re-runs only fill gaps (cleaned by --finalize)
if (process.argv.includes("--finalize")) {
  for (const p of snap.programs) delete p._sig;
  delete snap._refs;
}
writeFileSync(snapUrl, JSON.stringify(snap, null, 2));

// 4. report
const scored = snap.programs.filter((p) => p.novelty != null);
const n = scored.length;
const forks = scored.filter((p) => p.novelty <= 0.4);
const variants = scored.filter((p) => p.novelty > 0.4 && p.novelty <= 0.7);
const novel = scored.filter((p) => p.novelty > 0.7);
const pct = (c) => `${((c / n) * 100).toFixed(0)}%`;
console.log(`\n=== FUZZY NOVELTY (${n} fingerprinted) ===`);
console.log(`  forks / near-copies (novelty ≤ .40): ${forks.length}  ${pct(forks.length)}`);
console.log(`  variants (.40–.70):                  ${variants.length}  ${pct(variants.length)}`);
console.log(`  genuinely novel (> .70):             ${novel.length}  ${pct(novel.length)}`);
const refLineage = {};
for (const p of scored) if (p.nearest?.isReference) refLineage[p.nearest.name] = (refLineage[p.nearest.name] ?? 0) + 1;
console.log(`\n  strongest lineages to known protocols:`);
for (const [k, v] of Object.entries(refLineage).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`    ${k.padEnd(20)} ${v}`);
console.log(`\n  most novel new programs:`);
for (const p of scored.filter((x) => x.deployType !== "upgrade").sort((a, b) => b.novelty - a.novelty).slice(0, 8)) {
  console.log(`    ${(p.name || p.programId.slice(0, 10)).padEnd(24)} novelty ${p.novelty}`);
}
