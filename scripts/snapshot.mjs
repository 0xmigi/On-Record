// Real mainnet snapshot. Enumerates recently deployed/upgraded upgradeable
// programs off the loader and, for each, resolves the signals the novelty
// model needs — verified source, published IDL, size, authority — then writes
// data/mainnet-snapshot.json and prints the spectrum.
//
//   node scripts/snapshot.mjs [--window-hours=48] [--max=400]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

// --- load .env into process.env (core reads HELIUS_API_KEY at import) --------
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const KEY = process.env.HELIUS_API_KEY;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;

// reuse the tested enumeration + IDL derivation from core's compiled output
const core = await import("../packages/core/dist/index.js");
const {
  enumerateProgramData, enumerateProgramAccounts, getSlot, probeProgramMetadata,
  getAccountBytes, extractStrings, getEarlyActivity,
} = core;

// well-known Solana funding sources — a direct hit means a credible deployer.
const KNOWN_FUNDERS = {
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9": "Binance",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM": "Binance",
  H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS: "Coinbase",
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S": "Coinbase",
  GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE: "Coinbase",
  AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2: "Bybit",
  "9un5wqE3q4oCjyrDkwsdD48KteCJitQX5978Vh7KKxHo": "OKX",
  A77HErqtfN1hLLpvZ9pCtu66FEtM8BveoaKbbMoZ4RiR: "Bitget",
};

// Trace the deploy authority's first funder: walk to its oldest reachable
// transaction, then find the account that sent it SOL. Returns the funder
// address + amount + a label when it's a known entity.
async function traceFunder(authority) {
  if (!authority) return { funder: null, label: null, amountSol: null };
  try {
    let before, oldest, pages = 0;
    while (pages++ < 5) {
      const sigs = await withRetry(() =>
        rpc("getSignaturesForAddress", [authority, { limit: 1000, before }]));
      if (!sigs.length) break;
      oldest = sigs[sigs.length - 1];
      if (sigs.length < 1000) break;
      before = oldest.signature;
    }
    if (!oldest) return { funder: null, label: null, amountSol: null };
    const tx = await withRetry(() =>
      rpc("getTransaction", [oldest.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" }]));
    if (!tx?.meta) return { funder: null, label: null, amountSol: null };
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
    const authIdx = keys.indexOf(authority);
    let funder = null, worst = 0;
    for (let i = 0; i < keys.length; i++) {
      if (i === authIdx) continue;
      const d = tx.meta.postBalances[i] - tx.meta.preBalances[i];
      if (d < worst) { worst = d; funder = keys[i]; }
    }
    if (!funder || funder === authority) return { funder: null, label: null, amountSol: null };
    return { funder, label: KNOWN_FUNDERS[funder] ?? null, amountSol: Number((-worst / 1e9).toFixed(4)) };
  } catch {
    return { funder: null, label: null, amountSol: null };
  }
}

// Squads multisig program ids (v3/v4) — an upgrade authority *account* owned by
// one of these is a multisig, not a hot wallet.
const SQUADS_PROGRAMS = new Set([
  "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu", // v3
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf", // v4
]);

const arg = (k, d) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const WINDOW_HOURS = Number(arg("window-hours", "48"));
const MAX = Number(arg("max", "400"));
const SLOTS_PER_SEC = 2.5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// retry with exponential backoff + jitter — Helius/OtterSec rate-limit bursts
async function withRetry(fn, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await sleep(200 * 2 ** i + Math.floor(Math.random() * 150)); }
  }
  throw last;
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (res.status === 429) throw new Error("429");
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

// account size without downloading the bytecode (len-0 slice still reports space)
async function programSize(pda) {
  const r = await withRetry(() =>
    rpc("getAccountInfo", [
      pda,
      { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" },
    ]),
  );
  return r?.value?.space ? r.value.space - 45 : null; // minus the 45-byte header
}

// OtterSec: verified = reproducible build matches on-chain hash; hasRepo = a
// source location is on record even if the build didn't reproduce (still findable)
async function checkVerified(programId) {
  try {
    const j = await withRetry(async () => {
      const res = await fetch(`https://verify.osec.io/status/${programId}`, {
        headers: { accept: "application/json" },
      });
      if (res.status === 429) throw new Error("429");
      if (!res.ok) return {};
      return res.json();
    });
    const repoUrl = j.repo_url && j.repo_url.length ? j.repo_url : null;
    return { verified: j.is_verified === true, hasRepo: Boolean(repoUrl), repoUrl, determined: true };
  } catch {
    return { verified: false, hasRepo: false, repoUrl: null, determined: false };
  }
}

const CAT_RULES = [
  ["defi", ["swap", "addliquidity", "removeliquidity", "deposit", "withdraw", "borrow", "repay", "lend", "stake", "staking", "unstake", "perp", "amm", "pool", "vault", "collateral", "liquidat", "farm", "yield", "margin", "liquidity", "dex", "trade"]],
  ["nft", ["metadata", "masteredition", "collection", "candymachine", "mintnft", "verifycreator", "editionmarker"]],
  ["governance", ["proposal", "governance", "realm", "castvote", "quorum", "council", "multisig", "timelock"]],
  ["infra", ["oracle", "pricefeed", "bridge", "relayer", "registry", "attestation", "messagetransmitter", "depin", "compute", "verifier"]],
  ["token", ["minttoken", "transferchecked", "createmint", "initializemint", "burnchecked", "presale", "airdrop", "bondingcurve", "launchpad"]],
];
// best category from any text (IDL instructions, name, or bytecode strings)
function bestCategory(haystack) {
  let best = "unknown", bestHits = 0;
  for (const [cat, needles] of CAT_RULES) {
    const hits = needles.filter((nd) => haystack.includes(nd)).length;
    if (hits > bestHits) { best = cat; bestHits = hits; }
  }
  return best;
}
function categorize(idl) {
  if (!idl?.instructions?.length) return "unknown";
  return bestCategory(idl.instructions.join(" ").toLowerCase().replace(/[_\s]/g, ""));
}

// --- bytecode-derived identity (the de-opaquer) ------------------------------
// Neodyme security.txt: a delimited, null-separated key/value block embedded in
// the program binary. Explorers ignore it; it's the richest free identity we get.
const SEC_KEYS = ["name", "project_url", "contacts", "policy", "source_code", "auditors", "expiry"];
function parseSecurityTxt(buf) {
  const latin = buf.toString("latin1");
  const begin = latin.indexOf("=======BEGIN SECURITY.TXT V1=======");
  if (begin < 0) return null;
  const end = latin.indexOf("=======END SECURITY.TXT V1=======", begin);
  if (end < 0) return null;
  const parts = latin.slice(begin + 35, end).split("\0").filter(Boolean);
  const out = {};
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (SEC_KEYS.includes(parts[i])) out[parts[i]] = parts[i + 1];
  }
  return Object.keys(out).length ? out : null;
}

function deriveIdentity(body) {
  const strings = extractStrings(body);
  const sec = parseSecurityTxt(body);
  // project/crate name from leaked Rust panic paths: programs/<name>/src/...
  let nameFromPath = null;
  for (const s of strings) {
    const m = s.match(/programs\/([a-z0-9][a-z0-9_-]{1,40})\/src\//i);
    if (m) { nameFromPath = m[1]; break; }
  }
  const repo =
    sec?.source_code ||
    strings.map((s) => (s.match(/https?:\/\/github\.com\/[^\s"']+/i) || [])[0]).find(Boolean) ||
    null;
  const social =
    (sec?.contacts && (sec.contacts.match(/https?:\/\/(x|twitter)\.com\/[^\s,"']+/i) || [])[0]) ||
    strings.map((s) => (s.match(/https?:\/\/(?:x|twitter)\.com\/[^\s"']+/i) || [])[0]).find(Boolean) ||
    null;
  const anchor = strings.some((s) => /anchor:idl|IdlCreateAccount|Constraint(HasOne|Signer|Seeds)/.test(s));
  const website =
    sec?.project_url ||
    strings.map((s) => (s.match(/https?:\/\/[a-z0-9.-]+\.(?:io|xyz|app|fi|so|finance|money|network)\b[^\s"']*/i) || [])[0]).find(Boolean) ||
    null;
  // category from the recovered NAME only — the clean signal. Raw bytecode
  // strings match too many incidental tokens ("pool"/"stake"/"deposit") and
  // over-classify everything as defi.
  const nameHay = (sec?.name ?? nameFromPath ?? "").toLowerCase().replace(/[_\s-]/g, "");
  return {
    name: sec?.name || nameFromPath || null,
    repoUrl: repo,
    social,
    website,
    hasSecurityTxt: Boolean(sec),
    anchor,
    category: nameHay ? bestCategory(nameHay) : "unknown",
  };
}

// authority structure from the authority account's owner
async function authorityClass(authority) {
  if (!authority) return "none"; // immutable
  try {
    const r = await withRetry(() =>
      rpc("getAccountInfo", [authority, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }]),
    );
    const owner = r?.value?.owner;
    if (!owner) return "hot_wallet";
    if (SQUADS_PROGRAMS.has(owner)) return "squads";
    if (owner === "11111111111111111111111111111111") return "hot_wallet"; // system-owned = plain wallet
    if (owner === "BPFLoaderUpgradeab1e11111111111111111111111") return "program";
    return "program"; // owned by some other program = programmatic control
  } catch {
    return "hot_wallet";
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await fn(items[idx], idx); }
        catch { out[idx] = null; }
      }
    }),
  );
  return out;
}

console.log(`Enumerating loader state (window ${WINDOW_HOURS}h, max ${MAX})…`);
const [pdHeaders, progAccounts, currentSlot] = await Promise.all([
  enumerateProgramData("mainnet"),
  enumerateProgramAccounts("mainnet"),
  getSlot("mainnet"),
]);
const pdToProgram = new Map(progAccounts.map((p) => [p.programDataAddress, p.programId]));
const cutoff = currentSlot - WINDOW_HOURS * 3600 * SLOTS_PER_SEC;

const recent = pdHeaders
  .filter((h) => h.deployedSlot >= cutoff && pdToProgram.has(h.programDataAddress))
  .sort((a, b) => b.deployedSlot - a.deployedSlot)
  .slice(0, MAX);

console.log(`Total ProgramData: ${pdHeaders.length.toLocaleString()} · in window: ${recent.length} · resolving signals…`);

// each signal is independently defaulted so a single failed sub-call never
// drops the whole program from the sample
// download bytecode once → sha256 (clone detection) + derived identity
async function bytecodeScan(pda) {
  const bytes = await withRetry(() => getAccountBytes("mainnet", pda));
  if (!bytes) return { sha256: null, sizeBytes: null, identity: null };
  let end = bytes.length;
  while (end > 45 && bytes[end - 1] === 0) end--;
  const body = bytes.subarray(45, end); // strip 45-byte header + zero padding
  return {
    sha256: createHash("sha256").update(body).digest("hex"),
    sizeBytes: body.length,
    identity: deriveIdentity(body),
  };
}

const rows = await pool(recent, 4, async (h) => {
  const programId = pdToProgram.get(h.programDataAddress);
  const ver = await checkVerified(programId);
  const idl = await withRetry(() => probeProgramMetadata("mainnet", programId)).then((m) => m.idl).catch(() => null);
  const bc = await bytecodeScan(h.programDataAddress).catch(() => ({ sha256: null, sizeBytes: null, identity: null }));
  const authClass = await authorityClass(h.upgradeAuthority);
  const deployedAtMs = Date.now() - (currentSlot - h.deployedSlot) * (1000 / SLOTS_PER_SEC);
  const [fund, earlyActivity] = await Promise.all([
    traceFunder(h.upgradeAuthority),
    getEarlyActivity("mainnet", programId, deployedAtMs, WINDOW_HOURS).catch(() => null),
  ]);
  const id = bc.identity;
  return {
    programId,
    deployedSlot: h.deployedSlot,
    deployedAt: new Date(deployedAtMs).toISOString(),
    authority: h.upgradeAuthority,
    authorityClass: authClass,
    immutable: h.upgradeAuthority === null,
    fundingSource: fund.label, // known entity label, else null
    funderAddress: fund.funder, // the wallet that funded the deployer
    fundingAmountSol: fund.amountSol,
    earlyActivity,
    sizeBytes: bc.sizeBytes,
    sha256: bc.sha256,
    verified: ver.verified,
    hasRepo: ver.hasRepo,
    repoUrl: ver.repoUrl || id?.repoUrl || null,
    name: id?.name ?? null,
    social: id?.social ?? null,
    website: id?.website ?? null,
    hasSecurityTxt: id?.hasSecurityTxt ?? false,
    anchor: id?.anchor ?? false,
    idlPresent: Boolean(idl),
    instructionCount: idl?.instructions?.length ?? null,
    // IDL-derived category wins; else infer from the bytecode (name + strings)
    category: (() => {
      const c = categorize(idl);
      return c !== "unknown" ? c : (id?.category ?? "unknown");
    })(),
  };
});

// ---- dedup gate: exact sha256 clusters within the window -------------------
const shaCounts = {};
for (const r of rows) if (r.sha256) shaCounts[r.sha256] = (shaCounts[r.sha256] ?? 0) + 1;
const AUTH_SIG = { squads: 1, none: 0.8, program: 0.6, hot_wallet: 0.2 };
const isFindable = (r) => r.verified || r.hasRepo || r.idlPresent || r.hasSecurityTxt || Boolean(r.name);
// funding credibility: known CEX/entity funder > any traced funder > untraceable
const fundSigOf = (r) => (r.fundingSource ? 0.8 : r.funderAddress ? 0.35 : 0);

for (const r of rows) {
  const c = r.sha256 ? shaCounts[r.sha256] : 1;
  r.clusterSize = c;
  r.band = c > 1 ? "clone" : "novel"; // exact twin in window = clone; unique = novel candidate
  r.findable = isFindable(r);
  // novelty/interest score from real signals: unique bytecode, is it identifiable,
  // credible control + funding, real early usage, instruction surface
  const unique = r.band === "novel" ? 1 : 0;
  const identifiable = r.findable ? 1 : 0;
  const authSig = AUTH_SIG[r.authorityClass] ?? 0;
  const fundSig = fundSigOf(r);
  const usageSig = Math.min(1, (r.earlyActivity ?? 0) / 50);
  const surface = Math.min(1, (r.instructionCount ?? 0) / 30);
  r.noveltyScore = Number(
    (0.30 * unique + 0.20 * identifiable + 0.15 * authSig + 0.15 * usageSig + 0.12 * surface + 0.08 * fundSig).toFixed(3),
  );
}

// ---- spectrum report --------------------------------------------------------
const n = rows.length;
const pct = (c) => `${((c / n) * 100).toFixed(1)}%`;
const verified = rows.filter((r) => r.verified).length;
const hasRepo = rows.filter((r) => r.hasRepo || r.repoUrl).length;
const withIdl = rows.filter((r) => r.idlPresent).length;
const withSecTxt = rows.filter((r) => r.hasSecurityTxt).length;
const named = rows.filter((r) => r.name).length;
const findable = rows.filter((r) => r.findable).length;
const immutable = rows.filter((r) => r.immutable).length;
const tally = (key) => {
  const t = {};
  for (const r of rows) t[r[key] ?? "null"] = (t[r[key] ?? "null"] ?? 0) + 1;
  return Object.entries(t).sort((a, b) => b[1] - a[1]);
};
const sizes = rows.map((r) => r.sizeBytes).filter((s) => s != null).sort((a, b) => a - b);
const q = (p) => sizes[Math.floor((sizes.length - 1) * p)] ?? 0;
const catCounts = {};
for (const r of rows) catCounts[r.category] = (catCounts[r.category] ?? 0) + 1;

const uniqueSha = new Set(rows.map((r) => r.sha256).filter(Boolean)).size;
const clones = rows.filter((r) => r.band === "clone").length;
const novel = rows.filter((r) => r.band === "novel").length;

console.log(`\n=== REAL MAINNET SNAPSHOT — last ${WINDOW_HOURS}h ===`);
console.log(`programs (deployed or upgraded):  ${n}`);
console.log(`unique bytecode:                  ${uniqueSha}  ${pct(uniqueSha)}`);
console.log(`exact clones (twin in window):    ${clones}  ${pct(clones)}`);
console.log(`unique-in-window (novel cand.):   ${novel}  ${pct(novel)}`);
console.log(`— identity —`);
console.log(`verified build (reproduces):      ${verified}  ${pct(verified)}`);
console.log(`repo on record (OtterSec/binary): ${hasRepo}  ${pct(hasRepo)}`);
console.log(`published Anchor IDL:             ${withIdl}  ${pct(withIdl)}`);
console.log(`security.txt in binary:           ${withSecTxt}  ${pct(withSecTxt)}`);
console.log(`name recovered from binary:       ${named}  ${pct(named)}`);
console.log(`FINDABLE (any signal):            ${findable}  ${pct(findable)}`);
console.log(`truly opaque (nothing at all):    ${n - findable}  ${pct(n - findable)}`);
console.log(`— control —`);
for (const [k, v] of tally("authorityClass")) console.log(`   auth ${k.padEnd(11)} ${v}  ${pct(v)}`);
const funderTraced = rows.filter((r) => r.funderAddress).length;
const funderKnown = rows.filter((r) => r.fundingSource).length;
console.log(`— deployer funding —`);
console.log(`   funder traced:  ${funderTraced}  ${pct(funderTraced)}`);
console.log(`   known entity:   ${funderKnown}  ${pct(funderKnown)}`);
console.log(`— size KB p10/p50/p90: ${(q(0.1)/1024).toFixed(0)} / ${(q(0.5)/1024).toFixed(0)} / ${(q(0.9)/1024).toFixed(0)} —`);
console.log(`category spectrum:`);
for (const [c, k] of Object.entries(catCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`   ${c.padEnd(11)} ${k}  ${pct(k)}`);
}

mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
const snapshot = {
  generatedAt: new Date().toISOString(),
  network: "mainnet",
  windowHours: WINDOW_HOURS,
  currentSlot,
  totals: { programDataAccounts: pdHeaders.length, inWindow: recent.length, sampled: n },
  stats: {
    uniqueBytecode: uniqueSha, clones, novel,
    verified, hasRepo, withIdl, withSecurityTxt: withSecTxt, named, findable, opaque: n - findable, immutable,
    byAuthority: Object.fromEntries(tally("authorityClass")),
    funderTraced, funderKnown,
    sizeKb: { p10: Math.round(q(0.1) / 1024), p50: Math.round(q(0.5) / 1024), p90: Math.round(q(0.9) / 1024) },
    byCategory: catCounts,
  },
  programs: rows,
};
const out = new URL("../data/mainnet-snapshot.json", import.meta.url);
writeFileSync(out, JSON.stringify(snapshot, null, 2));
console.log(`\nwrote ${out.pathname}`);
void createHash;
