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
  crateCandidates,
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

/** A name only gets overwritten on a decisive margin — see the reasoning at the
 *  rename site. `crate` and `sourcePaths` take the argmax unconditionally: those
 *  are lineage inputs that path overlap still has to corroborate, and the rule
 *  they replace (first match in a length-sorted list) was arbitrary anyway. */
const MIN_FILES_TO_RENAME = 8;
const RENAME_MARGIN = 2;

let withCrate = 0;
let withPaths = 0;
let written = 0;
let renamed = 0;
const review: { id: string; from: string; to: string; win: number; runnerUp: number }[] = [];
const byCrate = new Map<string, { id: string; name: string | null; paths: string[] }[]>();
const updates: { id: string; crate: string | null; paths: string[] | null; name?: string }[] = [];

for (const r of rows) {
  const tree = recoverSourceTree(r.strings ?? []);
  if (tree.crate) withCrate++;
  if (tree.paths.length) withPaths++;

  // Repair a name this binary's own panic paths disown. subjects.name is written
  // with coalesce (never un-name), so a name taken from the wrong crate — back
  // when the first `programs/<crate>/src/` match won — would otherwise stick
  // forever. The stored name must be a crate THIS binary imported but wasn't
  // built from; that leaves operator, registry, PMP and security.txt names
  // alone, since those never appear in the candidate list.
  //
  // …and the margin must be DECISIVE, because a name is human-facing and a wrong
  // one is worse than a stale one. Measured on the corpus, 70 rows qualify on
  // the name test alone and they split at exactly this line. Above it, all 45
  // are a support crate losing to the crate with the real tree — rbac→vault,
  // house-pool→coin-flip, config→registry, ripstr_amm→ripstr_pool (19 vs 4).
  // Below it sit the cases the weight rule genuinely cannot call: thin wrappers
  // that CPI into a bigger sibling (solana-axelar-memo→gateway at 5 vs 4, wrong
  // — the address itself is a `memta…` vanity for memo), test fixtures
  // outweighing the program (pack-royale-core-v1→ruleset-verifier-FIXTURE-v1 at
  // 2 vs 1), and outright 1-vs-1 ties broken by nothing but array order
  // (autocrat_v0→conditional_vault on MetaDAO's `meta…` addresses). Those are
  // printed for a human instead of written.
  const cands = crateCandidates(r.strings ?? []);
  const stored = r.name?.toLowerCase() ?? null;
  const contradicted =
    stored !== null &&
    tree.crate !== null &&
    stored !== tree.crate &&
    cands.some((c) => c.crate === stored);
  const [win, runnerUp] = [cands[0]?.files ?? 0, cands[1]?.files ?? 0];
  const decisive = win >= MIN_FILES_TO_RENAME && win >= RENAME_MARGIN * runnerUp;

  if (contradicted && decisive) {
    renamed++;
    log.info(
      { programId: r.program_id, from: r.name, to: tree.crate, files: win, runnerUp },
      "renaming: imported crate, not built from it",
    );
  } else if (contradicted) {
    review.push({ id: r.program_id, from: r.name!, to: tree.crate!, win, runnerUp });
  }

  updates.push({
    id: r.program_id,
    crate: tree.crate,
    paths: tree.paths.length ? tree.paths : null,
    ...(contradicted && decisive ? { name: tree.crate! } : {}),
  });

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
          .set({
            crate: u.crate,
            sourcePaths: u.paths,
            // searchText keeps the old name too (it's rebuilt from the binary on
            // the next event); the name column is what the dossier reads
            ...(u.name ? { name: u.name } : {}),
          })
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
    renamed,
    heldForReview: review.length,
    cratesSeen: byCrate.size,
    families: families.length,
    dry,
  },
  "done",
);

// Names the binary contradicts but not decisively enough to overwrite. Left as
// they are, on purpose — deciding these needs a human who can look at the
// program and its address.
if (review.length) {
  console.log(`\nNAMES HELD FOR REVIEW (contradicted, margin too thin to rewrite)\n`);
  console.log(`${"files".padStart(9)}   stored → dominant crate`);
  for (const r of review.sort((a, b) => b.win - b.runnerUp - (a.win - a.runnerUp))) {
    console.log(`${String(r.win).padStart(4)} vs ${String(r.runnerUp).padStart(2)}   ${r.from} → ${r.to}   ${r.id}`);
  }
}

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
