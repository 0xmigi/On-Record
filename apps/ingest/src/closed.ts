import { sql } from "drizzle-orm";
import { db, logger, programDataAliveMany, type Network } from "@onrecord/core";
import { refreshInterest } from "./interest.js";
import { refreshLoaderRecord } from "./loader-history.js";
import { refreshDossier } from "./revalidate.js";

// ---------------------------------------------------------------------------
// Closed-program sweep. The loader's Close instruction deallocates a program's
// ProgramData account and reclaims its rent. The live poller enumerates
// *existing* ProgramData accounts, so it never observes a close — a closed
// program simply stops appearing. We detect the absence: if a fingerprinted
// program's ProgramData account is no longer alive, the program was closed.
//
// closedAt is the close transaction's block time when the loader record has it
// (closedAtSource 'loader'), else the time we noticed (closedAtSource
// 'detected') — an upper bound, never earlier than the real close. Stored in
// facts, no schema migration needed.
//
// This is the tail of a churn pattern — a bot redeploys the same bytecode under
// a fresh id, spams failed txns, then closes to reclaim rent, and repeats. But
// not only bots close: until 2026-10-07 the sweep looked only at programs first
// seen in the last 72h, and every one of the 5,853 closes it caught happened
// inside that window. 1,568 closed later (median 250h after first sighting) and
// stayed live on the radar. So there are two lanes now:
//   recent    first seen in the last CLOSED_SWEEP_HOURS — bots close within
//             minutes, so these are checked every run
//   rotation  every other unclosed program, stalest-checked first,
//             CLOSED_SWEEP_ROTATE_MAX per run. 500 every 15m walks ~7.7k
//             mainnet programs in about 4h for 5 getMultipleAccounts calls a run.
// Loader-v1/v2 programs have no ProgramData, so no events row carries one and
// neither lane selects them.
// ---------------------------------------------------------------------------

const RECENT_MAX = Number(process.env.CLOSED_SWEEP_MAX ?? 150);
const RECENT_HOURS = Number(process.env.CLOSED_SWEEP_HOURS ?? 72);
const ROTATE_MAX = Number(process.env.CLOSED_SWEEP_ROTATE_MAX ?? 500);

interface Target {
  id: string;
  pd: string;
}

/** Unclosed programs with a ProgramData address, never-checked first, then the
 *  stalest-checked. `recent` picks the lane. */
async function sweepTargets(network: Network, recent: boolean, limit: number): Promise<Target[]> {
  const since = new Date(Date.now() - RECENT_HOURS * 3_600_000).toISOString();
  return (await db.execute(sql`
    select s.id, e.pd
    from subjects s
    cross join lateral (
      select program_data_address as pd from events
      where program_id = s.id and network = s.network and program_data_address is not null
      limit 1
    ) e
    where s.network = ${network} and s.kind = 'program'
      and (s.facts ->> 'closedAt') is null
      and ${recent ? sql`s.first_seen_at >= ${since}` : sql`(s.first_seen_at is null or s.first_seen_at < ${since})`}
    order by s.facts ->> 'closedSweepAt' asc nulls first, s.first_seen_at desc
    limit ${limit}
  `)) as unknown as Target[];
}

export interface CloseTime {
  closedAt: string;
  source: "loader" | "detected";
}

/** When each of these (dead) programs was closed. The loader record's newest
 *  successful close row is the real time. Where it has none — the walk predates
 *  the close — `refresh` reads what landed since (incremental, a few credits)
 *  and looks again; `store: false` keeps that read in memory for a dry run.
 *  Anything still without a row is stamped `detectedAt`. */
export async function closeTimes(
  network: Network,
  ids: string[],
  opts: { refresh?: boolean; store?: boolean; detectedAt?: string } = {},
): Promise<{ times: Map<string, CloseTime>; credits: number; refreshed: number }> {
  const detectedAt = opts.detectedAt ?? new Date().toISOString();
  const times = new Map<string, CloseTime>();
  if (ids.length === 0) return { times, credits: 0, refreshed: 0 };
  const rows = (await db.execute(sql`
    select program_id, max(block_time) as at from loader_txns
    where network = ${network} and kind = 'close' and not failed and block_time is not null
      and program_id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
    group by 1
  `)) as unknown as { program_id: string; at: string | Date }[];
  for (const r of rows) times.set(r.program_id, { closedAt: new Date(r.at).toISOString(), source: "loader" });

  let credits = 0;
  let refreshed = 0;
  for (const id of ids) {
    if (times.has(id)) continue;
    if (opts.refresh) {
      try {
        const w = await refreshLoaderRecord(network, id, { store: opts.store ?? true });
        credits += w.credits;
        refreshed++;
        const close = w.rows
          .filter((r) => r.kind === "close" && !r.failed && r.blockTime)
          .sort((a, b) => b.slot - a.slot)[0];
        if (close) {
          times.set(id, { closedAt: close.blockTime!.toISOString(), source: "loader" });
          continue;
        }
      } catch (err) {
        logger.warn({ id, err: String(err) }, "close time: loader refresh failed");
      }
    }
    times.set(id, { closedAt: detectedAt, source: "detected" });
  }
  return { times, credits, refreshed };
}

/** Mark programs closed, then rescore them and every program whose family
 *  they belong to — a family's closed share is part of each member's score, so
 *  a close moves its siblings too. Returns how many family members were
 *  rescored besides the closed ones. */
export async function markClosed(
  network: Network,
  times: Map<string, CloseTime>,
  sweptAt: string,
): Promise<{ marked: number; siblings: number }> {
  const batch = [...times].map(([id, t]) => ({ id, at: t.closedAt, src: t.source }));
  for (let i = 0; i < batch.length; i += 500) {
    await db.execute(sql`
      update subjects s set
        facts = coalesce(s.facts, '{}'::jsonb)
          || jsonb_build_object('closedAt', v.at, 'closedAtSource', v.src, 'closedSweepAt', ${sweptAt}::text),
        updated_at = now()
      from jsonb_to_recordset(${JSON.stringify(batch.slice(i, i + 500))}::jsonb) as v(id text, at text, src text)
      where s.id = v.id and s.network = ${network} and (s.facts ->> 'closedAt') is null
    `);
  }
  const ids = [...times.keys()];
  const siblings = await familyOf(network, ids);
  for (const id of [...ids, ...siblings]) {
    try {
      await refreshInterest(id); // closed penalty applies immediately
      refreshDossier(id);
    } catch (err) {
      logger.warn({ id, err: String(err) }, "closed: rescore failed");
    }
  }
  return { marked: ids.length, siblings: siblings.length };
}

/** Open programs that share a copy bucket or a crate with any of these — a
 *  superset of the families interest.ts discounts against (sourceFamily also
 *  wants shared paths), which is fine for deciding what to rescore. Closed
 *  siblings are left out: their score is already capped at 0.05 and they are
 *  off the radar, and the biggest crate has 766 members. */
export async function familyOf(network: Network, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = (await db.execute(sql`
    with c as (
      select bucket_id, crate from subjects
      where network = ${network} and id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
    )
    select distinct s.id from subjects s
    where s.network = ${network} and s.kind = 'program' and (s.facts ->> 'closedAt') is null
      and s.id not in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
      and (s.bucket_id in (select bucket_id from c where bucket_id is not null)
        or s.crate in (select crate from c where crate is not null))
  `)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

export async function sweepClosed(network: Network = "mainnet"): Promise<void> {
  const recent = await sweepTargets(network, true, RECENT_MAX);
  const rotation = ROTATE_MAX > 0 ? await sweepTargets(network, false, ROTATE_MAX) : [];
  const targets = [...recent, ...rotation];

  let aliveByPd: Map<string, boolean>;
  try {
    // Alive = present + funded + state tag 3. A closed program's ProgramData
    // is NOT deleted — it survives as a 4-byte Uninitialized husk with zero
    // lamports, so a bare existence probe never detects a close. Batched, one
    // credit per 100. Throws on RPC error, so a transient failure skips the
    // run rather than false-marks.
    aliveByPd = await programDataAliveMany(network, [...new Set(targets.map((t) => t.pd))]);
  } catch (err) {
    logger.warn({ network, err: String(err) }, "closed sweep: batch lookup failed");
    return;
  }

  const sweptAt = new Date().toISOString();
  const alive = targets.filter((t) => aliveByPd.get(t.pd) === true).map((t) => t.id);
  const dead = targets.filter((t) => aliveByPd.get(t.pd) === false).map((t) => t.id);

  try {
    for (let i = 0; i < alive.length; i += 500) {
      await db.execute(sql`
        update subjects set facts = coalesce(facts, '{}'::jsonb) || jsonb_build_object('closedSweepAt', ${sweptAt}::text)
        where network = ${network} and id in (select jsonb_array_elements_text(${JSON.stringify(alive.slice(i, i + 500))}::jsonb))
      `);
    }
    const { times, credits } = await closeTimes(network, dead, { refresh: true, detectedAt: sweptAt });
    const { siblings } = await markClosed(network, times, sweptAt);
    const fromLoader = [...times.values()].filter((t) => t.source === "loader").length;
    logger.info(
      { network, recent: recent.length, rotation: rotation.length, checked: alive.length + dead.length, closed: dead.length, fromLoader, siblings, credits },
      "closed sweep: done",
    );
  } catch (err) {
    logger.warn({ network, err: String(err) }, "closed sweep: write failed");
  }
}

