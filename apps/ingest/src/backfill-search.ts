// Prepare a database for program-name search: add the search_text column and
// its trigram indexes, then populate the corpus for every program already
// indexed. Safe to re-run — the DDL is IF NOT EXISTS and the backfill is a
// straight overwrite, so this is also how you rebuild after changing the
// denoising rules in core/search.ts.
//
// RUN THIS BEFORE DEPLOYING THE CODE. The identify stage now writes
// search_text on every program it upserts; if the new pipeline reaches a
// database without the column, every incoming deploy event fails on insert
// and ingestion stops — not just search.
//
//   # local
//   ./node_modules/.bin/tsx src/backfill-search.ts [--dry]
//   # production — DATABASE_URL from the Railway service, not .env
//   DATABASE_URL='postgres://…' ./node_modules/.bin/tsx src/backfill-search.ts
//
// No RPC needed: the fingerprint stage already persisted the bytecode strings
// onto events.enrichment, so the corpus rebuilds offline from what we stored.
import { desc, eq, sql } from "drizzle-orm";
import {
  db,
  schema,
  buildSearchText,
  stageLogger,
  type EventEnrichment,
  type SecurityTxt,
} from "@onrecord/core";

const log = stageLogger("backfill-search");
const dry = process.argv.includes("--dry");

// Mirrors packages/core/drizzle/0001_program_search.sql. Kept inline so this
// script works from dist/ as well as source — the .sql file is the schema
// history, this is the runtime copy. Change both together.
const DDL = [
  `alter table "subjects" add column if not exists "search_text" text`,
  `create extension if not exists pg_trgm`,
  `create index if not exists "subjects_search_text_idx" on "subjects" using gin ("search_text" gin_trgm_ops)`,
  `create index if not exists "subjects_name_trgm_idx" on "subjects" using gin (lower("name") gin_trgm_ops)`,
];

// echo the target so a production run is never a guess
const target = (() => {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "postgres://localhost:5432/onrecord");
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "unparseable DATABASE_URL";
  }
})();

log.info({ target, dry }, "target database");

if (!dry) {
  for (const stmt of DDL) await db.execute(sql.raw(stmt));
  log.info({ statements: DDL.length }, "schema ready");
} else {
  log.info("dry run — schema untouched, no rows written");
}

const subjects = await db
  .select({
    id: schema.subjects.id,
    name: schema.subjects.name,
    repoUrl: schema.subjects.repoUrl,
    profile: schema.subjects.profile,
    facts: schema.subjects.facts,
  })
  .from(schema.subjects)
  .where(eq(schema.subjects.kind, "program"));

log.info({ subjects: subjects.length }, "start");

let written = 0;
let noStrings = 0;
let totalBytes = 0;

for (const s of subjects) {
  // newest event carrying a fingerprint = the binary live right now
  const rows = await db
    .select({ enrichment: schema.events.enrichment })
    .from(schema.events)
    .where(
      sql`${schema.events.programId} = ${s.id} and ${schema.events.enrichment} -> 'fingerprint' is not null`,
    )
    .orderBy(desc(schema.events.slot))
    .limit(1);

  const enr = rows[0]?.enrichment as EventEnrichment | undefined;
  const fp = enr?.fingerprint;
  const bi = enr?.bytecodeIdentity;
  if (!fp?.strings?.length) noStrings++;

  const facts = (s.facts ?? {}) as {
    website?: string | null;
    social?: string | null;
    securityTxt?: SecurityTxt | null;
  };

  const searchText = buildSearchText({
    name: s.name,
    repoUrl: s.repoUrl,
    website: facts.website ?? bi?.website ?? null,
    social: facts.social ?? bi?.social ?? null,
    securityTxt: facts.securityTxt ?? bi?.securityTxt ?? null,
    framework: s.profile?.framework ?? null,
    integrations: s.profile?.integrations ?? null,
    capabilities: s.profile?.capabilities ?? null,
    idlInstructions: fp?.idl?.instructions ?? null,
    strings: fp?.strings ?? null,
  });

  totalBytes += searchText.length;
  if (!dry) {
    await db
      .update(schema.subjects)
      .set({ searchText })
      .where(eq(schema.subjects.id, s.id));
  }
  written++;
}

log.info(
  {
    target,
    written,
    // programs whose binary yielded nothing searchable — they stay findable by
    // name/repo/integration only
    noStrings,
    avgBytes: written ? Math.round(totalBytes / written) : 0,
    totalKb: Math.round(totalBytes / 1024),
    dry,
  },
  "done",
);
process.exit(0);
