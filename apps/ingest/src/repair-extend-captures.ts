import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, logger, type Network } from "@onrecord/core";
import { requireDatabaseTarget } from "./db-target.js";
import { SYNTHETIC_SIG_PREFIXES } from "./timeline.js";

// ---------------------------------------------------------------------------
// Repair poller captures that were extends, not upgrades.
//
// The poller diffs the ProgramData header's slot, and ExtendProgram rewrites
// that slot without touching the code. Every extend of a known program landed
// in `events` as an 'upgrade': it went on the timeline, and the pipeline set
// subjects.last_event_at to it, which dates the radar's upgrade stream.
// Measured on mainnet 2026-10-07: 2,167 poll captures typed 'upgrade' sat on a
// slot whose only loader instruction was an extend. identifyStage now retypes
// these as they arrive (pipeline.ts); this fixes the rows already written.
//
// Per program with a complete loader walk, for synthetic captures typed
// 'deploy' or 'upgrade' at a slot the walk has read where the only successful
// loader instruction is an extend — the same rule as identifyStage:
//   - retyped 'extend'
//   - except a first sighting still typed 'deploy' (the gate graded it as the
//     program's arrival) and a re-sighting whose bytes changed: reported
// and per subject whose last_event_at is one of those extends:
//   - last_event_at moved to the loader record's last deploy or upgrade
//
// "First sighting" is read from events, not subjects.first_seen_slot: that
// column is later than earlier captures for hundreds of mainnet subjects.
//
// Reads only the stored loader record: no chain reads. Captures above a walk's
// newest slot are reported as uncovered; repair-upgrade-counts.ts refreshes
// stale walks, and a re-run after it picks them up. Idempotent.
//
//   ./node_modules/.bin/tsx src/repair-extend-captures.ts [flags]
//     --network mainnet|devnet   default mainnet
//     --write                    apply (default: dry run, writes nothing)
//     --out FILE                 every change as TSV
// ---------------------------------------------------------------------------

const SCRIPT = "repair-extend-captures.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const network = (flag("network") ?? "mainnet") as Network;
const write = process.argv.includes("--write");
const out = flag("out");

interface Capture {
  id: string;
  program_id: string;
  type: string;
  signature: string;
  pipeline_stage: string;
  slot: string;
  block_time: string | null;
  sha256_after: string | null;
  walk_status: string;
  newest_slot: string | null;
  sighted_before: boolean;
  extended: boolean | null;
  code: boolean | null;
  prev_sha: string | null;
}

interface Redate {
  id: string;
  deploy_type: string | null;
  novelty_band: string | null;
  last_event_at: string | Date;
  to_at: string | Date | null;
}

/** timestamps come back as strings or Dates depending on the driver path */
const ms = (v: string | Date | null): number => (v == null ? NaN : new Date(v).getTime());
const iso = (v: string | Date | null): string => (v == null ? "-" : new Date(v).toISOString());

async function run(): Promise<void> {
  const target = requireDatabaseTarget(SCRIPT);
  logger.info({ target, network, write }, "repair-extend-captures: start");

  const synthetic = sql.join(
    SYNTHETIC_SIG_PREFIXES.map((p) => sql`e.signature like ${`${p}%`}`),
    sql` or `,
  );
  const captures = (await db.execute(sql`
    select e.id, e.program_id, e.type, e.signature, e.pipeline_stage, e.slot, e.block_time, e.sha256_after,
      w.status as walk_status, w.newest_slot,
      exists (select 1 from events p
        where p.network = e.network and p.program_id = e.program_id and p.slot < e.slot
          and p.pipeline_stage not in ('genesis', 'ingested')) as sighted_before,
      x.extended, x.code,
      (select p.sha256_after from events p
        where p.network = e.network and p.program_id = e.program_id and p.slot < e.slot and p.sha256_after is not null
        order by p.slot desc limit 1) as prev_sha
    from events e
    join loader_walks w on w.network = e.network and w.program_id = e.program_id
    left join lateral (
      select bool_or(t.kind in ('extend', 'extend_checked')) as extended, bool_or(t.kind in ('deploy', 'upgrade')) as code
      from loader_txns t
      where t.network = e.network and t.program_id = e.program_id and t.slot = e.slot and not t.failed
    ) x on true
    where e.network = ${network} and e.type in ('deploy', 'upgrade') and (${synthetic})
  `)) as unknown as Capture[];

  const retype: Capture[] = [];
  const firstSighting: Capture[] = [];
  const bytesChanged: Capture[] = [];
  const uncovered: Record<string, number> = {};
  let extendWithCode = 0;
  for (const c of captures) {
    // only what a complete walk has read: anything else may be an upgrade it missed
    if (c.walk_status !== "complete" || c.newest_slot == null || Number(c.slot) > Number(c.newest_slot)) {
      const k = c.walk_status !== "complete" ? `walk ${c.walk_status}` : "above walk's newest slot";
      uncovered[k] = (uncovered[k] ?? 0) + 1;
      continue;
    }
    if (!c.extended) continue;
    if (c.code) {
      extendWithCode++; // extend + upgrade in one slot: a code change
      continue;
    }
    // a first sighting the gate graded as a deploy stays one (identifyStage)
    if (!c.sighted_before && c.type === "deploy") {
      firstSighting.push(c);
      continue;
    }
    if (c.sighted_before && c.sha256_after && c.prev_sha && c.sha256_after !== c.prev_sha) {
      bytesChanged.push(c);
      continue;
    }
    retype.push(c);
  }
  const retypedFirstSightings = retype.filter((c) => !c.sighted_before).length;

  // subjects dated by an extend: this run's retypes, or rows already typed so
  const retypeIds = JSON.stringify(retype.map((c) => c.id));
  const redates = (await db.execute(sql`
    with ext as (
      select id, program_id, block_time from events
      where network = ${network} and (type = 'extend' or id in (select jsonb_array_elements_text(${retypeIds}::jsonb)))
    )
    select s.id, s.deploy_type, s.novelty_band, s.last_event_at,
      (select max(t.block_time) from loader_txns t
        where t.network = s.network and t.program_id = s.id and t.kind in ('deploy', 'upgrade') and not t.failed) as to_at
    from subjects s
    where s.network = ${network}
      and exists (select 1 from ext where ext.program_id = s.id and ext.block_time = s.last_event_at)
  `)) as unknown as Redate[];
  const moved = redates.filter((r) => r.to_at != null && ms(r.to_at) !== ms(r.last_event_at));
  const noOther = redates.filter((r) => r.to_at == null);

  const now = Date.now();
  const within = (at: string | Date | null, span: number) => at != null && now - ms(at) < span;
  const DAY = 86_400_000;
  // the radar's upgrade stream: deploy_type 'upgrade', dated by last_event_at
  const stream = moved.filter((r) => r.deploy_type === "upgrade");
  const by = (rows: Capture[], key: (c: Capture) => string) =>
    rows.reduce<Record<string, number>>((acc, c) => ((acc[key(c)] = (acc[key(c)] ?? 0) + 1), acc), {});

  const summary = {
    target,
    network,
    write,
    capturesConsidered: captures.length,
    notCoveredByWalk: uncovered,
    extendAndCodeSameSlot: extendWithCode,
    retype: retype.length,
    retypeBy: by(retype, (c) => `${c.signature.split(":")[0]} ${c.type}/${c.pipeline_stage}`),
    retypePrograms: new Set(retype.map((c) => c.program_id)).size,
    retypeFirstSightings: retypedFirstSightings,
    retypeLast7d: retype.filter((c) => within(c.block_time, 7 * DAY)).length,
    reportedFirstSightingDeploy: firstSighting.length,
    reportedBytesChanged: bytesChanged.length,
    subjects: {
      datedByExtend: redates.length,
      redated: moved.length,
      noLoaderCodeChange: noOther.length,
      onUpgradeStream: stream.length,
      leaveLast24h: stream.filter((r) => within(r.last_event_at, DAY) && !within(r.to_at, DAY)).length,
      leaveLast7d: stream.filter((r) => within(r.last_event_at, 7 * DAY) && !within(r.to_at, 7 * DAY)).length,
      leaveLast30d: stream.filter((r) => within(r.last_event_at, 30 * DAY) && !within(r.to_at, 30 * DAY)).length,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  if (firstSighting.length || bytesChanged.length) {
    console.log("\nreported, not touched:");
    for (const c of firstSighting) console.log(`  first sighting  ${c.program_id}  ${c.type} slot ${c.slot}  ${c.signature}`);
    for (const c of bytesChanged) console.log(`  bytes changed   ${c.program_id}  ${c.type} slot ${c.slot}  ${c.signature}`);
  }
  if (stream.length) {
    console.log("\nupgrade-stream programs redated (newest first):");
    for (const r of [...stream].sort((a, b) => ms(b.last_event_at) - ms(a.last_event_at)).slice(0, 15))
      console.log(`  ${r.id}  ${iso(r.last_event_at)} → ${iso(r.to_at)}`);
  }

  if (out) {
    const lines = ["what\tprogram\tfrom\tto\tdetail"];
    for (const c of retype) lines.push(`event-retype\t${c.program_id}\t${c.type}\textend\t${c.signature} slot ${c.slot}`);
    for (const c of firstSighting) lines.push(`report-first-sighting\t${c.program_id}\t${c.type}\t-\t${c.signature} slot ${c.slot}`);
    for (const c of bytesChanged) lines.push(`report-bytes-changed\t${c.program_id}\t${c.type}\t-\t${c.signature} slot ${c.slot}`);
    for (const r of moved) lines.push(`subject-redate\t${r.id}\t${iso(r.last_event_at)}\t${iso(r.to_at)}\tdeploy_type=${r.deploy_type ?? "-"}`);
    for (const r of noOther) lines.push(`report-no-code-change\t${r.id}\t${iso(r.last_event_at)}\t-\t`);
    writeFileSync(out, lines.join("\n") + "\n");
    logger.info({ out, lines: lines.length - 1 }, "repair-extend-captures: changes written");
  }

  if (!write) return;

  await db.transaction(async (tx) => {
    for (let i = 0; i < retype.length; i += 500) {
      const ids = JSON.stringify(retype.slice(i, i + 500).map((c) => c.id));
      await tx.execute(sql`
        update events set type = 'extend'
        where id in (select jsonb_array_elements_text(${ids}::jsonb)) and type in ('deploy', 'upgrade')
      `);
    }
    for (let i = 0; i < moved.length; i += 500) {
      const batch = JSON.stringify(moved.slice(i, i + 500).map((r) => ({ id: r.id, from: iso(r.last_event_at), to: iso(r.to_at) })));
      // guarded on the value read: a subject the live pipeline redated since is left alone
      await tx.execute(sql`
        update subjects s set last_event_at = v."to", updated_at = now()
        from jsonb_to_recordset(${batch}::jsonb) as v(id text, "from" timestamptz, "to" timestamptz)
        where s.id = v.id and s.network = ${network}
          and date_trunc('milliseconds', s.last_event_at) = date_trunc('milliseconds', v."from")
      `);
    }
  });
  logger.info({ retyped: retype.length, redated: moved.length }, "repair-extend-captures: written");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "repair-extend-captures: fatal");
    process.exit(1);
  });
