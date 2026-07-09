// Serves the REAL mainnet snapshot (data/mainnet-snapshot.json) in the On Record
// API shapes, so the web app runs on real chain data instead of mock.
//   node scripts/snapshot-api.mjs   → :3001
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const snap = JSON.parse(
  readFileSync(new URL("../data/mainnet-snapshot.json", import.meta.url), "utf8"),
);
// 30-day deploy/upgrade volume series (for the chart's window toggle)
let volume = [];
try {
  volume = JSON.parse(
    readFileSync(new URL("../data/volume-series.json", import.meta.url), "utf8"),
  ).points;
} catch {}
const PORT = 3001;

const toProgram = (p) => ({
  id: p.programId,
  network: "mainnet",
  name: p.name ?? null,
  deployedSlot: p.deployedSlot,
  deployedAt: p.deployedAt,
  lastEventAt: p.deployedAt,
  band: p.band,
  // real novelty = fuzzy distance to nearest known program; fall back to the
  // old blend only if the program wasn't fingerprinted
  noveltyScore: p.novelty ?? p.noveltyScore ?? 0,
  nearest: p.nearest ?? null, // lineage: { name, id, similarity, isReference }
  category: categoryOf(p),
  sizeBytes: p.sizeBytes,
  instructionCount: p.instructionCount,
  idlPresent: p.idlPresent,
  authorityClass: p.authorityClass ?? null,
  deployerFundingSource: p.fundingSource && p.fundingSource !== "unknown" ? p.fundingSource : null,
  funderAddress: p.funderAddress ?? null,
  fundingAmountSol: p.fundingAmountSol ?? null,
  earlySigners: p.earlyActivity ?? null,
  verified: p.verified,
  bucketId: p.clusterSize > 1 && p.sha256 ? `clu_${p.sha256.slice(0, 12)}` : null,
  clusterSize: p.clusterSize > 1 ? p.clusterSize : null,
  deployType: p.deployType === "upgrade" ? "upgrade" : "deploy",
  // identity recovered from the binary — the de-opaquer
  repoUrl: realRepo(p.repoUrl),
  social: p.social ?? null,
  website: p.website ?? null,
  hasSecurityTxt: p.hasSecurityTxt ?? false,
  anchor: p.anchor ?? false,
  // structured program profile (ELF-parsed)
  framework: p.profile?.framework ?? null,
  capabilities: p.profile?.capabilities ?? [],
  integrations: p.profile?.integrations ?? [],
  syscallCount: p.profile?.syscalls?.length ?? null,
});

// category from the recovered name (clean) — the stored category was derived
// from raw bytecode strings which over-classify as defi. IDL-derived category
// (only when an IDL was actually published) is trusted.
const CAT_RULES = [
  ["defi", ["swap", "liquidity", "deposit", "withdraw", "borrow", "lend", "stake", "staking", "perp", "amm", "clmm", "dlmm", "pool", "vault", "farm", "yield", "margin", "dex", "trade", "arb", "arbitrage", "router", "pairs", "market", "order", "otc", "option", "lp", "restake", "earn"]],
  ["gaming", ["game", "coinflip", "flip", "casino", "bet", "betting", "parimutuel", "lottery", "raffle", "dice", "wheel", "slot", "wager", "pvp", "arena", "quest", "loot", "prediction", "predict"]],
  ["payments", ["pay", "payment", "payout", "invoice", "subscription", "tip", "escrow", "checkout", "ads", "billing", "remit"]],
  ["nft", ["nft", "metadata", "edition", "collection", "candymachine", "creator", "mintnft", "pfp"]],
  ["governance", ["governance", "proposal", "realm", "vote", "dao", "council", "multisig", "timelock", "treasury"]],
  ["infra", ["oracle", "pricefeed", "bridge", "relayer", "registry", "depin", "verifier", "attestation", "indexer", "keeper", "crank", "relay"]],
  ["token", ["token", "coin", "airdrop", "faucet", "presale", "launch", "pump", "bonding", "fairlaunch", "vesting", "lock"]],
];
function nameCategory(name) {
  if (!name) return "unknown";
  const hay = name.toLowerCase().replace(/[_\s-]/g, "");
  let best = "unknown", hits = 0;
  for (const [cat, needles] of CAT_RULES) {
    const h = needles.filter((n) => hay.includes(n)).length;
    if (h > hits) { best = cat; hits = h; }
  }
  return best;
}
function categoryOf(p) {
  if (p.idlPresent && p.category && p.category !== "unknown") return p.category; // real IDL signal
  return nameCategory(p.name);
}

// toolchain / compiler repos leak into every binary's linker string — they are
// NOT the program's own source. Filter them so we don't imply false authorship.
const TOOLCHAIN_REPO = /llvm-project|rust-lang\/rust|anza-xyz\/(llvm|platform-tools)|solana-labs\/(rust|llvm)/i;
function realRepo(url) {
  return url && !TOOLCHAIN_REPO.test(url) ? url : null;
}

const byId = new Map(snap.programs.map((p) => [p.programId, p]));

function radar(q) {
  const type = q.get("type") === "upgrade" ? "upgrade" : "deploy";
  const limit = Math.min(Number(q.get("limit") || 40), 100);
  const nov = (p) => p.novelty ?? p.noveltyScore ?? 0;
  const items = snap.programs
    .filter((p) => (p.deployType === "upgrade" ? "upgrade" : "deploy") === type)
    .sort((a, b) => nov(b) - nov(a) || b.deployedSlot - a.deployedSlot)
    .map(toProgram);
  const start = Number(q.get("cursor") || 0);
  const page = items.slice(start, start + limit);
  return { items: page, nextCursor: start + limit < items.length ? String(start + limit) : null };
}

const WINDOW_HOURS = { "24h": 24, "48h": 48, "7d": 168, "30d": 720 };

function funnel(q) {
  const reqHours = WINDOW_HOURS[q?.get?.("window")] ?? 48;
  // we only have ~48h of enriched data, so the bar aggregates cap at 48h
  const aggHours = Math.min(reqHours, 48);
  const refNow = Date.parse(snap.generatedAt);
  const cutoff = refNow - aggHours * 3600 * 1000;
  const programs = snap.programs.filter((p) => {
    const t = Date.parse(p.deployedAt);
    return Number.isNaN(t) ? true : t >= cutoff;
  });

  // compute directly from the programs so raw ≥ unique ≥ novel always holds
  const withSha = programs.filter((p) => p.sha256);
  const shaCount = {};
  for (const p of withSha) shaCount[p.sha256] = (shaCount[p.sha256] ?? 0) + 1;
  const unique = new Set(withSha.map((p) => p.sha256)).size;
  const clones = withSha.filter((p) => shaCount[p.sha256] > 1).length;
  const novelRows = withSha.filter((p) => shaCount[p.sha256] === 1);
  // category breakdown over NEW DEPLOYS (the meaningful set), not upgrades
  const newDeploys = programs.filter((p) => p.deployType !== "upgrade");
  const byCategory = {};
  for (const p of newDeploys) {
    const c = categoryOf(p);
    byCategory[c] = (byCategory[c] ?? 0) + 1;
  }
  const deploys = newDeploys.length;
  const upgrades = programs.filter((p) => p.deployType === "upgrade").length;
  // framework + integration distribution over new deploys (the profiler output)
  const byFramework = {};
  const byIntegration = {};
  for (const p of newDeploys) {
    if (p.profile?.framework) byFramework[p.profile.framework] = (byFramework[p.profile.framework] ?? 0) + 1;
    for (const it of p.profile?.integrations ?? []) byIntegration[it] = (byIntegration[it] ?? 0) + 1;
  }

  // --- time series: bucket the window's new deploys by time so we can show a
  // real trend (increase/decrease of frameworks/categories over the window) ---
  const N = 6;
  const times = newDeploys.map((p) => Date.parse(p.deployedAt)).filter((t) => !Number.isNaN(t));
  const tEnd = Math.max(...times, refNow);
  const tStart = tEnd - aggHours * 3600 * 1000;
  const span = (tEnd - tStart) / N || 1;
  const buckets = Array.from({ length: N }, (_, i) => ({
    hoursAgo: Math.round((aggHours * (N - i)) / N),
    deploys: 0,
    framework: {},
    category: {},
  }));
  for (const p of newDeploys) {
    const t = Date.parse(p.deployedAt);
    if (Number.isNaN(t)) continue;
    let i = Math.floor((t - tStart) / span);
    i = Math.max(0, Math.min(N - 1, i));
    buckets[i].deploys++;
    const fw = p.profile?.framework;
    if (fw) buckets[i].framework[fw] = (buckets[i].framework[fw] ?? 0) + 1;
    const cat = categoryOf(p);
    buckets[i].category[cat] = (buckets[i].category[cat] ?? 0) + 1;
  }
  // per-framework trend: share in the first half vs second half of the window
  const shareOf = (arr, key, dim) => {
    let f = 0, tot = 0;
    for (const b of arr) { f += b[dim][key] ?? 0; tot += b.deploys; }
    return tot ? f / tot : 0;
  };
  const early = buckets.slice(0, N / 2);
  const late = buckets.slice(N / 2);
  const frameworkTrend = Object.keys(byFramework)
    .map((fw) => {
      const e = shareOf(early, fw, "framework");
      const l = shareOf(late, fw, "framework");
      return { framework: fw, current: byFramework[fw], earlyShare: e, lateShare: l, delta: l - e };
    })
    .sort((a, b) => b.current - a.current);

  // --- per-vector aggregates across the window's new deploys ---
  const byCapability = {};
  for (const p of newDeploys) for (const c of p.profile?.capabilities ?? []) byCapability[c] = (byCapability[c] ?? 0) + 1;

  // 1 Identity: how identifiable
  const identity = {
    named: newDeploys.filter((p) => p.name).length,
    withRepo: newDeploys.filter((p) => realRepo(p.repoUrl)).length,
    opaque: newDeploys.filter((p) => !p.name && !realRepo(p.repoUrl) && !p.hasSecurityTxt).length,
  };
  // 2 Lineage: novel vs derived (needs a fingerprint)
  const scored = newDeploys.filter((p) => p.novelty != null);
  const lineage = {
    novel: scored.filter((p) => p.novelty > 0.7).length,
    variant: scored.filter((p) => p.novelty > 0.4 && p.novelty <= 0.7).length,
    fork: scored.filter((p) => p.novelty <= 0.4).length,
  };
  // 4 Control: who can change it
  const control = {
    mutable: newDeploys.filter((p) => p.authorityClass && p.authorityClass !== "none").length,
    frozen: newDeploys.filter((p) => p.authorityClass === "none").length,
    verified: newDeploys.filter((p) => p.verified).length,
  };
  // 5 Conviction: funding provenance
  const conviction = {
    knownEntity: newDeploys.filter((p) => p.fundingSource).length,
    funderTraced: newDeploys.filter((p) => p.funderAddress && !p.fundingSource).length,
    untraced: newDeploys.filter((p) => !p.funderAddress && !p.fundingSource).length,
  };

  const s = snap.stats;
  return {
    date: snap.generatedAt.slice(0, 10),
    raw: programs.length,
    unique,
    novel: novelRows.length,
    clones,
    variants: 0, // fuzzy (TLSH) clustering not run in the snapshot pass
    deploys,
    upgrades,
    windowHours: reqHours, // requested window (drives the chart)
    aggregateWindowHours: aggHours, // window the bar aggregates actually cover
    capped: reqHours > 48, // true when the request exceeds our enriched data
    byCategory,
    byFramework,
    byIntegration,
    byCapability,
    identity,
    lineage,
    control,
    conviction,
    series: buckets,
    volume,
    frameworkTrend,
    updatedAt: snap.generatedAt,
    // extra real context the funnel page can surface
    meta: {
      totalUpgradeablePrograms: snap.totals.programDataAccounts,
      findable: s.findable,
      opaque: s.opaque,
      named: s.named,
      withSecurityTxt: s.withSecurityTxt,
      verified: s.verified,
      withIdl: s.withIdl,
    },
  };
}

function programDetail(id) {
  const p = byId.get(id);
  if (!p) return null;
  return {
    ...toProgram(p),
    authority: p.authority,
    sha256: p.sha256,
    events: [
      {
        id: `evt_${id.slice(0, 8)}`,
        network: "mainnet",
        type: "deploy",
        signature: `~slot ${p.deployedSlot}`,
        slot: p.deployedSlot,
        blockTime: p.deployedAt,
        programId: id,
        authorityBefore: null,
        authorityAfter: p.authority,
        sha256After: p.sha256,
      },
    ],
    neighbors: [], // needs TLSH fuzzy corpus scan — not in the snapshot pass
    idlInstructions: [], // instruction names not stored in this snapshot
    strings: [],
  };
}

function cluster(id) {
  const members = snap.programs.filter(
    (p) => p.sha256 && `clu_${p.sha256.slice(0, 12)}` === id,
  );
  if (!members.length) return null;
  return {
    id,
    label: null,
    canonicalSha256: members[0].sha256,
    memberCount: members.length,
    velocity6h: members.length,
    members: members.map((m) => ({ programId: m.programId, deployedAt: m.deployedAt })),
  };
}

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const q = url.searchParams;
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("content-type", "application/json");
  const send = (obj, code = 200) => {
    res.statusCode = obj == null ? 404 : code;
    res.end(JSON.stringify(obj == null ? { error: "not found" } : obj));
  };

  const path = url.pathname;
  if (path === "/api/radar") return send(radar(q));
  if (path === "/api/funnel") return send(funnel(q));
  if (path.startsWith("/api/programs/")) return send(programDetail(decodeURIComponent(path.slice(14))));
  if (path.startsWith("/api/clusters/")) return send(cluster(decodeURIComponent(path.slice(14))));
  if (path === "/api/raw/events") {
    return send({ items: snap.programs.slice(0, 50).map((p) => programDetail(p.programId).events[0]), nextCursor: null });
  }
  if (path === "/health") return send({ ok: true, source: "real-snapshot", programs: snap.programs.length });
  return send({ error: "unknown route" }, 404);
}).listen(PORT, () => {
  console.log(`real-snapshot API on :${PORT} — ${snap.programs.length} real mainnet programs (${snap.generatedAt})`);
});
