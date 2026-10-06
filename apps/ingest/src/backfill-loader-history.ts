import { sql } from "drizzle-orm";
import { db, logger, type Network } from "@onrecord/core";
import { requireDatabaseTarget, requireRpcKey } from "./db-target.js";
import { storeWalk, walkLoaderHistory, type LoaderRow } from "./loader-history.js";

// ---------------------------------------------------------------------------
// Backfill the loader record (research/deployer-behavior-plan.md, step 2).
//
// Walks every tracked program's ProgramData history into loader_txns, and what
// each walk covered into loader_walks. Resumable: programs already walked are
// skipped unless --refresh. Metered: stops starting new programs once --budget
// getTransaction calls are spent (1 credit each on Helius; the calibration
// sample put the whole mainnet corpus near 210k).
//
//   ./node_modules/.bin/tsx src/backfill-loader-history.ts [flags]
//     --network mainnet|devnet   default mainnet
//     --sample N                 N random programs instead of all
//     --budget N                 getTransaction calls to spend, default 300000
//     --concurrency N            programs walked at once, default 8
//     --dry                      read and summarise, write nothing
//     --refresh                  re-walk programs already walked
// ---------------------------------------------------------------------------

const SCRIPT = "backfill-loader-history.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const network = (flag("network") ?? "mainnet") as Network;
const sample = flag("sample") ? Number(flag("sample")) : null;
const budget = Number(flag("budget") ?? 300_000);
const concurrency = Number(flag("concurrency") ?? 8);
const dry = has("dry");
const refresh = has("refresh");

async function run(): Promise<void> {
  const target = requireDatabaseTarget(SCRIPT);
  requireRpcKey(SCRIPT);
  logger.info({ target, network, sample, budget, concurrency, dry, refresh }, "loader-backfill: start");

  const skip = refresh || dry
    ? sql``
    : sql`and not exists (select 1 from loader_walks w where w.network = s.network and w.program_id = s.id and w.status <> 'error')`;
  const order = sample ? sql`order by random() limit ${sample}` : sql`order by s.id`;
  const programs = (await db.execute(sql`
    select s.id from subjects s
    where s.kind = 'program' and s.network = ${network} ${skip}
    ${order}
  `)).map((r) => (r as { id: string }).id);
  logger.info({ programs: programs.length }, "loader-backfill: to walk");

  let spent = 0;
  let next = 0;
  let done = 0;
  const status: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  let signatures = 0;
  let nonLoader = 0;
  let programsWithNonLoader = 0;
  let stoppedOnBudget = false;
  const examples: LoaderRow[] = [];
  const started = Date.now();

  async function worker(): Promise<void> {
    while (next < programs.length) {
      if (spent >= budget) {
        stoppedOnBudget = true;
        return;
      }
      const programId = programs[next++]!;
      const w = await walkLoaderHistory(network, programId);
      spent += w.calls;
      if (!dry) {
        try {
          await storeWalk(w);
        } catch (err) {
          logger.error({ programId, err: String(err) }, "loader-backfill: store failed");
          status["store-error"] = (status["store-error"] ?? 0) + 1;
          continue;
        }
      }
      done++;
      status[w.walk.status] = (status[w.walk.status] ?? 0) + 1;
      signatures += w.walk.signatures ?? 0;
      nonLoader += w.walk.nonLoader ?? 0;
      if ((w.walk.nonLoader ?? 0) > 0) programsWithNonLoader++;
      for (const r of w.rows) {
        kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
        if (dry && examples.length < 4 && (r.kind === "set_authority" || r.invokedBy)) examples.push(r);
      }
      if (done % 250 === 0) {
        const rate = done / ((Date.now() - started) / 60_000);
        logger.info(
          { done, of: programs.length, spent, perMin: Math.round(rate), etaMin: Math.round((programs.length - done) / rate) },
          "loader-backfill: progress",
        );
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const summary = {
    target,
    network,
    dry,
    walked: done,
    of: programs.length,
    stoppedOnBudget,
    getTransactionCalls: spent,
    status,
    signatures,
    nonLoader,
    programsWithNonLoader,
    kinds,
    minutes: Math.round((Date.now() - started) / 6_000) / 10,
  };
  logger.info(summary, "loader-backfill: complete");
  if (dry) {
    console.log(JSON.stringify(summary, null, 2));
    for (const e of examples) console.log(JSON.stringify(e));
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "loader-backfill: fatal");
    process.exit(1);
  });
