// Read-only devnet census (ROADMAP §1 "Phase 0") — sizes the devnet radar
// before building it. Enumerates ProgramData HEADERS only (45-byte dataSlice,
// no bytecode), so the whole run costs ~1 credit per 10k programs.
//
//   node scripts/devnet-census.mjs [--network=devnet]
//
// Answers: deploys+upgrades/day (by last-deploy slot), total programs, size
// distribution of the recent cohort, deployer-authority concentration (the
// farm/spam proxy). Writes data/devnet-census.json. NO database writes.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const HEADER_LEN = 45; // 4 tag + 8 slot + 1 option + 32 authority

const network = process.argv.includes("--network=mainnet") ? "mainnet" : "devnet";

// --- env ---------------------------------------------------------------
const env = Object.fromEntries(
  readFileSync(join(ROOT, ".env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const KEY = env.HELIUS_API_KEY;
if (!KEY) throw new Error("HELIUS_API_KEY missing from .env");
const URL = `https://${network}.helius-rpc.com/?api-key=${KEY}`;

let credits = 0;
async function rpc(method, params, cost = 1) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    credits += cost;
    return body.result;
  }
  throw new Error(`${method}: rate-limited after retries`);
}

// --- base58 (no deps) ----------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(buf) {
  const d = [];
  let s = "";
  for (const byte of buf) {
    let carry = byte;
    for (let j = 0; j < d.length; j++) {
      carry += d[j] << 8;
      d[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      d.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (const byte of buf) {
    if (byte) break;
    s += "1";
  }
  for (let i = d.length - 1; i >= 0; i--) s += B58[d[i]];
  return s;
}

// --- 1. slot clock ------------------------------------------------------
const currentSlot = await rpc("getSlot", [{ commitment: "confirmed" }]);
const SPAN = 2_000_000; // ~9-10 days
const [tNow, tPast] = [
  await rpc("getBlockTime", [currentSlot - 100]), // very recent, certainly rooted
  await rpc("getBlockTime", [currentSlot - SPAN]),
];
const slotSecs = (tNow - tPast) / (SPAN - 100);
const slotsPerDay = Math.round(86_400 / slotSecs);
console.error(`slot=${currentSlot} slotSecs=${slotSecs.toFixed(3)} slots/day=${slotsPerDay}`);

// --- 2. enumerate ProgramData headers, paginated -------------------------
const tag = b58(Buffer.from([3, 0, 0, 0]));
const baseCfg = {
  encoding: "base64",
  filters: [{ memcmp: { offset: 0, bytes: tag } }],
  dataSlice: { offset: 0, length: HEADER_LEN },
  commitment: "confirmed",
};

const rows = []; // {slot, authority|null, space}
let paginationKey = null;
let pages = 0;
let v2 = true;
try {
  do {
    const cfg = { ...baseCfg, limit: 10_000, ...(paginationKey ? { paginationKey } : {}) };
    const result = await rpc("getProgramAccountsV2", [LOADER, cfg]);
    const accounts = result.accounts ?? result;
    for (const row of accounts) {
      const buf = Buffer.from(row.account.data[0], "base64");
      if (buf.length < 13 || buf.readUInt32LE(0) !== 3) continue;
      rows.push({
        slot: Number(buf.readBigUInt64LE(4)),
        authority: buf[12] === 1 ? b58(buf.subarray(13, 45)) : null,
        space: row.account.space ?? null,
      });
    }
    paginationKey = result.paginationKey ?? null;
    pages++;
    if (pages % 10 === 0) console.error(`  …page ${pages}, ${rows.length} headers`);
  } while (paginationKey);
} catch (err) {
  if (!String(err).includes("Method not found")) throw err;
  // V2 unsupported → single V1 sweep (10 credits)
  v2 = false;
  console.error("V2 unavailable, falling back to one getProgramAccounts sweep");
  const result = await rpc("getProgramAccounts", [LOADER, baseCfg], 10);
  for (const row of result) {
    const buf = Buffer.from(row.account.data[0], "base64");
    if (buf.length < 13 || buf.readUInt32LE(0) !== 3) continue;
    rows.push({
      slot: Number(buf.readBigUInt64LE(4)),
      authority: buf[12] === 1 ? b58(buf.subarray(13, 45)) : null,
      space: row.account.space ?? null,
    });
  }
}
console.error(`enumerated ${rows.length} ProgramData accounts in ${pages || 1} page(s)`);

// --- 3. aggregate ---------------------------------------------------------
const windows = { "1d": 1, "2d": 2, "7d": 7, "30d": 30 };
const counts = {};
for (const [k, days] of Object.entries(windows)) {
  const cutoff = currentSlot - days * slotsPerDay;
  counts[k] = rows.filter((r) => r.slot >= cutoff).length;
}

// size distribution + authority concentration over the 7d cohort
const cohort = rows.filter((r) => r.slot >= currentSlot - 7 * slotsPerDay);
const KB = 1024;
const sizeBuckets = { "<25KB": 0, "25-50KB": 0, "50-100KB": 0, "100-300KB": 0, "300KB-1MB": 0, ">=1MB": 0, unknown: 0 };
for (const r of cohort) {
  const bytes = r.space != null ? r.space - HEADER_LEN : null;
  if (bytes == null) sizeBuckets.unknown++;
  else if (bytes < 25 * KB) sizeBuckets["<25KB"]++;
  else if (bytes < 50 * KB) sizeBuckets["25-50KB"]++;
  else if (bytes < 100 * KB) sizeBuckets["50-100KB"]++;
  else if (bytes < 300 * KB) sizeBuckets["100-300KB"]++;
  else if (bytes < 1024 * KB) sizeBuckets["300KB-1MB"]++;
  else sizeBuckets[">=1MB"]++;
}

const byAuthority = new Map();
for (const r of cohort) {
  const k = r.authority ?? "(none/frozen)";
  byAuthority.set(k, (byAuthority.get(k) ?? 0) + 1);
}
const topAuthorities = [...byAuthority.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([authority, n]) => ({ authority, n, share: +(n / Math.max(1, cohort.length)).toFixed(3) }));
const top10Share = +topAuthorities.reduce((a, t) => a + t.share, 0).toFixed(3);

const out = {
  network,
  capturedAt: new Date().toISOString(),
  currentSlot,
  slotSecs: +slotSecs.toFixed(4),
  totalProgramData: rows.length,
  // NOTE: header slot = LAST deploy slot — a program upgraded 5× in-window
  // counts once. These are "programs touched per window", a LOWER bound on
  // deploy+upgrade events.
  programsTouched: counts,
  perDay: { last2d: Math.round(counts["2d"] / 2), last7d: Math.round(counts["7d"] / 7), last30d: Math.round(counts["30d"] / 30) },
  sizeDistribution7d: sizeBuckets,
  cohort7d: cohort.length,
  authorityTop10_7d: topAuthorities,
  authorityTop10Share7d: top10Share,
  distinctAuthorities7d: byAuthority.size,
  creditsSpent: credits,
  paginatedV2: v2,
};
writeFileSync(join(ROOT, "data", "devnet-census.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
