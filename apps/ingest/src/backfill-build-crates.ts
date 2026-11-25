// Stamp facts.buildCrates on programs ingested before the field existed.
//
// The live pipeline now writes it on every deploy and upgrade (buildCratesOf in
// buildclues.ts). Older rows lack it, so the stats page's Build panel counts
// them as "versions not read". The versions are crate paths in the strings
// already stored on each program's newest fingerprinted event, so this runs as
// SQL inside Postgres: the strings never leave the database, and only a row
// count comes back. Same crates and the same first-match rule as buildCratesOf:
// solana-program, anchor-lang, pinocchio, solana-sdk, steel, bolt-lang, plus one
// split solana-* crate when solana-program is absent, at most four.
//
// --dry counts the programs it would stamp and writes nothing.
//
//   DATABASE_URL='postgres://…' ./node_modules/.bin/tsx src/backfill-build-crates.ts [--network=devnet] [--dry]
import { sql } from "drizzle-orm";
import { db, stageLogger, type Network } from "@onrecord/core";
import { requireDatabaseTarget } from "./db-target.js";

const log = stageLogger("backfill-build-crates");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const dry = process.argv.includes("--dry");
const network = (arg("network") ?? "mainnet") as Network;

const target = requireDatabaseTarget("backfill-build-crates.ts");
log.info({ target, network, dry }, "target database");

// buildclues.ts REGISTRY_CRATE, in Postgres regex syntax
const REGISTRY_CRATE = String.raw`registry/src/[^/[:space:]]+/([a-z0-9_-]+?)-([0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.]+)?)/`;
const KEY_CRATES = ["solana-program", "anchor-lang", "pinocchio", "solana-sdk", "steel", "bolt-lang"];

const pending = sql`
  select distinct on (e.program_id) e.program_id, e.enrichment -> 'fingerprint' -> 'strings' as strs
    from events e
    join subjects s on s.id = e.program_id and s.kind = 'program'
   where s.network = ${network}
     and not coalesce(jsonb_exists(s.facts, 'buildCrates'), false)
     and jsonb_typeof(e.enrichment -> 'fingerprint' -> 'strings') = 'array'
   order by e.program_id, e.slot desc`;

if (dry) {
  const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from (${pending}) p`);
  log.info({ programs: rows[0]?.n ?? 0 }, "would stamp (dry run)");
  process.exit(0);
}

const result = await db.execute(sql`
  with latest as (${pending}),
  hits as (
    select l.program_id, lower(m[1]) as name, m[2] as version, x.ord
      from latest l
      cross join lateral jsonb_array_elements_text(l.strs) with ordinality as x(str, ord)
      cross join lateral regexp_matches(x.str, ${REGISTRY_CRATE}, 'gi') as m
  ),
  firsts as (
    select distinct on (program_id, name) program_id, name, version, ord
      from hits
     order by program_id, name, ord
  ),
  keyed as (
    -- the key crates, in buildclues' order, then one split solana-* crate
    -- when the umbrella solana-program is missing
    select f.program_id, f.name, f.version,
           array_position(${sql.raw(`array[${KEY_CRATES.map((c) => `'${c}'`).join(",")}]::text[]`)}, f.name) as rank
      from firsts f
     where f.name = any(${sql.raw(`array[${KEY_CRATES.map((c) => `'${c}'`).join(",")}]::text[]`)})
    union all
    (select distinct on (f.program_id) f.program_id, f.name, f.version, 100 as rank
       from firsts f
      where f.name like 'solana-%'
        and f.name <> all(${sql.raw(`array[${KEY_CRATES.map((c) => `'${c}'`).join(",")}]::text[]`)})
        and not exists (select 1 from firsts g where g.program_id = f.program_id and g.name = 'solana-program')
      order by f.program_id, f.ord)
  ),
  top4 as (
    select program_id, name, version
      from (select k.*, row_number() over (partition by program_id order by rank) as rn from keyed k) r
     where rn <= 4
  ),
  stamped as (
    select l.program_id,
           coalesce((select jsonb_object_agg(t.name, t.version) from top4 t where t.program_id = l.program_id), '{}'::jsonb) as crates
      from latest l
  )
  update subjects s
     set facts = s.facts || jsonb_build_object('buildCrates', st.crates)
    from stamped st
   where s.id = st.program_id
`);
log.info({ written: (result as unknown as { count?: number }).count ?? null }, "done");
process.exit(0);
