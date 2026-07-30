// Push each program's stored profile onto its newest event.
//
// Why this exists: backfill-profile.ts rewrites `subjects.profile`, which is
// what the dossier renders. But scoreStage reads the profile from the *event's*
// enrichment, not the subject — so after a profile backfill the two disagree,
// and re-scoring would recompute instructionCount as null and overwrite the
// counts the backfill just wrote. Run this between the two.
//
// No RPC and no re-parsing: the bytes were already read, this only copies the
// result across. Idempotent — rows whose event already carries the current
// profile shape are skipped, so it is safe to re-run.
//
//   set -a && . ../../.env && set +a
//   DATABASE_URL='postgres://…' ./node_modules/.bin/tsx src/backfill-event-profile.ts [--network=devnet] [--dry]
import { sql } from "drizzle-orm";
import { db, stageLogger, type Network } from "@onrecord/core";
import { requireDatabaseTarget } from "./db-target.js";

const log = stageLogger("backfill-event-profile");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const dry = process.argv.includes("--dry");
const network = arg("network") as Network | undefined;

const target = requireDatabaseTarget("backfill-event-profile.ts");
log.info({ target, network: network ?? "all", dry }, "target database");

// The newest event per program, for programs whose subject carries a profile
// written by the current profiler. `instructionNames` is the shape marker: the
// old profile has no such key.
const latest = sql`
  select distinct on (e.program_id) e.id, s.profile sprof
    from events e
    join subjects s on s.id = e.program_id and s.kind = 'program'
   where jsonb_exists(s.profile, 'instructionNames')
     ${network ? sql`and s.network = ${network}` : sql``}
   order by e.program_id, e.slot desc`;

// Only events that have not already been brought forward.
const staleFilter = sql`not coalesce(jsonb_exists(e.enrichment -> 'profile', 'instructionNames'), false)`;

const counted = await db.execute<{ n: number }>(sql`
  with latest as (${latest})
  select count(*)::int n from events e join latest l on e.id = l.id where ${staleFilter}`);
const pending = [...counted][0]?.n ?? 0;

let updated = 0;
if (!dry && pending) {
  const rows = await db.execute<{ id: string }>(sql`
    with latest as (${latest})
    update events e
       set enrichment = jsonb_set(coalesce(e.enrichment, '{}'::jsonb), '{profile}', l.sprof, true)
      from latest l
     where e.id = l.id and ${staleFilter}
    returning e.id`);
  updated = [...rows].length;
}

log.info({ pending, updated, dry }, "done");
console.log(`
EVENT PROFILE SYNC — ${network ?? "all networks"}${dry ? " (dry run, nothing written)" : ""}
  events needing the profile   ${pending}
  events updated               ${dry ? 0 : updated}

Next: backfill-score.ts, which re-runs the score stage so novelty picks up the
recovered instruction counts. Running it before this sync would score them as
zero and overwrite the backfilled counts.
`);
process.exit(0);
