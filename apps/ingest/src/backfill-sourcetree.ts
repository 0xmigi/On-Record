// Add the source tree (crate name + own .rs paths) to every program already
// indexed, and report the lineage families it uncovers.
//
// Why this exists: TLSH answers "same binary?", not "same source?". tail.trade
// is a build of Drift's crate — 88 shared source files — at TLSH distance 182,
// which no threshold would ever call a relative. The panic paths in the binary
// carry the crate name and file tree through any build, so that is what we
// match on instead. See packages/core/src/sourcetree.ts.
//
// Safe to re-run; also how you rebuild after changing the recovery rules.
// No RPC: the fingerprint stage already persisted the bytecode strings onto
// events.enrichment, so this rebuilds offline from what we stored.
//
//   set -a && . ../../.env && set +a
//   DATABASE_URL='postgres://…' ./node_modules/.bin/tsx src/backfill-sourcetree.ts [--dry]
import { eq, sql } from "drizzle-orm";
import {
  db,
  schema,
  recoverSourceTree,
  sharedPathCount,
  pathOverlap,
  GENERIC_CRATES,
  stageLogger,
} from "@onrecord/core";
import { requireDatabaseTarget } from "./db-target.js";

const log = stageLogger("backfill-sourcetree");
const dry = process.argv.includes("--dry");

const target = requireDatabaseTarget("backfill-sourcetree.ts");
log.info({ target, dry }, "target database");

const DDL = [
  `alter table "subjects" add column if not exists "crate" text`,
  `alter table "subjects" add column if not exists "source_paths" jsonb`,
  `create index if not exists "subjects_crate_idx" on "subjects" using btree ("network","crate")`,
];
if (!dry) {
  for (const stmt of DDL) await db.execute(sql.raw(stmt));
  log.info({ statements: DDL.length }, "schema ready");
}

// One bulk read instead of two queries per program. The first attempt did
// ~10k round trips over the Railway public proxy and the connection dropped
// mid-run (EHOSTUNREACH); DISTINCT ON pulls the newest fingerprint per program
// in a single statement.
const rows = await db.execute<{
  program_id: string;
  network: string;
  name: string | null;
  strings: string[] | null;
}>(sql`
  select distinct on (e.program_id)
         e.program_id, s.network, s.name,
         e.enrichment -> 'fingerprint' -> 'strings' as strings
    from events e
    join subjects s on s.id = e.program_id and s.kind = 'program'
   where e.enrichment -> 'fingerprint' -> 'strings' is not null
   order by e.program_id, e.slot desc
`);

log.info({ programs: rows.length }, "start");

let withCrate = 0;
let withPaths = 0;
let written = 0;
const byCrate = new Map<string, { id: string; name: string | null; paths: string[] }[]>();
const updates: { id: string; crate: string | null; paths: string[] | null }[] = [];

for (const r of rows) {
  const tree = recoverSourceTree(r.strings ?? []);
  if (tree.crate) withCrate++;
  if (tree.paths.length) withPaths++;
  updates.push({ id: r.program_id, crate: tree.crate, paths: tree.paths.length ? tree.paths : null });

  if (tree.crate) {
    const key = `${r.network}:${tree.crate}`;
    (byCrate.get(key) ?? byCrate.set(key, []).get(key)!).push({
      id: r.program_id,
      name: r.name,
      paths: tree.paths,
    });
  }
}

if (!dry) {
  // batched writes — one statement per chunk, not per program
  const CHUNK = 200;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map((u) =>
        db
          .update(schema.subjects)
          .set({ crate: u.crate, sourcePaths: u.paths })
          .where(eq(schema.subjects.id, u.id)),
      ),
    );
    written += chunk.length;
    if (i % 1000 === 0) log.info({ written, of: updates.length }, "writing");
  }
} else {
  written = updates.length;
}

// Report the families this uncovers — these are the relationships the radar
// currently shows as unrelated programs.
const families = [...byCrate.entries()]
  .filter(([, v]) => v.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

log.info(
  {
    written,
    withCrate,
    withPaths,
    cratesSeen: byCrate.size,
    families: families.length,
    dry,
  },
  "done",
);

console.log(`\nLINEAGE FAMILIES UNCOVERED (crate shared by >1 program)\n`);
for (const [key, members] of families.slice(0, 25)) {
  const crate = key.split(":")[1]!;
  const generic = GENERIC_CRATES.has(crate) ? "  [generic — needs path overlap]" : "";
  console.log(`${crate.padEnd(28)} ${String(members.length).padStart(3)} programs${generic}`);
  // strongest pair in the family, so the number is legible
  let best = { a: "", b: "", shared: 0, overlap: 0 };
  for (let i = 0; i < Math.min(members.length, 12); i++) {
    for (let j = i + 1; j < Math.min(members.length, 12); j++) {
      const shared = sharedPathCount(members[i]!.paths, members[j]!.paths);
      if (shared > best.shared) {
        best = {
          a: members[i]!.name ?? members[i]!.id.slice(0, 8),
          b: members[j]!.name ?? members[j]!.id.slice(0, 8),
          shared,
          overlap: pathOverlap(members[i]!.paths, members[j]!.paths),
        };
      }
    }
  }
  if (best.shared) {
    console.log(
      `    strongest pair: ${best.a} ↔ ${best.b} — ${best.shared} shared files, overlap ${best.overlap.toFixed(2)}`,
    );
  }
}
process.exit(0);
