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
// Usage (all mainnet programs, or an explicit list):
//   railway ssh "node apps/ingest/dist/repair-timeline.js"
//   railway ssh "node apps/ingest/dist/repair-timeline.js <programId> [<programId> ...]"
//   railway ssh "node apps/ingest/dist/repair-timeline.js --dry-run"
//
// Idempotent: genesis rows are keyed on the real signature and the relabel only
// touches synthetic captures, so re-running converges and then does nothing.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, getDeployHistory, logger, schema, type Network } from "@onrecord/core";
import { recordGenesisDeploy, relabelPhantomDeploys } from "./timeline.js";

interface Result {
  scanned: number;
  genesisAdded: number;
  relabelled: number;
  skipped: number;
  failed: number;
}

export async function repairTimelines(
  programIds: string[] = [],
  opts: { dryRun?: boolean } = {},
): Promise<Result> {
  const subs = await db
    .select({ id: schema.subjects.id, network: schema.subjects.network })
    .from(schema.subjects)
    .where(
      programIds.length
        ? inArray(schema.subjects.id, programIds)
        : eq(schema.subjects.kind, "program"),
    );

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
  }

  logger.info(res, "repair-timeline: done");
  return res;
}

const isMain =
  process.argv[1]?.endsWith("repair-timeline.ts") || process.argv[1]?.endsWith("repair-timeline.js");
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const ids = args.filter((a) => !a.startsWith("--"));
  repairTimelines(ids, { dryRun })
    .then((r) => {
      logger.info(r, "repair-timeline complete");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: String(err) }, "repair-timeline failed");
      process.exit(1);
    });
}
