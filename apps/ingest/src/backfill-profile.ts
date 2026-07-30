// Recompute the Program Profile (framework, syscalls, capabilities, integrations,
// instruction names) for every program already indexed.
//
// Why this exists: the profiler only read syscalls out of `.dynstr`, which is
// where SBPFv1 keeps its dynamic imports. A program built with a current
// toolchain has no `.dynstr` at all — its syscalls are CALL_IMM immediates
// holding murmur3_32(name) — so those rows were stored with zero syscalls, no
// capabilities, and framework "unknown". Instruction names were only ever taken
// from a published IDL, which ~98% of programs do not have. Both are recovered
// from the bytecode now, and the stored profile is stale until it is rewritten.
// See packages/core/src/profile.ts.
//
// Safe to re-run; also how you rebuild after changing the recovery rules.
// Needs RPC: unlike backfill-sourcetree, the profile is computed on the raw ELF
// and we do not persist bytecode, so each ProgramData account is re-fetched.
//
//   set -a && . ../../.env && set +a
//   DATABASE_URL='postgres://…' ./node_modules/.bin/tsx src/backfill-profile.ts [--network=devnet] [--only=<programId>] [--limit=N] [--dry]
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  schema,
  getAccountBytes,
  parseProgramDataAccount,
  extractStrings,
  profileProgram,
  sha256Hex,
  stageLogger,
  type Network,
} from "@onrecord/core";
import { requireDatabaseTarget } from "./db-target.js";

const log = stageLogger("backfill-profile");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const dry = process.argv.includes("--dry");
const network = (arg("network") ?? "mainnet") as Network;
const only = arg("only") ?? null;
const limit = Number(arg("limit") ?? 0) || null;

const target = requireDatabaseTarget("backfill-profile.ts");
log.info({ target, network, only, limit, dry }, "target database");

// One bulk read: the newest ProgramData address per program, plus whatever IDL
// instructions the fingerprint stage already stored (an IDL still wins over
// anything recovered from the binary).
const rows = await db.execute<{
  program_id: string;
  program_data_address: string | null;
  idl_instructions: string[] | null;
  old_syscalls: string[] | null;
  old_framework: string | null;
  old_sha: string | null;
}>(sql`
  select distinct on (e.program_id)
         e.program_id,
         e.program_data_address,
         e.enrichment -> 'fingerprint' -> 'idl' -> 'instructions' as idl_instructions,
         s.profile -> 'syscalls'  as old_syscalls,
         s.profile ->> 'framework' as old_framework,
         s.sha256 as old_sha
    from events e
    join subjects s on s.id = e.program_id and s.kind = 'program'
   where s.network = ${network}
     and e.program_data_address is not null
     ${only ? sql`and e.program_id = ${only}` : sql``}
   order by e.program_id, e.slot desc
   ${limit ? sql`limit ${limit}` : sql``}
`);

log.info({ programs: rows.length }, "start");

let scanned = 0;
let missing = 0;
let syscallsRecovered = 0;
let instructionsRecovered = 0;
let frameworkRelabelled = 0;
let regressions = 0;
let upgraded = 0;
let written = 0;

// Modest concurrency: this is a background repair sharing the RPC budget with
// live ingest, not a race.
const CONCURRENCY = 6;
let cursor = 0;
const updates: { id: string; profile: ReturnType<typeof profileProgram>; count: number | null }[] = [];

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < rows.length) {
      const r = rows[cursor++];
      if (!r?.program_data_address) continue;
      try {
        const raw = await getAccountBytes(network, r.program_data_address);
        const parsed = raw ? parseProgramDataAccount(raw) : null;
        if (!parsed) { missing++; continue; }

        const strings = extractStrings(parsed.bytecode);
        const profile = profileProgram(parsed.bytecode, {
          strings,
          idlInstructions: r.idl_instructions ?? undefined,
        });
        scanned++;

        const before = r.old_syscalls?.length ?? 0;
        if (!before && profile.syscalls.length) syscallsRecovered++;

        // A shrinking syscall set is only evidence of a reader regression when
        // the bytecode is the one that was profiled. Upgrades make the old
        // profile describe an image that is no longer on chain — one program in
        // the corpus went 189KB → 5.9KB, and refusing that update would pin a
        // stale profile forever. So compare hashes first.
        const sameImage = r.old_sha != null && r.old_sha === sha256Hex(parsed.bytecode);
        if (sameImage && before > profile.syscalls.length) {
          regressions++;
          log.warn(
            { programId: r.program_id, before, after: profile.syscalls.length },
            "syscall set shrank on identical bytecode — not overwriting",
          );
          continue;
        }
        if (!sameImage && before > profile.syscalls.length) {
          upgraded++;
          log.info(
            { programId: r.program_id, before, after: profile.syscalls.length },
            "bytecode changed since profiling — reprofiling against the current image",
          );
        }
        if (profile.instructionNames.length) instructionsRecovered++;
        if (r.old_framework && r.old_framework !== profile.framework) {
          frameworkRelabelled++;
          log.info(
            { programId: r.program_id, from: r.old_framework, to: profile.framework },
            "framework relabelled",
          );
        }

        updates.push({ id: r.program_id, profile, count: profile.instructionCount });
      } catch (e) {
        log.warn({ programId: r.program_id, err: (e as Error).message }, "skip");
      }
    }
  }),
);

if (!dry) {
  const CHUNK = 200;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map((u) =>
        db
          .update(schema.subjects)
          .set({
            profile: u.profile,
            // instructionCount is what the radar and the RSS description read;
            // coalesced so a program with a stored IDL count keeps it if the
            // binary recovered nothing.
            ...(u.count != null ? { instructionCount: u.count } : {}),
          })
          .where(and(eq(schema.subjects.id, u.id), eq(schema.subjects.network, network))),
      ),
    );
    written += chunk.length;
    if (i % 1000 === 0) log.info({ written, of: updates.length }, "writing");
  }
} else {
  written = updates.length;
}

log.info(
  { scanned, written, missing, syscallsRecovered, instructionsRecovered, frameworkRelabelled, upgraded, regressions, dry },
  "done",
);

console.log(`
PROFILE BACKFILL — ${network}${dry ? " (dry run, nothing written)" : ""}
  programs scanned        ${scanned}
  programdata missing     ${missing}
  syscalls recovered      ${syscallsRecovered}
  instructions recovered  ${instructionsRecovered}
  framework relabelled    ${frameworkRelabelled}
  reprofiled (upgraded)   ${upgraded}
  regressions skipped     ${regressions}
  rows written            ${written}

Novelty scores are NOT recomputed here — instructionSurface now has a non-zero
input for programs without an IDL, so run the score stage afterwards if you want
the radar order to reflect it.
`);
process.exit(0);
