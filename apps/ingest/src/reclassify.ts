import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema, logger, type Fingerprint, type Network } from "@onrecord/core";
import { classifyFingerprint } from "@onrecord/enrich";
import { refreshInterest } from "./interest.js";

// ---------------------------------------------------------------------------
// Reclassify — re-run the dedup gate over existing program subjects. Two jobs:
//
//   1. Retroactively apply classifier fixes (exact-sha re-deploys now fold into
//      a clone bucket) so already-ingested rows don't keep a stale band.
//   2. Refresh the *nearest relative* as the corpus grows. Classification is a
//      one-pass cut at deploy time: program A's nearest is computed against the
//      corpus as it was then. When a close sibling B is deployed later, A's
//      stored `nearest` fact goes stale — it can point at a 10%-similar stranger
//      while an 89%-similar relative now exists. This refresh recomputes band,
//      bucket AND the nearest fact together so the dossier's "nearest known
//      program" is actually the nearest.
//
// Runs as a periodic cron (reclassifyRecent) and as a one-off CLI:
//   INLINE_PIPELINE=1 tsx src/reclassify.ts [--network=mainnet] [--hours=168]
// Oldest-first so the earliest deploy of a bytecode stays canonical.
// ---------------------------------------------------------------------------

export async function reclassifyRecent(network: Network, hours: number): Promise<void> {
  const since = new Date(Date.now() - hours * 3_600_000);
  const subs = await db
    .select({
      id: schema.subjects.id,
      sha256: schema.subjects.sha256,
      tlsh: schema.subjects.tlsh,
      sizeBytes: schema.subjects.sizeBytes,
      deployType: schema.subjects.deployType,
      band: schema.subjects.noveltyBand,
      bucketId: schema.subjects.bucketId,
    })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        gte(schema.subjects.firstSeenAt, since),
      ),
    )
    .orderBy(desc(schema.subjects.firstSeenAt));

  subs.reverse(); // process oldest-first
  logger.info({ subjects: subs.length, network, hours }, "reclassify: start");

  let rebanded = 0;
  let renearested = 0;
  for (const s of subs) {
    // upgrades inherit identity; the gate is a deploy-time cut
    if (s.deployType === "upgrade" || !s.sha256 || s.sizeBytes == null) continue;
    try {
      const fp: Fingerprint = {
        sha256: s.sha256,
        tlsh: s.tlsh,
        sizeBytes: s.sizeBytes,
        idl: null,
        strings: [],
      };
      const cls = await classifyFingerprint(network, s.id, fp);

      const bandChanged = cls.band !== s.band;
      const bucketChanged = cls.bucketId != null && cls.bucketId !== s.bucketId;
      const hasNearest = cls.nearestProgramId != null && cls.nearestDistance != null;
      if (!bandChanged && !bucketChanged && !hasNearest) continue;

      await db
        .update(schema.subjects)
        .set({
          noveltyBand: cls.band,
          ...(cls.bucketId != null ? { bucketId: cls.bucketId } : {}),
          // keep the displayed nearest relative in sync with the current corpus
          ...(hasNearest
            ? {
                facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify(
                  { nearest: { id: cls.nearestProgramId, distance: cls.nearestDistance } },
                )}::jsonb`,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.subjects.id, s.id));

      if (bandChanged) rebanded++;
      if (hasNearest) renearested++;
      await refreshInterest(s.id); // band / nearest moved — re-rank
    } catch (err) {
      logger.warn({ id: s.id, err: String(err) }, "reclassify: subject failed");
    }
  }
  logger.info({ rebanded, renearested, of: subs.length }, "reclassify: complete");
}

// --- CLI entry (skipped when imported by the cron) --------------------------
const isMain = process.argv[1]?.endsWith("reclassify.js") || process.argv[1]?.endsWith("reclassify.ts");
if (isMain) {
  const argv = process.argv.slice(2);
  const netArg = argv.find((a) => a.startsWith("--network="))?.split("=")[1];
  const hoursArg = Number(argv.find((a) => a.startsWith("--hours="))?.split("=")[1]);
  const network: Network = netArg === "devnet" ? "devnet" : "mainnet";
  reclassifyRecent(network, Number.isFinite(hoursArg) && hoursArg > 0 ? hoursArg : 168)
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err: String(err) }, "reclassify: failed");
      process.exit(1);
    });
}
