// Which programs does a program NAME? Indexes the whole corpus by program id
// and scans a binary for those 32-byte constants — the edge list behind an
// entity's on-chain shape.
//
//   node scripts/refs.mjs kamino            # every mainnet program matching a name
//   node scripts/refs.mjs <programId> [...]  # specific ids
//
// Reads DATABASE_URL from .env (or the env) for the corpus index.
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const core = await import("../packages/core/dist/index.js");
const { getProgramDataAddress, getAccountBytes, buildPubkeyIndex, findReferencedPrograms, db, schema } = core;
const { sql } = await import("../node_modules/.pnpm/drizzle-orm@0.38.4_postgres@3.4.9/node_modules/drizzle-orm/index.js");

const argv = process.argv.slice(2);
if (!argv.length) {
  console.error("usage: node scripts/refs.mjs <name-fragment | programId ...>");
  process.exit(1);
}

// --- the corpus index: every mainnet program on record ----------------------
const corpus = await db
  .select({ id: schema.subjects.id, name: schema.subjects.name, crate: schema.subjects.crate })
  .from(schema.subjects)
  .where(sql`${schema.subjects.network} = 'mainnet' and ${schema.subjects.kind} = 'program'`);

const meta = new Map(corpus.map((r) => [r.id, r]));
const index = buildPubkeyIndex(corpus.map((r) => r.id));
console.log(`corpus index: ${index.size} mainnet program ids\n`);

// --- what to scan -----------------------------------------------------------
const looksLikeId = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
let targets;
if (argv.every(looksLikeId)) {
  targets = argv.map((id) => meta.get(id) ?? { id, name: null, crate: null });
} else {
  const q = argv.join(" ").toLowerCase();
  targets = corpus.filter((r) => (r.name ?? "").toLowerCase().includes(q));
  console.log(`${targets.length} programs matching "${q}"\n`);
}

const label = (r) => `${r?.name ?? "(unnamed)"}${r?.crate ? ` [${r.crate}]` : ""}`;
const edges = [];

for (const t of targets) {
  let bytes;
  try {
    const pda = await getProgramDataAddress("mainnet", t.id);
    bytes = await getAccountBytes("mainnet", pda);
  } catch (err) {
    console.log(`  ${label(t)} — fetch failed: ${String(err).slice(0, 60)}`);
    continue;
  }
  if (!bytes) {
    console.log(`  ${label(t)} — no bytecode (closed?)`);
    continue;
  }
  // strip the 45-byte ProgramData header and trailing zero padding
  let end = bytes.length;
  while (end > 45 && bytes[end - 1] === 0) end--;
  const body = bytes.subarray(45, end);

  const t0 = Date.now();
  const refs = findReferencedPrograms(body, index, { self: t.id });
  const ms = Date.now() - t0;

  console.log(`${label(t)}  ${t.id.slice(0, 6)}…  ${(body.length / 1024).toFixed(0)} KB · scanned in ${ms}ms`);
  if (!refs.length) console.log("    (names no other program on record)");
  for (const r of refs) {
    const m = meta.get(r);
    console.log(`    → ${label(m).padEnd(42)} ${r.slice(0, 6)}…`);
    edges.push({ from: t.id, fromName: t.name, to: r, toName: m?.name ?? null });
  }
  console.log();
}

console.log(`--- ${edges.length} edges across ${targets.length} programs ---`);
process.exit(0);
