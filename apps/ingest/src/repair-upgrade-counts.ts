import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, logger, newId, type Network } from "@onrecord/core";
import { requireDatabaseTarget, requireRpcKey } from "./db-target.js";
import { refreshLoaderRecord } from "./loader-history.js";
import { SYNTHETIC_SIG_PREFIXES } from "./timeline.js";

// ---------------------------------------------------------------------------
// Repair "upgraded ×N" and deploy-vs-upgrade from the loader record.
//
// Both used to be ProgramData signatures minus one. Those signatures include
// extends, authority changes, closes, failed attempts and every call that
// passes the account in to check the admin (Anchor's ProgramData constraint).
// Measured on mainnet 2026-10-06: 5,079 of 5,767 nonzero counts overstated,
// 959 programs on the upgrade stream with no successful upgrade at all.
//
// Rewrites, per program with a loader walk:
//   subjects.facts.upgradeCount           successful `upgrade` instructions
//   subjects.facts.upgradeCountTruncated  the walk is truncated or partial
//   subjects.deploy_type                  'upgrade' when that count is > 0
// and the timeline rows the same mistake wrote into `events`:
//   - real-signature rows from ingestDeployHistory / recordGenesisDeploy whose
//     transaction has no successful deploy or upgrade for the program: deleted
//     (a genesis row deleted this way is replaced by the real first deploy)
//   - rows whose type disagrees with the loader instruction: retyped. That
//     includes poller captures the pipeline relabelled 'upgrade' on the old
//     count; a capture is matched by its slot, which is the deploy slot the
//     ProgramData header carried.
// Rows that pipeline stages processed with a real signature are reported, not
// touched: they carry enrichment.
//
// Programs whose code changed after their walk are re-read first (incremental,
// about one credit each); --no-refresh skips that and says how many are stale.
// A truncated or partial walk whose read part shows no upgrade keeps its
// deploy_type: missing evidence is not evidence of a new program.
//
//   ./node_modules/.bin/tsx src/repair-upgrade-counts.ts [flags]
//     --network mainnet|devnet   default mainnet
//     --write                    apply (default: dry run, writes nothing)
//     --no-refresh               don't read the chain
//     --budget N                 Helius credits for refresh reads, default 20000
//     --out FILE                 every change as TSV
// ---------------------------------------------------------------------------

const SCRIPT = "repair-upgrade-counts.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const network = (flag("network") ?? "mainnet") as Network;
const write = has("write");
const refresh = !has("no-refresh");
const budget = Number(flag("budget") ?? 20_000);
const out = flag("out");
const CONCURRENCY = 8;

const isSynthetic = (sig: string) => SYNTHETIC_SIG_PREFIXES.some((p) => sig.startsWith(p));

interface Subject {
  id: string;
  deploy_type: string | null;
  uc: number | null;
  ut: boolean;
  novelty_band: string | null;
  first_seen_at: string | null;
  closed: boolean;
  status: string | null;
  newest_slot: string | null;
  last_event_slot: string | null;
}

interface Ev {
  id: string;
  program_id: string;
  signature: string;
  type: string;
  pipeline_stage: string;
  slot: string;
  block_time: string | null;
  program_data_address: string | null;
}

interface LoaderAgg {
  program_id: string;
  upgrades: number;
  genesis_signature: string | null;
  genesis_slot: string | null;
  genesis_time: string | null;
}

async function run(): Promise<void> {
  const target = requireDatabaseTarget(SCRIPT);
  if (refresh) requireRpcKey(SCRIPT);
  logger.info({ target, network, write, refresh, budget }, "repair-upgrade-counts: start");

  const subjects = (await db.execute(sql`
    select s.id, s.deploy_type, (s.facts ->> 'upgradeCount')::int as uc,
      coalesce((s.facts ->> 'upgradeCountTruncated')::boolean, false) as ut,
      s.novelty_band, s.first_seen_at, (s.facts ->> 'closedAt') is not null as closed,
      w.status, w.newest_slot,
      (select max(e.slot) from events e
        where e.program_id = s.id and e.network = s.network and e.type in ('deploy', 'upgrade')) as last_event_slot
    from subjects s
    left join loader_walks w on w.network = s.network and w.program_id = s.id
    where s.kind = 'program' and s.network = ${network}
  `)) as unknown as Subject[];

  // --- 1. bring stale walks up to date --------------------------------------
  // stale: never walked, an errored walk, or an event newer than the walk
  const stale = subjects.filter(
    (s) =>
      !s.status ||
      s.status === "error" ||
      (s.status !== "truncated" &&
        s.status !== "empty" &&
        s.last_event_slot != null &&
        s.newest_slot != null &&
        Number(s.last_event_slot) > Number(s.newest_slot)),
  );
  const staleIds = new Set(stale.map((s) => s.id));
  /** dry run: what the refresh read but did not store, per program */
  const fresh = new Map<string, { upgrades: number; status: string; replaces: boolean }>();
  const refreshErrors: string[] = [];
  let spent = 0;
  let stoppedOnBudget = 0;
  if (refresh) {
    let next = 0;
    const worker = async () => {
      while (next < stale.length) {
        const s = stale[next++]!;
        if (spent >= budget) {
          stoppedOnBudget++;
          continue;
        }
        const w = await refreshLoaderRecord(network, s.id, { store: write });
        spent += w.credits;
        if (w.walk.status === "error") {
          refreshErrors.push(s.id);
          continue;
        }
        fresh.set(s.id, {
          upgrades: w.rows.filter((r) => r.kind === "upgrade" && !r.failed).length,
          status: w.walk.status,
          // a full re-read replaces what is stored; an incremental one adds to it
          replaces: !w.previous || w.previous.status === "error",
        });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    logger.info({ stale: stale.length, refreshed: fresh.size, spent, errors: refreshErrors.length }, "repair-upgrade-counts: refreshed");
  }

  // --- 2. what the loader record says, per program ---------------------------
  const aggRows = (await db.execute(sql`
    select program_id,
      count(*) filter (where kind = 'upgrade' and not failed)::int as upgrades,
      (array_agg(signature order by slot, outer_index, inner_index) filter (where kind = 'deploy' and not failed))[1] as genesis_signature,
      min(slot) filter (where kind = 'deploy' and not failed) as genesis_slot,
      (array_agg(block_time order by slot, outer_index, inner_index) filter (where kind = 'deploy' and not failed))[1] as genesis_time
    from loader_txns where network = ${network}
    group by 1
  `)) as unknown as LoaderAgg[];
  const agg = new Map(aggRows.map((r) => [r.program_id, r]));
  const walkStatus = new Map(
    ((await db.execute(sql`select program_id, status, newest_slot from loader_walks where network = ${network}`)) as unknown as {
      program_id: string;
      status: string;
      newest_slot: string | null;
    }[]).map((r) => [r.program_id, r]),
  );

  // --- 3. subject changes ----------------------------------------------------
  interface Change {
    id: string;
    fromType: string | null;
    toType: string;
    fromCount: number | null;
    toCount: number;
    fromTrunc: boolean;
    toTrunc: boolean;
    s: Subject;
  }
  const changes: Change[] = [];
  const skipped = { unidentified: 0, noWalk: 0, staleUnread: 0 };
  const before = { upgradeType: 0, countPositive: 0, countSum: 0, truncated: 0 };
  const after = { upgradeType: 0, countPositive: 0, countSum: 0, truncated: 0 };
  const tally = (t: typeof before, type: string | null, count: number, trunc: boolean) => {
    if (type === "upgrade") t.upgradeType++;
    if (count > 0) t.countPositive++;
    t.countSum += count;
    if (trunc) t.truncated++;
  };

  for (const s of subjects) {
    tally(before, s.deploy_type, s.uc ?? 0, s.ut);
    const keep = () => tally(after, s.deploy_type, s.uc ?? 0, s.ut);
    if (!s.deploy_type) {
      skipped.unidentified++;
      keep();
      continue;
    }
    const f = fresh.get(s.id);
    const status = f?.status ?? walkStatus.get(s.id)?.status ?? null;
    if (!status || status === "error") {
      skipped.noWalk++;
      keep();
      continue;
    }
    if (!f && staleIds.has(s.id)) skipped.staleUnread++;
    const stored = agg.get(s.id)?.upgrades ?? 0;
    // in a dry run the refreshed rows are only in memory
    const upgrades = write || !f ? stored : f.replaces ? f.upgrades : stored + f.upgrades;
    const incomplete = status === "truncated" || status === "partial";
    const toType = upgrades > 0 ? "upgrade" : incomplete && s.deploy_type === "upgrade" ? "upgrade" : "deploy";
    tally(after, toType, upgrades, incomplete);
    if (toType !== s.deploy_type || upgrades !== (s.uc ?? 0) || incomplete !== s.ut || s.uc == null) {
      changes.push({
        id: s.id,
        fromType: s.deploy_type,
        toType,
        fromCount: s.uc,
        toCount: upgrades,
        fromTrunc: s.ut,
        toTrunc: incomplete,
        s,
      });
    }
  }

  const toDeploy = changes.filter((c) => c.fromType === "upgrade" && c.toType === "deploy");
  const toUpgrade = changes.filter((c) => c.fromType !== "upgrade" && c.toType === "upgrade");
  const weekAgo = Date.now() - 7 * 86_400_000;
  const subjectSummary = {
    subjects: subjects.length,
    changed: changes.length,
    countLowered: changes.filter((c) => c.toCount < (c.fromCount ?? 0)).length,
    countRaised: changes.filter((c) => c.toCount > (c.fromCount ?? 0)).length,
    upgradeToDeploy: toDeploy.length,
    // where those land: the new-program stream shows only novel/variant bands,
    // dated by first sighting
    upgradeToDeployUngraded: toDeploy.filter((c) => !c.s.novelty_band).length,
    upgradeToDeployNovelOrVariant: toDeploy.filter((c) => c.s.novelty_band === "novel" || c.s.novelty_band === "variant").length,
    upgradeToDeployFirstSeenThisWeek: toDeploy.filter((c) => c.s.first_seen_at && Date.parse(c.s.first_seen_at) > weekAgo).length,
    upgradeToDeployClosed: toDeploy.filter((c) => c.s.closed).length,
    deployToUpgrade: toUpgrade.length,
    skipped,
    stale: stale.length,
    refreshed: fresh.size,
    refreshErrors: refreshErrors.length,
    refreshSkippedOnBudget: stoppedOnBudget,
    credits: spent,
    before,
    after,
  };

  // --- 4. timeline rows ------------------------------------------------------
  const events = (await db.execute(sql`
    select e.id, e.program_id, e.signature, e.type, e.pipeline_stage, e.slot, e.block_time, e.program_data_address
    from events e
    where e.network = ${network} and e.type in ('deploy', 'upgrade')
      and exists (select 1 from loader_walks w where w.network = e.network and w.program_id = e.program_id and w.status = 'complete')
  `)) as unknown as Ev[];
  // successful deploy/upgrade rows, by program → signature and program → slot
  const loaderCode = (await db.execute(sql`
    select program_id, signature, slot, kind from loader_txns
    where network = ${network} and kind in ('deploy', 'upgrade') and not failed
  `)) as unknown as { program_id: string; signature: string; slot: string; kind: string }[];
  const bySig = new Map<string, string>();
  const bySlot = new Map<string, string>();
  for (const r of loaderCode) {
    // deploy wins a tie: a transaction that deploys and upgrades is the deploy
    const k1 = `${r.program_id}|${r.signature}`;
    if (bySig.get(k1) !== "deploy") bySig.set(k1, r.kind);
    const k2 = `${r.program_id}|${r.slot}`;
    if (bySlot.get(k2) !== "deploy") bySlot.set(k2, r.kind);
  }
  // what the loader says each non-code signature was, for the report
  const otherKinds = new Map<string, string>();
  for (const r of (await db.execute(sql`
    select program_id, signature, string_agg(distinct kind || case when failed then '(failed)' else '' end, ',') as kinds
    from loader_txns where network = ${network} group by 1, 2
  `)) as unknown as { program_id: string; signature: string; kinds: string }[]) {
    otherKinds.set(`${r.program_id}|${r.signature}`, r.kinds);
  }

  const del: (Ev & { reason: string })[] = [];
  const retype: (Ev & { to: string })[] = [];
  const reportOnly: Record<string, number> = {};
  let uncovered = 0;
  let captureUnmatched = 0;
  const genesisLost = new Set<string>();
  for (const e of events) {
    const w = walkStatus.get(e.program_id);
    // only what the walk covered: a newer row may be an upgrade it hasn't seen
    if (!w?.newest_slot || Number(e.slot) > Number(w.newest_slot)) {
      uncovered++;
      continue;
    }
    if (isSynthetic(e.signature)) {
      const kind = bySlot.get(`${e.program_id}|${e.slot}`);
      if (!kind) captureUnmatched++;
      else if (kind !== e.type) retype.push({ ...e, to: kind });
      continue;
    }
    const kind = bySig.get(`${e.program_id}|${e.signature}`);
    if (kind === e.type) continue;
    const timelineOnly = e.pipeline_stage === "ingested" || e.pipeline_stage === "genesis";
    if (!timelineOnly) {
      const k = `${e.type} → ${kind ?? otherKinds.get(`${e.program_id}|${e.signature}`) ?? "no loader instruction"}`;
      reportOnly[k] = (reportOnly[k] ?? 0) + 1;
      continue;
    }
    if (kind) retype.push({ ...e, to: kind });
    else {
      del.push({ ...e, reason: otherKinds.get(`${e.program_id}|${e.signature}`) ?? "no loader instruction" });
      if (e.pipeline_stage === "genesis") genesisLost.add(e.program_id);
    }
  }
  // a deleted genesis row is replaced by the real first deploy, unless that is
  // already on the timeline
  const deletedIds = new Set(del.map((e) => e.id));
  const remainingSigs = new Set(events.filter((e) => !deletedIds.has(e.id)).map((e) => e.signature));
  const pdOf = new Map(events.filter((e) => e.program_data_address).map((e) => [e.program_id, e.program_data_address!]));
  const genesisAdd = [...genesisLost]
    .map((id) => ({ id, a: agg.get(id), pd: pdOf.get(id) }))
    .filter((g) => g.a?.genesis_signature && g.a.genesis_slot != null && g.pd && !remainingSigs.has(g.a.genesis_signature));

  const reasons: Record<string, number> = {};
  for (const e of del) {
    const k = `${e.pipeline_stage}/${e.type}: ${e.reason}`;
    reasons[k] = (reasons[k] ?? 0) + 1;
  }
  const retypes: Record<string, number> = {};
  for (const e of retype) {
    const k = `${isSynthetic(e.signature) ? "capture" : e.pipeline_stage} ${e.type} → ${e.to}`;
    retypes[k] = (retypes[k] ?? 0) + 1;
  }
  const timelineSummary = {
    eventsOnWalkedPrograms: events.length,
    notCoveredByWalk: uncovered,
    captureWithNoLoaderRowAtSlot: captureUnmatched,
    delete: del.length,
    deleteByReason: reasons,
    retype: retype.length,
    retypeBy: retypes,
    genesisReplaced: genesisAdd.length,
    pipelineRowsReportedNotTouched: reportOnly,
  };

  console.log(JSON.stringify({ target, network, write, subjects: subjectSummary, timeline: timelineSummary }, null, 2));
  const biggest = [...changes].sort((a, b) => (b.fromCount ?? 0) - b.toCount - ((a.fromCount ?? 0) - a.toCount)).slice(0, 15);
  console.log("\nlargest corrections:");
  for (const c of biggest) console.log(`  ${c.id}  ${c.fromType} ×${c.fromCount ?? "-"} → ${c.toType} ×${c.toCount}${c.toTrunc ? "+" : ""}`);

  if (out) {
    const lines = ["what\tprogram\tfrom\tto\tdetail"];
    for (const c of changes)
      lines.push(`subject\t${c.id}\t${c.fromType} ×${c.fromCount ?? "-"}${c.fromTrunc ? "+" : ""}\t${c.toType} ×${c.toCount}${c.toTrunc ? "+" : ""}\tband=${c.s.novelty_band ?? "-"}`);
    for (const e of del) lines.push(`event-delete\t${e.program_id}\t${e.pipeline_stage}/${e.type}\t-\t${e.signature} ${e.reason}`);
    for (const e of retype) lines.push(`event-retype\t${e.program_id}\t${e.type}\t${e.to}\t${e.signature}`);
    for (const g of genesisAdd) lines.push(`event-genesis\t${g.id}\t-\tdeploy\t${g.a!.genesis_signature}`);
    writeFileSync(out, lines.join("\n") + "\n");
    logger.info({ out, lines: lines.length - 1 }, "repair-upgrade-counts: changes written");
  }

  if (!write) return;

  // --- 5. apply --------------------------------------------------------------
  await db.transaction(async (tx) => {
    for (let i = 0; i < changes.length; i += 500) {
      const batch = changes.slice(i, i + 500).map((c) => ({ id: c.id, t: c.toType, n: c.toCount, tr: c.toTrunc }));
      await tx.execute(sql`
        update subjects s set
          deploy_type = v.t,
          facts = coalesce(s.facts, '{}'::jsonb) || jsonb_build_object('upgradeCount', v.n, 'upgradeCountTruncated', v.tr),
          updated_at = now()
        from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) as v(id text, t text, n int, tr boolean)
        where s.id = v.id and s.network = ${network}
      `);
    }
    // seed real genesis rows before deleting the wrong ones, so no program is
    // ever left without a deploy row
    for (const g of genesisAdd) {
      await tx.execute(sql`
        insert into events (id, network, type, signature, instruction_index, slot, block_time, program_id, program_data_address, pipeline_stage)
        values (${newId("evt")}, ${network}, 'deploy', ${g.a!.genesis_signature}, 0, ${g.a!.genesis_slot}, ${g.a!.genesis_time},
          ${g.id}, ${g.pd}, 'genesis')
        on conflict (signature, instruction_index) do nothing
      `);
    }
    for (let i = 0; i < del.length; i += 500) {
      const ids = JSON.stringify(del.slice(i, i + 500).map((e) => e.id));
      await tx.execute(sql`delete from events where id in (select jsonb_array_elements_text(${ids}::jsonb))`);
    }
    for (const to of ["deploy", "upgrade"]) {
      const ids = retype.filter((e) => e.to === to).map((e) => e.id);
      for (let i = 0; i < ids.length; i += 500) {
        await tx.execute(sql`
          update events set type = ${to}
          where id in (select jsonb_array_elements_text(${JSON.stringify(ids.slice(i, i + 500))}::jsonb))
        `);
      }
    }
  });
  logger.info({ subjects: changes.length, deleted: del.length, retyped: retype.length, genesis: genesisAdd.length }, "repair-upgrade-counts: written");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "repair-upgrade-counts: fatal");
    process.exit(1);
  });
