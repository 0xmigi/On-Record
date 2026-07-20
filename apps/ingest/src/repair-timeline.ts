// Repair THE RECORD for programs captured before the timeline logic existed.
//
// The pipeline learned to materialize a genuine timeline on 2026-07-15 (bdfeb31):
// relabel a mid-life capture as an upgrade and seed the real genesis deploy from
// the ProgramData's oldest signature. Anything ingested BEFORE that still shows a
// phantom "DEPLOY" stamped at whatever slot the ProgramData header happened to
// carry when we looked — e.g. Phoenix: Eternal (phDEV…) read "deployed 11d ago"
// when the chain says 18 Nov 2025.
//
// reenrich.ts repairs the *subject* (firstDeployAt, deployType) but never touches
// the *events* table, so no existing job fixes this. This one does, and only this.
//
// Usage — with no ids it sweeps only genuine candidates (a synthetic "deploy"
// row on a program the chain says was upgraded), newest batch first:
//   railway ssh --service on-record-api "node apps/ingest/dist/repair-timeline.js --limit=100"
//   railway ssh --service on-record-api "node apps/ingest/dist/repair-timeline.js <programId> ..."
//   railway ssh --service on-record-api "node apps/ingest/dist/repair-timeline.js --dry-run"
//
// Each candidate costs a paginated getSignaturesForAddress, so keep batches to a
// few hundred and re-run until "candidates" reaches 0 — it's idempotent.
//
// Idempotent: genesis rows are keyed on the real signature and the relabel only
// touches synthetic captures, so re-running converges and then does nothing.

import { and, eq, inArray, isNotNull, like, or, sql } from "drizzle-orm";
import { db, getDeployHistory, logger, schema, type Network } from "@onrecord/core";
import { SYNTHETIC_SIG_PREFIXES, recordGenesisDeploy, relabelPhantomDeploys } from "./timeline.js";

interface Result {
  scanned: number;
  genesisAdded: number;
  relabelled: number;
  skipped: number;
  failed: number;
}

/** Only programs that can actually carry a phantom: they have a synthetic
 *  "deploy" event AND the chain says they've been upgraded. Selecting these in
 *  SQL first is what makes a full sweep finishable — the naive version walked
 *  every subject and spent a paginated getSignaturesForAddress on each, which
 *  runs for hours and dies with the ssh session. */
function candidateFilter() {
  return and(
    eq(schema.events.type, "deploy"),
    or(...SYNTHETIC_SIG_PREFIXES.map((p) => like(schema.events.signature, `${p}%`)))!,
    or(
      eq(schema.subjects.deployType, "upgrade"),
      sql`coalesce((${schema.subjects.facts} ->> 'upgradeCount')::int, 0) > 0`,
    )!,
  );
}

export async function repairTimelines(
  programIds: string[] = [],
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<Result> {
  const subs = programIds.length
    ? await db
        .select({ id: schema.subjects.id, network: schema.subjects.network })
        .from(schema.subjects)
        .where(inArray(schema.subjects.id, programIds))
    : await db
        .selectDistinct({ id: schema.subjects.id, network: schema.subjects.network })
        .from(schema.events)
        .innerJoin(schema.subjects, eq(schema.subjects.id, schema.events.programId))
        .where(candidateFilter())
        .limit(opts.limit ?? 500);

  logger.info({ candidates: subs.length, dryRun: !!opts.dryRun }, "repair-timeline: start");
  const res: Result = { scanned: 0, genesisAdded: 0, relabelled: 0, skipped: 0, failed: 0 };

  for (const s of subs) {
    res.scanned++;
    try {
      const network = s.network as Network;
      // the ProgramData address is carried on the program's events
      const ev = await db
        .select({ pd: schema.events.programDataAddress })
        .from(schema.events)
        .where(
          and(eq(schema.events.programId, s.id), isNotNull(schema.events.programDataAddress)),
        )
        .limit(1);
      const pd = ev[0]?.pd;
      if (!pd) {
        res.skipped++;
        continue;
      }

      const dh = await getDeployHistory(network, pd);
      // txCount <= 1 ⇒ never upgraded ⇒ the capture really is the deploy
      if (dh.txCount <= 1 || dh.firstDeploySlot == null || !dh.firstSignature) {
        res.skipped++;
        continue;
      }

      if (opts.dryRun) {
        logger.info(
          { programId: s.id, genesisSlot: dh.firstDeploySlot, genesisAt: dh.firstDeployAt },
          "repair-timeline: would seed genesis + relabel phantoms",
        );
        continue;
      }

      // order matters: seed genesis first so a failure can't leave a program with
      // its only deploy row relabelled away (which would show no deploy at all)
      if (await recordGenesisDeploy(network, s.id, pd, dh)) res.genesisAdded++;
      res.relabelled += await relabelPhantomDeploys(network, s.id, dh.firstDeploySlot);
    } catch (err) {
      res.failed++;
      logger.warn({ programId: s.id, err: String(err) }, "repair-timeline: failed, skipping");
    }
    // a full sweep is minutes of RPC — say so, so a dropped ssh session is
    // obvious from the log rather than looking like a clean finish
    if (res.scanned % 25 === 0) {
      logger.info({ ...res, of: subs.length }, "repair-timeline: progress");
    }
  }

  logger.info(res, "repair-timeline: done");
  return res;
}

const isMain =
  process.argv[1]?.endsWith("repair-timeline.ts") || process.argv[1]?.endsWith("repair-timeline.js");
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
  const ids = args.filter((a) => !a.startsWith("--"));
  repairTimelines(ids, { dryRun, limit })
    .then((r) => {
      logger.info(r, "repair-timeline complete");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: String(err) }, "repair-timeline failed");
      process.exit(1);
    });
}
