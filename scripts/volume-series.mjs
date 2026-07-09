// Deploy+upgrade volume over the last 30 days — from the ProgramData slot
// headers only (no bytecode), so it's cheap. Powers the Stats chart's window
// toggle (24h / 48h / 7d / 30d).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const core = await import("../packages/core/dist/index.js");
const { enumerateProgramData, getSlot } = core;

const SLOT_MS = 400; // ~0.4s/slot (approximate — slot time drifts slightly)
const DAYS = 30;
const BUCKET_MS = 3600_000; // 1h buckets
const nBuckets = (DAYS * 24 * BUCKET_MS) / BUCKET_MS; // = DAYS*24

console.log("enumerating ProgramData headers…");
const [headers, currentSlot] = await Promise.all([
  enumerateProgramData("mainnet"),
  getSlot("mainnet"),
]);
const now = Date.now();
console.log(`  ${headers.length.toLocaleString()} programs · current slot ${currentSlot}`);

const counts = new Array(nBuckets).fill(0);
for (const h of headers) {
  const tMs = now - (currentSlot - h.deployedSlot) * SLOT_MS;
  const ago = now - tMs;
  if (ago < 0 || ago >= DAYS * 24 * BUCKET_MS) continue;
  const bucket = Math.floor(ago / BUCKET_MS); // 0 = most recent hour
  counts[bucket]++;
}

// oldest → newest, absolute unix seconds per bucket
const points = [];
for (let i = nBuckets - 1; i >= 0; i--) {
  points.push({ t: Math.floor((now - i * BUCKET_MS) / 1000), count: counts[i] });
}

mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("../data/volume-series.json", import.meta.url),
  JSON.stringify({ generatedAt: new Date(now).toISOString(), days: DAYS, points }, null, 2),
);

const total = counts.reduce((a, b) => a + b, 0);
const last24 = counts.slice(0, 24).reduce((a, b) => a + b, 0);
const last7d = counts.slice(0, 24 * 7).reduce((a, b) => a + b, 0);
console.log(`wrote ${points.length} hourly points`);
console.log(`  last 24h: ${last24} · last 7d: ${last7d} · last 30d: ${total}`);
