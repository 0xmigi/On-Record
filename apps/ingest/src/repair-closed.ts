import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import {
  db,
  logger,
  rpc,
  programDataAliveMany,
  LOADER_PROGRAM_ID,
  type Network,
} from "@onrecord/core";
import { requireDatabaseTarget, requireRpcKey } from "./db-target.js";
import { closeTimes, familyOf, markClosed } from "./closed.js";
import { flushDossiers } from "./revalidate.js";

// ---------------------------------------------------------------------------
// Mark the programs the closed sweep never looked at.
//
// Until 2026-10-07 sweepClosed only checked programs first seen in the last
// 72h. Every close it caught happened inside that window; the ones that came
// later were never marked, so facts.closedAt stayed null and the radar, the
// alerts and the interest score treated them as live. Measured on mainnet
// 2026-10-07: of 7,764 unclosed program subjects, 1,616 had no live
// ProgramData — 1,568 with a close in the loader record, 42 without one yet,
// 6 loader-v1/v2 programs that have no ProgramData at all.
//
// Per unclosed program with a ProgramData address:
//   1. re-read the ProgramData header now (getMultipleAccounts, 100 a call);
//      only a dead one is marked, whatever the loader record says
//   2. check the Program account is owned by the upgradeable loader; anything
//      else is reported, not marked
//   3. closedAt = the loader record's newest successful close (the real block
//      time). Without one, read the record forward from its last walk
//      (incremental, a few credits) and look again; failing that, stamp now.
//      closedAtSource says which.
//   4. rescore it and the open members of its family, refresh its dossier
//
//   ./node_modules/.bin/tsx src/repair-closed.ts [flags]
//     --network mainnet|devnet   default mainnet
//     --write                    apply (default: dry run, writes nothing)
//     --no-refresh               don't read loader history for missing closes
//     --out FILE                 every program it would mark, as TSV
// ---------------------------------------------------------------------------

const SCRIPT = "repair-closed.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const network = (flag("network") ?? "mainnet") as Network;
const write = has("write");
const refresh = !has("no-refresh");
const out = flag("out");

interface Candidate {
  id: string;
  pd: string;
  first_seen_at: string | null;
  first_deploy_at: string | null;
  band: string | null;
  score: number | null;
  name: string | null;
  close_rows: number;
}

/** Program account owners, 100 a call, no data. null = no account. */
async function ownersOf(ids: string[]): Promise<Map<string, string | null>> {
  const owners = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const res = await rpc<{ value: ({ owner: string } | null)[] }>(network, "getMultipleAccounts", [
      chunk,
      { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" },
    ]);
    chunk.forEach((id, j) => owners.set(id, res.value[j]?.owner ?? null));
  }
  return owners;
}

const hours = (from: string | null, to: string) => (from ? (Date.parse(to) - Date.parse(from)) / 3_600_000 : null);

function quantiles(xs: number[]): string {
  if (xs.length === 0) return "-";
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  const f = (h: number) => (h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`);
  return `p10 ${f(q(0.1))} · p50 ${f(q(0.5))} · p90 ${f(q(0.9))} · max ${f(s[s.length - 1]!)}`;
}

async function run(): Promise<void> {
  const target = requireDatabaseTarget(SCRIPT);
  requireRpcKey(SCRIPT);
  logger.info({ target, network, write, refresh }, "repair-closed: start");

  const [noPd] = (await db.execute(sql`
    select count(*)::int as n from subjects s
    where s.network = ${network} and s.kind = 'program' and (s.facts ->> 'closedAt') is null
      and not exists (select 1 from events e where e.program_id = s.id and e.network = s.network and e.program_data_address is not null)
  `)) as unknown as { n: number }[];

  const candidates = (await db.execute(sql`
    select s.id, e.pd, s.first_seen_at, s.first_deploy_at, s.novelty_band as band, s.novelty_score as score, s.name,
      (select count(*)::int from loader_txns t
        where t.network = s.network and t.program_id = s.id and t.kind = 'close' and not t.failed) as close_rows
    from subjects s
    cross join lateral (
      select program_data_address as pd from events
      where program_id = s.id and network = s.network and program_data_address is not null
      limit 1
    ) e
    where s.network = ${network} and s.kind = 'program' and (s.facts ->> 'closedAt') is null
  `)) as unknown as Candidate[];

  // --- 1. the chain, now ----------------------------------------------------
  const alive = await programDataAliveMany(network, [...new Set(candidates.map((c) => c.pd))]);
  const dead = candidates.filter((c) => alive.get(c.pd) === false);
  const unknown = candidates.filter((c) => alive.get(c.pd) === undefined);
  // the loader record says closed, the chain says alive: should never happen
  const closeRowButAlive = candidates.filter((c) => c.close_rows > 0 && alive.get(c.pd) === true);

  // --- 2. only upgradeable-loader programs -----------------------------------
  const owners = await ownersOf(dead.map((c) => c.id));
  const ownerTally: Record<string, number> = {};
  for (const c of dead) {
    const o = owners.get(c.id) ?? "no account";
    ownerTally[o] = (ownerTally[o] ?? 0) + 1;
  }
  const notUpgradeable = dead.filter((c) => owners.get(c.id) !== LOADER_PROGRAM_ID);
  const toMark = dead.filter((c) => owners.get(c.id) === LOADER_PROGRAM_ID);

  // --- 3. when ---------------------------------------------------------------
  const now = new Date().toISOString();
  const { times, credits, refreshed } = await closeTimes(
    network,
    toMark.map((c) => c.id),
    { refresh, store: write, detectedAt: now },
  );

  const byId = new Map(toMark.map((c) => [c.id, c]));
  const fromLoader = [...times].filter(([, t]) => t.source === "loader");
  const detected = [...times].filter(([, t]) => t.source === "detected");
  const recoveredByRefresh = fromLoader.filter(([id]) => byId.get(id)!.close_rows === 0).length;
  const lifespans = fromLoader
    .map(([id, t]) => hours(byId.get(id)!.first_deploy_at ?? byId.get(id)!.first_seen_at, t.closedAt))
    .filter((h): h is number => h != null && h >= 0);
  const seenToClose = fromLoader
    .map(([id, t]) => hours(byId.get(id)!.first_seen_at, t.closedAt))
    .filter((h): h is number => h != null);
  const bands: Record<string, number> = {};
  for (const c of toMark) bands[c.band ?? "ungraded"] = (bands[c.band ?? "ungraded"] ?? 0) + 1;
  const siblings = await familyOf(network, toMark.map((c) => c.id));

  console.log(
    JSON.stringify(
      {
        target,
        network,
        write,
        unclosedPrograms: candidates.length + noPd!.n,
        skippedNoProgramData: noPd!.n,
        checked: candidates.length - unknown.length,
        chainUnanswered: unknown.length,
        programDataDead: dead.length,
        deadWithCloseRow: dead.filter((c) => c.close_rows > 0).length,
        deadWithoutCloseRow: dead.filter((c) => c.close_rows === 0).length,
        closeRowButAlive: closeRowButAlive.length,
        programAccountOwners: ownerTally,
        skippedNotUpgradeable: notUpgradeable.length,
        toMark: toMark.length,
        closedAtFromLoader: fromLoader.length,
        closedAtRecoveredByRefresh: recoveredByRefresh,
        closedAtDetectedNow: detected.length,
        loaderRefreshes: refreshed,
        credits,
        bands,
        openSiblingsToRescore: siblings.length,
        firstSeenToClose: quantiles(seenToClose),
        lifespan: quantiles(lifespans),
      },
      null,
      2,
    ),
  );
  const top = [...toMark].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 15);
  console.log("\nhighest-scored programs this closes:");
  for (const c of top)
    console.log(`  ${c.id}  ${(c.score ?? 0).toFixed(3)}  ${c.band ?? "-"}  ${c.name ?? ""}  closed ${times.get(c.id)!.closedAt} (${times.get(c.id)!.source})`);
  if (closeRowButAlive.length) {
    console.log("\nclose in the loader record, ProgramData alive (not touched):");
    for (const c of closeRowButAlive.slice(0, 20)) console.log(`  ${c.id}`);
  }
  if (notUpgradeable.length) {
    console.log("\nProgramData dead, Program account not owned by the upgradeable loader (not touched):");
    for (const c of notUpgradeable.slice(0, 20)) console.log(`  ${c.id}  owner=${owners.get(c.id) ?? "none"}`);
  }
  if (detected.length) {
    console.log("\nno close in the loader record, stamped at detection:");
    for (const [id] of detected.slice(0, 50)) console.log(`  ${id}  first seen ${byId.get(id)!.first_seen_at}`);
  }

  if (out) {
    const lines = ["program\tclosed_at\tsource\tfirst_seen_at\tband\tscore\tname"];
    for (const c of toMark) {
      const t = times.get(c.id)!;
      lines.push(`${c.id}\t${t.closedAt}\t${t.source}\t${c.first_seen_at ?? ""}\t${c.band ?? ""}\t${c.score ?? ""}\t${c.name ?? ""}`);
    }
    writeFileSync(out, lines.join("\n") + "\n");
    logger.info({ out, rows: toMark.length }, "repair-closed: written to file");
  }

  if (!write) return;

  // --- 4. apply --------------------------------------------------------------
  const r = await markClosed(network, times, now);
  const flushed = await flushDossiers();
  logger.info({ ...r, dossiersQueued: flushed }, "repair-closed: written");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "repair-closed: fatal");
    process.exit(1);
  });
