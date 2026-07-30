// Re-run the score stage over every indexed program.
//
// Why this exists: rescore.ts only refreshes *interest* — the radar's ordering
// layer. The novelty score itself is computed in scoreStage, so a change to any
// of its inputs leaves the stored score stale until the stage is walked. That is
// the case after a profile backfill: instructionSurface used to read zero for
// every program without a published IDL, and now reads a real recovered count.
//
// Run backfill-event-profile.ts FIRST. scoreStage takes the profile off the
// event, not the subject, so without that sync this recomputes instructionCount
// as null and overwrites the backfilled values.
//
// Sequential and oldest-first: scoreStage does RPC for novel-band rows (funding
// trail, early activity), so this shares an RPC budget with live ingest and is
// not worth racing. It also writes the subject row and refreshes interest, so
// step 3 comes for free.
//
//   set -a && . ../../.env && set +a
//   INLINE_PIPELINE=1 DATABASE_URL='postgres://…' ./node_modules/.bin/tsx src/backfill-score.ts [--network=devnet] [--limit=N] [--dry]
import { sql } from "drizzle-orm";
import { db, schema, stageLogger, type Network } from "@onrecord/core";
import { scoreStage } from "./pipeline.js";
import { requireDatabaseTarget } from "./db-target.js";

const log = stageLogger("backfill-score");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const dry = process.argv.includes("--dry");
const network = (arg("network") ?? "mainnet") as Network;
const limit = Number(arg("limit") ?? 0) || null;

const target = requireDatabaseTarget("backfill-score.ts");
log.info({ target, network, limit, dry }, "target database");

// Newest event per program — the one whose enrichment the score is derived from.
const rows = await db.execute<{ id: string; program_id: string; score: number | null; ix: number | null }>(sql`
  select distinct on (e.program_id)
         e.id, e.program_id, s.novelty_score score, s.instruction_count ix
    from events e
    join subjects s on s.id = e.program_id and s.kind = 'program'
   where s.network = ${network}
   order by e.program_id, e.slot desc
   ${limit ? sql`limit ${limit}` : sql``}`);

log.info({ programs: rows.length }, "start");

let scanned = 0;
let moved = 0;
let lostCount = 0;
let failed = 0;
const biggest: { id: string; from: number; to: number }[] = [];

for (const r of rows) {
  try {
    if (dry) { scanned++; continue; }
    const before = r.score ?? 0;
    const beforeIx = r.ix;
    await scoreStage(r.id);
    const after = await db
      .select({ score: schema.subjects.noveltyScore, ix: schema.subjects.instructionCount })
      .from(schema.subjects)
      .where(sql`${schema.subjects.id} = ${r.program_id} and ${schema.subjects.network} = ${network}`)
      .limit(1);
    scanned++;
    const now = after[0]?.score ?? 0;
    // The failure mode this guards against: scoring a program whose event never
    // got the synced profile drops its instruction count back to null.
    if (beforeIx != null && after[0]?.ix == null) {
      lostCount++;
      log.warn({ programId: r.program_id, before: beforeIx }, "instruction count cleared — run backfill-event-profile first");
    }
    const delta = now - before;
    if (Math.abs(delta) >= 0.0005) {
      moved++;
      biggest.push({ id: r.program_id, from: before, to: now });
    }
  } catch (err) {
    failed++;
    log.warn({ programId: r.program_id, err: String(err) }, "score failed");
  }
}

biggest.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
log.info({ network, scanned, moved, lostCount, failed, dry }, "done");

console.log(`
SCORE BACKFILL — ${network}${dry ? " (dry run, nothing written)" : ""}
  programs scanned          ${scanned}
  scores moved              ${moved}
  instruction counts lost   ${lostCount}${lostCount ? "   <-- sync was not run first" : ""}
  failed                    ${failed}
`);
for (const b of biggest.slice(0, 10)) {
  console.log(`  ${b.id.slice(0, 12)}…  ${b.from.toFixed(3)} -> ${b.to.toFixed(3)}`);
}
process.exit(0);
