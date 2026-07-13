#!/usr/bin/env node
// daily-shape.mjs — print the "shape of a typical day" snapshot from the live
// On Record API. This is the source for the deploys-vs-upgrades numbers.
//
// Usage:
//   node scripts/daily-shape.mjs                 # hits the Railway prod API
//   API_URL=http://localhost:3001 node scripts/daily-shape.mjs
//
// Everything is read from the public read API — no DB access, no auth.

const API = (process.env.API_URL ?? "https://on-record-api-production.up.railway.app").replace(/\/$/, "");

const getFunnel = async (w) => (await fetch(`${API}/api/funnel?window=${w}`)).json();
async function radarAll(type, band, window = "week") {
  let cursor = null, out = [];
  for (let i = 0; i < 25; i++) {
    const u = new URL(`${API}/api/radar`);
    u.searchParams.set("window", window);
    if (type) u.searchParams.set("type", type);
    if (band) u.searchParams.set("band", band);
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const j = await (await fetch(u)).json();
    out.push(...(j.items ?? []));
    cursor = j.nextCursor;
    if (!cursor) break;
  }
  return out;
}

const pct = (n, d) => (d ? Math.round((100 * n) / d) + "%" : "—");
const tally = (items, key) => {
  const m = {};
  for (const p of items) m[p[key] ?? "unknown"] = (m[p[key] ?? "unknown"] ?? 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
};

const [f24, fall] = await Promise.all([getFunnel("24h"), getFunnel("all")]);

// --- real data span, from the 30d hourly volume (uses actual on-chain time) ---
const vol = (f24.volume ?? []).filter((v) => v.count > 0);
const spanDays = vol.length ? (vol[vol.length - 1].t - vol[0].t) / 86400 : 0;

console.log(`\nOn Record — shape of a typical day   (${API})`);
console.log(`data span so far: ~${spanDays.toFixed(1)} days  ·  pulled ${new Date().toISOString().slice(0, 16)}Z`);

// --- NEW PROGRAMS -----------------------------------------------------------
const d = f24.deploys, c = f24.churn;
console.log(`\nNEW PROGRAMS  —  ${d} in the last 24h`);
console.log(`  single-use bot redeploys : ${c.redeploys}  (${pct(c.redeploys, d)} of deploys)`);
console.log(`   …of those, wired to pump : ${c.pumpfun}  (${pct(c.pumpfun, c.redeploys)} of the clones)`);
console.log(`  genuinely new (novel)    : ${f24.novel}   [cold-start: early data over-counts novel]`);
console.log(`  already closed (rent back): ${c.closed}`);

// deploy-side framework mix (open programs, by band — excludes the closed bot tail)
const deploys = [
  ...(await radarAll("deploy", "novel")),
  ...(await radarAll("deploy", "variant")),
  ...(await radarAll("deploy", "clone")),
];
console.log(`  frameworks (open deploys): ${tally(deploys, "framework").map(([k, v]) => `${k} ${pct(v, deploys.length)}`).join("  ")}`);

// --- UPGRADES ---------------------------------------------------------------
const ups = await radarAll("upgrade", null);
console.log(`\nUPGRADES  —  ${f24.upgrades} in the last 24h  ·  ${ups.length} distinct programs recently active`);
console.log(`  category : ${tally(ups, "category").map(([k, v]) => `${k} ${v}`).join("  ")}`);
console.log(`  named/identifiable: ${pct(ups.filter((p) => p.name).length, ups.length)}`);
const top = ups.map((p) => ({ n: p.name ?? p.id.slice(0, 6) + "…", u: p.upgradeCount ?? 0, named: !!p.name }))
  .sort((a, b) => b.u - a.u).slice(0, 10);
console.log(`  most-upgraded (lifetime):`);
for (const t of top) console.log(`    ${String(t.u).padStart(4)}×  ${t.n}${t.named ? "" : "  (opaque)"}`);

console.log(`\n(all figures from the public read API; "all"-window totals: ${fall.deploys} deploys / ${fall.upgrades} upgrades over ~${spanDays.toFixed(1)}d)\n`);
