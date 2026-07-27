import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema, logger, type Network } from "@onrecord/core";
import { refreshInterest } from "./interest.js";

// ---------------------------------------------------------------------------
// Rescore — recompute interest across existing rows. The score is a pure
// function of stored facts, so whenever the scorer changes the corpus is stale
// until it is walked: rows keep whatever number they were given at ingest.
//
// Written for the source-family discount (interest.ts sourceFamilySize), which
// only bites retroactively — every program already on record was scored against
// its copy bucket alone.
//
//   INLINE_PIPELINE=1 tsx src/rescore.ts [--network=mainnet] [--limit=N] [--offset=N] [--dry] [--all]
//
// Oldest-first and one row at a time: this is a background repair, not a race,
// and each refreshInterest is two indexed reads plus one write.
// ---------------------------------------------------------------------------

export async function rescoreAll(
  network: Network,
  opts: { limit?: number; offset?: number; dry?: boolean; all?: boolean } = {},
): Promise<{ scanned: number; moved: number }> {
  const rows = await db
    .select({ id: schema.subjects.id, score: schema.subjects.noveltyScore })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        isNotNull(schema.subjects.sha256),
        // only these can move: the source family is what changed, and a row
        // with no recovered crate still scores off its bucket alone, exactly as
        // before. --all walks everything when the scorer changes elsewhere.
        opts.all ? undefined : isNotNull(schema.subjects.crate),
      ),
    )
    .orderBy(schema.subjects.firstSeenAt, schema.subjects.id)
    .limit(opts.limit ?? 100_000)
    .offset(opts.offset ?? 0);

  let moved = 0;
  const biggestDrops: { id: string; from: number; to: number; family: number }[] = [];
  for (const r of rows) {
    try {
      const before = r.score ?? 0;
      // --dry still computes; refreshInterest is the only place family size is
      // derived, so a preview that skipped it would be measuring the old rule
      const interest = await refreshInterest(r.id, { persist: !opts.dry });
      if (!interest) continue;
      const delta = interest.score - before;
      if (Math.abs(delta) >= 0.0005) {
        moved++;
        if (delta < 0) {
          biggestDrops.push({ id: r.id, from: before, to: interest.score, family: interest.familySize });
        }
      }
    } catch (err) {
      logger.warn({ id: r.id, err: String(err) }, "rescore: subject failed");
    }
  }

  biggestDrops.sort((a, b) => a.to - a.from - (b.to - b.from));
  logger.info(
    { network, scanned: rows.length, moved, dry: !!opts.dry, top: biggestDrops.slice(0, 10) },
    "rescore: complete",
  );
  return { scanned: rows.length, moved };
}

// --- CLI entry --------------------------------------------------------------
const isMain = process.argv[1]?.endsWith("rescore.js") || process.argv[1]?.endsWith("rescore.ts");
if (isMain) {
  const argv = process.argv.slice(2);
  const netArg = argv.find((a) => a.startsWith("--network="))?.split("=")[1];
  const limitArg = Number(argv.find((a) => a.startsWith("--limit="))?.split("=")[1]);
  const offsetArg = Number(argv.find((a) => a.startsWith("--offset="))?.split("=")[1]);
  const network: Network = netArg === "devnet" ? "devnet" : "mainnet";
  rescoreAll(network, {
    limit: Number.isFinite(limitArg) && limitArg > 0 ? limitArg : undefined,
    offset: Number.isFinite(offsetArg) && offsetArg > 0 ? offsetArg : undefined,
    dry: argv.includes("--dry"),
    all: argv.includes("--all"),
  })
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err: String(err) }, "rescore: failed");
      process.exit(1);
    });
}
