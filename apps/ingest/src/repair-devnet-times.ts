import { sql } from "drizzle-orm";
import { db, getBlockTime, getSlot, logger } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Repair devnet event times — one-off, for rows written before the poller read
// real block times (2026-10-23).
//
// The poller and backfill dated each program by counting slots back from now
// at 2.5 slots/s. That is roughly mainnet's rate; devnet runs at its own, and
// it has drifted: ~2.7/s in June–July, ~4.7/s in August–September, ~4.1/s now.
// So every polled devnet event sat hours to days away from when it happened,
// and the program's firstSeenAt / lastEventAt carried the same error.
//
// This samples the chain's own block time every STEP slots across the range
// on record and interpolates each event's slot between its two neighbours.
// Everything else happens in SQL: no rows leave the database, only counts.
// Only events off by more than five minutes are touched, so a row that already
// carries a real time (backfill-incubation writes the deploy history's) stays
// exactly as it is.
//
//   node dist/repair-devnet-times.js            (dry run: counts only)
//   node dist/repair-devnet-times.js --apply
// ---------------------------------------------------------------------------

const STEP = 50_000; // ~3.4h of devnet at today's rate
const TOLERANCE_SECS = 300;

async function anchorAt(slot: number): Promise<[number, number] | null> {
  // a skipped slot has no block; the next few usually do
  for (let s = slot; s < slot + 20; s++) {
    const t = await getBlockTime("devnet", s);
    if (t != null) return [s, t];
  }
  return null;
}

async function repairDevnetTimes(apply: boolean): Promise<void> {
  const range = await db.execute<{ lo: string | null; hi: string | null; n: string }>(sql`
    select min(slot) as lo, max(slot) as hi, count(*) as n from events
    where network = 'devnet' and (signature like 'poll:%' or signature like 'backfill:%')
  `);
  const lo = Number(range[0]?.lo ?? 0);
  const hi = Number(range[0]?.hi ?? 0);
  if (!lo || !hi) {
    logger.info("repair-devnet-times: no polled devnet events");
    return;
  }

  const current = await getSlot("devnet");
  const slots: number[] = [];
  for (let s = Math.floor(lo / STEP) * STEP; s < hi; s += STEP) slots.push(s);
  slots.push(Math.min(hi + STEP, current - 100)); // close the range above the newest event

  const anchors: [number, number][] = [];
  for (let i = 0; i < slots.length; i += 8) {
    const batch = await Promise.all(slots.slice(i, i + 8).map(anchorAt));
    for (const a of batch) if (a) anchors.push(a);
  }
  anchors.sort((a, b) => a[0] - b[0]);
  logger.info(
    { events: Number(range[0]?.n), slotLo: lo, slotHi: hi, anchors: anchors.length, requested: slots.length },
    "repair-devnet-times: anchors fetched",
  );

  const fixes = sql`
    with a as (
      select (x->>0)::bigint as s, to_timestamp((x->>1)::double precision) as t
      from jsonb_array_elements(${JSON.stringify(anchors)}::jsonb) x
    ),
    interp as (
      select e.id, e.program_id, e.slot, e.block_time as old_t,
        lo.t + (hi.t - lo.t) * ((e.slot - lo.s)::double precision / (hi.s - lo.s)) as new_t
      from events e
      cross join lateral (select s, t from a where a.s <= e.slot order by s desc limit 1) lo
      cross join lateral (select s, t from a where a.s > e.slot order by s asc limit 1) hi
      where e.network = 'devnet' and (e.signature like 'poll:%' or e.signature like 'backfill:%')
    )
    select * from interp
    where old_t is null or abs(extract(epoch from new_t - old_t)) > ${TOLERANCE_SECS}
  `;

  await db.transaction(async (tx) => {
    await tx.execute(sql`create temp table fix on commit drop as ${fixes}`);
    const [summary] = await tx.execute<Record<string, string>>(sql`
      select count(*) as events,
        round((percentile_cont(0.5) within group (order by extract(epoch from old_t - new_t)) / 3600)::numeric, 1) as median_shift_h,
        round(max(abs(extract(epoch from old_t - new_t))) / 3600, 1) as max_shift_h,
        (select count(*) from subjects s join fix f
           on f.program_id = s.id and f.slot = s.first_seen_slot and f.old_t = s.first_seen_at
           where s.network = 'devnet') as first_seen,
        (select count(distinct s.id) from subjects s join fix f
           on f.program_id = s.id and f.old_t = s.last_event_at
           where s.network = 'devnet') as last_event
      from fix
    `);
    logger.info({ ...summary, apply }, "repair-devnet-times: plan");
    if (!apply) return;

    // subjects first: they are matched on the events' OLD times
    await tx.execute(sql`
      update subjects s set first_seen_at = f.new_t
      from fix f
      where s.network = 'devnet' and f.program_id = s.id
        and f.slot = s.first_seen_slot and f.old_t = s.first_seen_at
    `);
    await tx.execute(sql`
      update subjects s set last_event_at = f.new_t
      from fix f
      where s.network = 'devnet' and f.program_id = s.id and f.old_t = s.last_event_at
    `);
    await tx.execute(sql`update events e set block_time = f.new_t from fix f where e.id = f.id`);
    logger.info("repair-devnet-times: applied");
  });
}

// --- CLI --------------------------------------------------------------------
const isMain =
  process.argv[1]?.endsWith("repair-devnet-times.js") || process.argv[1]?.endsWith("repair-devnet-times.ts");
if (isMain) {
  repairDevnetTimes(process.argv.includes("--apply"))
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err: String(err) }, "repair-devnet-times: failed");
      process.exit(1);
    });
}
