// Stamp profile.sbpfVersion on programs profiled before the field existed.
//
// The live pipeline now writes it on every deploy and upgrade (profileProgram
// reads the ELF header). Older rows lack it, and the stats page's sBPF panel
// counts them as "not read". The version is one u32 in the ELF header, so this
// reads a 97-byte slice per ProgramData, 100 per getMultipleAccounts call —
// no bytecode download, no reprofile. Only the version key is written; the
// rest of the stored profile is left as it is.
//
// Scope defaults to programs with a deploy or upgrade in the last 30 days,
// which is every window the stats page offers. --days=0 does the whole corpus.
//
//   DATABASE_URL='postgres://…' ./node_modules/.bin/tsx src/backfill-sbpf.ts [--network=devnet] [--days=30] [--dry]
import { sql } from "drizzle-orm";
import { db, programDataSbpfMany, stageLogger, type Network } from "@onrecord/core";
import { requireDatabaseTarget, requireRpcKey } from "./db-target.js";

const log = stageLogger("backfill-sbpf");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const dry = process.argv.includes("--dry");
const network = (arg("network") ?? "mainnet") as Network;
const days = Number(arg("days") ?? 30);

const target = requireDatabaseTarget("backfill-sbpf.ts");
requireRpcKey("backfill-sbpf.ts");
log.info({ target, network, days, dry }, "target database");

// newest ProgramData address per program still missing the field
const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
const rows = await db.execute<{ program_id: string; program_data_address: string }>(sql`
  select distinct on (e.program_id) e.program_id, e.program_data_address
    from events e
    join subjects s on s.id = e.program_id and s.kind = 'program'
   where s.network = ${network}
     and e.program_data_address is not null
     and s.profile is not null
     and not coalesce(jsonb_exists(s.profile, 'sbpfVersion'), false)
     and (s.facts ->> 'closedAt') is null
     ${since ? sql`and coalesce(s.last_event_at, s.first_seen_at) >= ${since}::timestamptz` : sql``}
   order by e.program_id, e.slot desc
`);
log.info({ programs: rows.length }, "start");

const byAddress = new Map(rows.map((r) => [r.program_data_address, r.program_id]));
const versions = await programDataSbpfMany(network, [...byAddress.keys()]);

const tally: Record<string, number> = {};
for (const v of versions.values()) tally[`v${v}`] = (tally[`v${v}`] ?? 0) + 1;
log.info({ read: versions.size, unreadable: rows.length - versions.size, tally }, "read");

let written = 0;
if (!dry) {
  const pairs = [...versions].map(([address, v]) => ({ id: byAddress.get(address)!, v }));
  const CHUNK = 500;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK);
    // one statement per chunk: a VALUES list joined onto subjects
    await db.execute(sql`
      update subjects s
         set profile = jsonb_set(s.profile, '{sbpfVersion}', to_jsonb(v.version))
        from (values ${sql.join(
          chunk.map((p) => sql`(${p.id}, ${p.v}::int)`),
          sql`, `,
        )}) as v(id, version)
       where s.id = v.id and s.network = ${network} and s.profile is not null
    `);
    written += chunk.length;
  }
}
log.info({ written, dry }, "done");
process.exit(0);
