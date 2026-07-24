// Zero-dependency mock of the On Record v2 read API (the radar), for fast UI
// iteration without Postgres/Redis/Docker. Serves a seeded "demo day" of novel
// Solana programs, clone clusters, and a consistent funnel snapshot.
// Run: node scripts/mock-api.mjs   (listens on :3001)
//
// The web app (apps/web) reads from API_URL — point it here:
//   API_URL=http://localhost:3001 pnpm --filter @onrecord/web dev
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 3001);
const NOW = Date.now();
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const today = new Date(NOW).toISOString().slice(0, 10);

// --- deterministic pseudo-random address / hash generation -----------------
// Seeded so ids/hashes are stable across restarts (the UI keeps working).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const HEX = "0123456789abcdef";
function pick(rng, alphabet, len) {
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}
let seedCounter = 1;
function addr(prefix = "") {
  const rng = mulberry32(0x9e37 * seedCounter++ + 17);
  const body = pick(rng, B58, 44 - prefix.length);
  return (prefix + body).slice(0, 44);
}
function sha256() {
  const rng = mulberry32(0x1f83 * seedCounter++ + 3);
  return pick(rng, HEX, 64);
}
function sig() {
  const rng = mulberry32(0x2c1b * seedCounter++ + 7);
  return pick(rng, B58, 88);
}

const BASE_SLOT = 334_900_000;

// --- clone / variant clusters ---------------------------------------------
const CLUSTERS = {
  clu_photon: {
    id: "clu_photon",
    label: "Photon launcher fork",
    canonicalSha256: sha256(),
    memberCount: 34,
    velocity6h: 11,
    category: "token",
  },
  clu_dlmm: {
    id: "clu_dlmm",
    label: "Meteora DLMM variant",
    canonicalSha256: sha256(),
    memberCount: 7,
    velocity6h: 2,
    category: "defi",
  },
  clu_spltoken: {
    id: "clu_spltoken",
    label: "SPL token clone",
    canonicalSha256: sha256(),
    memberCount: 118,
    velocity6h: 40,
    category: "token",
  },
};

// --- programs --------------------------------------------------------------
// meta -> full ApiProgram (id + sha256 generated). instructionCount defaults
// to idl length when an IDL is published.
function program(meta) {
  const id = meta.id ?? addr();
  const idl = meta.idl ?? [];
  const idlPresent = idl.length > 0;
  const instructionCount =
    meta.instructionCount !== undefined
      ? meta.instructionCount
      : idlPresent
        ? idl.length
        : null;
  return {
    id,
    network: "mainnet",
    name: meta.name ?? null,
    deployedSlot: BASE_SLOT - Math.round(meta.hoursAgo * 150),
    deployedAt: iso(meta.hoursAgo),
    lastEventAt: iso(meta.lastAgo ?? meta.hoursAgo),
    band: meta.band,
    noveltyScore: meta.score,
    category: meta.category,
    sizeBytes: meta.sizeBytes ?? null,
    instructionCount,
    idlPresent,
    authorityClass: meta.authorityClass,
    deployerFundingSource: meta.funding ?? null,
    earlySigners: meta.signers ?? null,
    verified: meta.verified ?? false,
    bucketId: meta.bucketId ?? null,
    clusterSize: meta.clusterSize ?? null,
    // extras kept for detail assembly (stripped from radar rows):
    _sha256: meta.sha256 ?? sha256(),
    _idl: idl,
    _repoUrl: meta.repoUrl ?? null,
    _authority: meta.authorityClass === "none" ? null : meta.authority ?? addr(),
    _neighbors: meta.neighbors ?? [],
    _strings: meta.strings ?? [],
    _events: meta.events ?? null,
  };
}

const NOVEL = [
  program({
    name: null,
    band: "novel",
    score: 0.96,
    category: "infra",
    hoursAgo: 2.1,
    lastAgo: 0.4,
    sizeBytes: 251_400,
    idl: ["initialize", "register_oracle", "submit_price", "aggregate", "slash", "withdraw"],
    authorityClass: "squads",
    funding: "coinbase",
    signers: 342,
    verified: true,
    strings: [
      "oracle_v1::submit_price",
      "median aggregation window exceeded",
      "https://github.com/example/onchain-oracle",
      "stake account under-collateralized",
      "Anchor program built with anchor-lang 0.30.1",
    ],
    neighbors: [],
    repoUrl: "https://github.com/example/onchain-oracle",
    fullDossier: true,
  }),
  program({
    name: null,
    band: "novel",
    score: 0.93,
    category: "defi",
    hoursAgo: 3.4,
    sizeBytes: 198_720,
    idl: ["swap", "add_liquidity", "remove_liquidity", "create_pool", "collect_fees"],
    authorityClass: "squads",
    funding: "bridge",
    signers: 214,
    strings: ["concentrated_liquidity", "tick spacing invalid", "pool::swap_exact_in"],
    neighbors: [],
  }),
  program({
    name: null,
    band: "novel",
    score: 0.88,
    category: "defi",
    hoursAgo: 4.8,
    sizeBytes: 143_360,
    instructionCount: 28,
    authorityClass: "none",
    funding: "kraken",
    signers: 96,
    strings: ["perp::open_position", "funding rate clamp", "liquidation engine tick"],
  }),
  program({
    name: null,
    band: "novel",
    score: 0.84,
    category: "token",
    hoursAgo: 5.6,
    sizeBytes: 88_064,
    idl: ["mint", "burn", "transfer_hook", "freeze"],
    authorityClass: "hot_wallet",
    funding: "unknown",
    signers: 44,
    strings: ["token-2022 transfer hook", "royalty bps out of range"],
  }),
  program({
    name: null,
    band: "novel",
    score: 0.81,
    category: "nft",
    hoursAgo: 6.9,
    sizeBytes: 121_900,
    idl: ["mint_nft", "update_metadata", "verify_collection", "burn_edition"],
    authorityClass: "squads",
    funding: "coinbase",
    signers: 33,
    strings: ["metaplex core adjacent", "collection not verified"],
  }),
  program({
    name: null,
    band: "novel",
    score: 0.79,
    category: "governance",
    hoursAgo: 7.7,
    sizeBytes: 176_128,
    idl: ["create_proposal", "cast_vote", "execute", "cancel", "set_quorum"],
    authorityClass: "squads",
    funding: "bridge",
    signers: 61,
    verified: true,
    strings: ["realm governance", "quorum not reached", "proposal in cooldown"],
  }),
  program({
    name: null,
    band: "novel",
    score: 0.77,
    category: "infra",
    hoursAgo: 9.2,
    sizeBytes: 64_512,
    instructionCount: 15,
    authorityClass: "program",
    funding: "unknown",
    signers: 12,
    strings: ["cross-program message relay", "invalid attestation"],
  }),
  program({
    name: null,
    band: "novel",
    score: 0.74,
    category: "defi",
    hoursAgo: 11.5,
    sizeBytes: 210_000,
    instructionCount: 41,
    authorityClass: "hot_wallet",
    funding: "okx",
    signers: 88,
    strings: ["lending market init", "health factor below 1"],
  }),
  program({
    name: null,
    band: "novel",
    score: 0.72,
    category: "unknown",
    hoursAgo: 14.0,
    sizeBytes: 37_888,
    instructionCount: null,
    authorityClass: "hot_wallet",
    funding: "unknown",
    signers: 3,
    strings: ["process_instruction", "0x1771"],
  }),
  program({
    name: null,
    band: "novel",
    score: 0.7,
    category: "token",
    hoursAgo: 18.3,
    sizeBytes: 45_056,
    idl: ["initialize_mint", "mint_to", "set_metadata"],
    authorityClass: "none",
    funding: "coinbase",
    signers: 20,
    strings: ["fixed supply mint", "mint authority frozen"],
  }),
  program({
    name: null,
    band: "novel",
    score: 0.68,
    category: "nft",
    hoursAgo: 20.6,
    sizeBytes: 52_224,
    instructionCount: 9,
    authorityClass: "hot_wallet",
    funding: "unknown",
    signers: 5,
    strings: ["compressed nft mint", "merkle proof invalid"],
  }),
  program({
    name: null,
    band: "novel",
    score: 0.66,
    category: "infra",
    hoursAgo: 22.4,
    sizeBytes: 71_680,
    idl: ["heartbeat", "report", "rotate_key"],
    authorityClass: "squads",
    funding: "bridge",
    signers: 27,
    verified: true,
    strings: ["keeper network heartbeat", "stale report rejected"],
  }),
];

// A couple of older novel programs so week / all windows show more.
const NOVEL_OLDER = [
  program({
    name: null,
    band: "novel",
    score: 0.82,
    category: "defi",
    hoursAgo: 52,
    sizeBytes: 160_000,
    idl: ["deposit", "withdraw", "rebalance", "harvest"],
    authorityClass: "squads",
    funding: "coinbase",
    signers: 130,
    verified: true,
    strings: ["yield vault strategy", "slippage exceeded"],
  }),
  program({
    name: null,
    band: "novel",
    score: 0.75,
    category: "governance",
    hoursAgo: 120,
    sizeBytes: 140_000,
    instructionCount: 22,
    authorityClass: "squads",
    funding: "bridge",
    signers: 58,
    strings: ["staking governance", "unstake cooldown active"],
  }),
];

// Variant-band cluster members (fold into cluster rows).
const VARIANTS = [
  program({ band: "variant", score: 0.22, category: "token", hoursAgo: 1.2, sizeBytes: 41_000, authorityClass: "hot_wallet", funding: "unknown", signers: 6, bucketId: "clu_photon", clusterSize: 34, strings: ["pump curve bonding", "graduation threshold"] }),
  program({ band: "variant", score: 0.2, category: "token", hoursAgo: 2.9, sizeBytes: 41_120, authorityClass: "hot_wallet", funding: "unknown", signers: 2, bucketId: "clu_photon", clusterSize: 34 }),
  program({ band: "variant", score: 0.19, category: "token", hoursAgo: 4.1, sizeBytes: 40_960, authorityClass: "hot_wallet", funding: "unknown", signers: 1, bucketId: "clu_photon", clusterSize: 34 }),
  program({ band: "variant", score: 0.31, category: "defi", hoursAgo: 5.5, sizeBytes: 182_000, authorityClass: "squads", funding: "bridge", signers: 40, bucketId: "clu_dlmm", clusterSize: 7, strings: ["dlmm bin array", "active bin drift"] }),
  program({ band: "variant", score: 0.29, category: "defi", hoursAgo: 8.2, sizeBytes: 181_500, authorityClass: "squads", funding: "unknown", signers: 18, bucketId: "clu_dlmm", clusterSize: 7 }),
];

// Clone-band rows (exact bytecode matches, dropped from the radar but counted).
const CLONES = [
  program({ band: "clone", score: 0.03, category: "token", hoursAgo: 0.6, sizeBytes: 22_000, authorityClass: "hot_wallet", funding: "unknown", signers: 0, bucketId: "clu_spltoken", clusterSize: 118 }),
  program({ band: "clone", score: 0.03, category: "token", hoursAgo: 1.8, sizeBytes: 22_000, authorityClass: "hot_wallet", funding: "unknown", signers: 0, bucketId: "clu_spltoken", clusterSize: 118 }),
  program({ band: "clone", score: 0.02, category: "token", hoursAgo: 3.3, sizeBytes: 22_000, authorityClass: "hot_wallet", funding: "unknown", signers: 0, bucketId: "clu_spltoken", clusterSize: 118 }),
  program({ band: "clone", score: 0.02, category: "token", hoursAgo: 6.0, sizeBytes: 41_000, authorityClass: "hot_wallet", funding: "unknown", signers: 0, bucketId: "clu_photon", clusterSize: 34 }),
];

const ALL = [...NOVEL, ...NOVEL_OLDER, ...VARIANTS, ...CLONES];
const BY_ID = new Map(ALL.map((p) => [p.id, p]));

// Wire cluster members from the seeded programs + a couple synthetic tails.
for (const clu of Object.values(CLUSTERS)) {
  const seeded = ALL.filter((p) => p.bucketId === clu.id).map((p) => ({
    programId: p.id,
    deployedAt: p.deployedAt,
  }));
  const synthetic = Array.from({ length: Math.max(0, Math.min(6, clu.memberCount - seeded.length)) }, (_, i) => ({
    programId: addr(),
    deployedAt: iso(2 + i * 3),
  }));
  clu.members = [...seeded, ...synthetic];
}

// Give the flagship novel program some fingerprint neighbors (into a cluster).
NOVEL[7]._neighbors = [{ programId: VARIANTS[3].id, distance: 41, name: null }];

// --- funnel (consistent with the seeded bands) -----------------------------
const novelToday = NOVEL.filter((p) => hoursOf(p) <= 24);
function hoursOf(p) {
  return (NOW - Date.parse(p.deployedAt)) / 3_600_000;
}
const byCategory = {};
for (const p of novelToday) byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;

const RAW = 1974;
const UNIQUE = 612;
const NOVEL_COUNT = novelToday.length; // radar's "today · novel" count
const FUNNEL = {
  date: today,
  raw: RAW,
  unique: UNIQUE,
  novel: NOVEL_COUNT,
  clones: RAW - UNIQUE, // exact-bytecode dupes dropped raw -> unique
  variants: UNIQUE - NOVEL_COUNT, // near-dupes dropped unique -> novel
  byCategory,
  updatedAt: iso(0.05),
};

// --- raw loader event feed -------------------------------------------------
// Deploy row per program, plus the flagship's richer timeline.
function deployEvent(p) {
  return {
    id: `evt_${p.id.slice(0, 8)}_deploy`,
    network: "mainnet",
    type: "deploy",
    signature: sig(),
    slot: p.deployedSlot,
    blockTime: p.deployedAt,
    programId: p.id,
    authorityBefore: null,
    authorityAfter: p._authority,
    sha256After: p._sha256,
  };
}

function eventsFor(p) {
  if (p._events) return p._events;
  const flagship = NOVEL[0];
  if (p.id === flagship.id) {
    const upSha1 = sha256();
    return [
      { id: `evt_${p.id.slice(0, 8)}_auth`, network: "mainnet", type: "set_authority", signature: sig(), slot: p.deployedSlot + 61, blockTime: iso(0.4), programId: p.id, authorityBefore: p._authority, authorityAfter: addr("Sq"), sha256After: null },
      { id: `evt_${p.id.slice(0, 8)}_up2`, network: "mainnet", type: "upgrade", signature: sig(), slot: p.deployedSlot + 40, blockTime: iso(1.1), programId: p.id, authorityBefore: p._authority, authorityAfter: p._authority, sha256After: upSha1 },
      { id: `evt_${p.id.slice(0, 8)}_up1`, network: "mainnet", type: "upgrade", signature: sig(), slot: p.deployedSlot + 12, blockTime: iso(1.7), programId: p.id, authorityBefore: p._authority, authorityAfter: p._authority, sha256After: sha256() },
      deployEvent(p),
    ];
  }
  return [deployEvent(p)];
}

const RAW_FEED = ALL.flatMap(eventsFor).sort(
  (a, b) => (Date.parse(b.blockTime ?? 0) || 0) - (Date.parse(a.blockTime ?? 0) || 0)
);

// --- projections -----------------------------------------------------------
function radarRow(p) {
  const { _sha256, _idl, _repoUrl, _authority, _neighbors, _strings, _events, ...row } = p;
  return row;
}

function programDetail(p) {
  return {
    ...radarRow(p),
    repoUrl: p._repoUrl,
    authority: p._authority,
    sha256: p._sha256,
    events: eventsFor(p),
    neighbors: p._neighbors,
    idlInstructions: p._idl,
    strings: p._strings,
  };
}

function radarWindowFilter(window) {
  const cutoff = window === "today" ? 24 : window === "week" ? 24 * 7 : Infinity;
  return (p) => hoursOf(p) <= cutoff;
}

// --- server ----------------------------------------------------------------
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type, "access-control-allow-origin": "*" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

function paginate(items, cursor, limit) {
  const start = cursor ? Number(cursor) || 0 : 0;
  const slice = items.slice(start, start + limit);
  const next = start + limit < items.length ? String(start + limit) : null;
  return { items: slice, nextCursor: next };
}

createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const q = url.searchParams;

  if (p === "/health") return send(res, 200, { ok: true });

  if (p === "/api/radar") {
    const window = q.get("window") || "today";
    const band = q.get("band") || "novel";
    const limit = Math.min(Number(q.get("limit")) || 50, 100);
    const items = ALL.filter((x) => x.band === band)
      .filter(radarWindowFilter(window))
      .sort((a, b) => b.noveltyScore - a.noveltyScore)
      .map(radarRow);
    return send(res, 200, paginate(items, q.get("cursor"), limit));
  }

  const progMatch = p.match(/^\/api\/programs\/(.+)$/);
  if (progMatch) {
    const prog = BY_ID.get(decodeURIComponent(progMatch[1]));
    if (!prog) return send(res, 404, { error: "program not found" });
    return send(res, 200, programDetail(prog));
  }

  if (p === "/api/funnel") {
    return send(res, 200, FUNNEL);
  }

  const cluMatch = p.match(/^\/api\/clusters\/(.+)$/);
  if (cluMatch) {
    const clu = CLUSTERS[decodeURIComponent(cluMatch[1])];
    if (!clu) return send(res, 404, { error: "cluster not found" });
    const { category, ...rest } = clu;
    return send(res, 200, rest);
  }

  if (p === "/api/raw/events") {
    const limit = Math.min(Number(q.get("limit")) || 50, 200);
    const network = q.get("network");
    const items = network ? RAW_FEED.filter((e) => e.network === network) : RAW_FEED;
    return send(res, 200, paginate(items, q.get("cursor"), limit));
  }

  send(res, 404, { error: "not found" });
}).listen(PORT, () => {
  console.log(
    `mock On Record radar API on http://localhost:${PORT}  ` +
      `(${ALL.length} programs · ${NOVEL_COUNT} novel today · ${RAW_FEED.length} raw events)`
  );
});
