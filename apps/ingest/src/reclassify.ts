import { and, desc, eq, gte } from "drizzle-orm";
import { db, schema, logger, type Fingerprint, type Network } from "@onrecord/core";
import { classifyFingerprint } from "@onrecord/enrich";

// ---------------------------------------------------------------------------
// One-off reclassify: re-run the dedup gate over existing program subjects so
// the fixed classifier (exact-sha re-deploys now fold into a clone bucket)
// applies retroactively — otherwise already-ingested byte-clones keep their
// stale `novel` band until they age out of the radar window.
//
//   INLINE_PIPELINE=1 tsx src/reclassify.ts [--network=mainnet] [--hours=168]
//
// Oldest-first so the earliest deploy of a given bytecode stays canonical and
// later copies fold under it.
// ---------------------------------------------------------------------------

async function run(network: Network, hours: number): Promise<void> {
  const since = new Date(Date.now() - hours * 3_600_000);
  const subs = await db
    .select({
      id: schema.subjects.id,
      sha256: schema.subjects.sha256,
      tlsh: schema.subjects.tlsh,
      sizeBytes: schema.subjects.sizeBytes,
      deployType: schema.subjects.deployType,
      band: schema.subjects.noveltyBand,
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

  // process oldest-first
  subs.reverse();
  logger.info({ subjects: subs.length, network, hours }, "reclassify: start");

  let changed = 0;
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
      if (cls.band !== s.band || cls.bucketId) {
        await db
          .update(schema.subjects)
          .set({ noveltyBand: cls.band, bucketId: cls.bucketId, updatedAt: new Date() })
          .where(eq(schema.subjects.id, s.id));
        if (cls.band !== s.band) changed++;
      }
    } catch (err) {
      logger.warn({ id: s.id, err: String(err) }, "reclassify: subject failed");
    }
  }
  logger.info({ changed, of: subs.length }, "reclassify: complete");
}

const argv = process.argv.slice(2);
const netArg = argv.find((a) => a.startsWith("--network="))?.split("=")[1];
const hoursArg = Number(argv.find((a) => a.startsWith("--hours="))?.split("=")[1]);
const network: Network = netArg === "devnet" ? "devnet" : "mainnet";
run(network, Number.isFinite(hoursArg) && hoursArg > 0 ? hoursArg : 168)
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "reclassify: failed");
    process.exit(1);
  });
