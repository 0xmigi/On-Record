import { and, desc, eq, gte, lte } from "drizzle-orm";
import { db, schema, tlshDistance, logger } from "@onrecord/core";

// ---------------------------------------------------------------------------
// Read-only diagnostic: is a program's "nearest match" a genuine standout or
// one of a crowd of framework-boilerplate lookalikes? For each program id,
// replicate the classify-stage scan (corpus, same network, ±20% size) and
// report the distance distribution: nearest, runner-up, gap, and how many
// distinct programs sit within 5 percentage points of the nearest.
//
//   railway ssh "node apps/ingest/dist/nearest-crowd.js <programId> ..."
// ---------------------------------------------------------------------------

const simOf = (d: number): number => Math.max(0, Math.min(1, 1 - d / 300));
const pct = (s: number): number => Math.round(s * 100);

async function analyze(programId: string): Promise<void> {
  // this program's fingerprint (latest corpus row)
  const self = await db
    .select({ tlsh: schema.fingerprintCorpus.tlsh, sizeBytes: schema.fingerprintCorpus.sizeBytes })
    .from(schema.fingerprintCorpus)
    .where(
      and(
        eq(schema.fingerprintCorpus.network, "mainnet"),
        eq(schema.fingerprintCorpus.programId, programId),
      ),
    )
    .orderBy(desc(schema.fingerprintCorpus.seenAt))
    .limit(1);
  if (!self[0]?.tlsh) {
    logger.info({ programId }, "nearest-crowd: no tlsh in corpus");
    return;
  }
  const { tlsh, sizeBytes } = self[0];
  const lo = Math.floor(sizeBytes * 0.8);
  const hi = Math.ceil(sizeBytes * 1.2);

  const candidates = await db
    .select({
      programId: schema.fingerprintCorpus.programId,
      tlsh: schema.fingerprintCorpus.tlsh,
    })
    .from(schema.fingerprintCorpus)
    .where(
      and(
        eq(schema.fingerprintCorpus.network, "mainnet"),
        gte(schema.fingerprintCorpus.sizeBytes, lo),
        lte(schema.fingerprintCorpus.sizeBytes, hi),
      ),
    );

  // min distance per distinct program (corpus is append-only → many rows/program)
  const minByProgram = new Map<string, number>();
  for (const c of candidates) {
    if (!c.tlsh || c.programId === programId) continue;
    const d = tlshDistance(tlsh, c.tlsh);
    if (d === null) continue;
    const prev = minByProgram.get(c.programId);
    if (prev === undefined || d < prev) minByProgram.set(c.programId, d);
  }

  const ranked = [...minByProgram.entries()].map(([id, d]) => ({ id, d, sim: simOf(d) })).sort((a, b) => a.d - b.d);
  const nearest = ranked[0];
  const runner = ranked[1];
  const within5 = nearest ? ranked.filter((r) => r.sim >= nearest.sim - 0.05).length : 0;
  const within85 = ranked.filter((r) => r.sim >= 0.85).length;

  logger.info(
    {
      programId,
      distinctCandidates: ranked.length,
      sizeBand: `${lo}-${hi}B`,
      nearest: nearest ? { id: nearest.id, sim: pct(nearest.sim) } : null,
      runnerUp: runner ? { sim: pct(runner.sim) } : null,
      gapPts: nearest && runner ? pct(nearest.sim) - pct(runner.sim) : null,
      within5ptsOfNearest: within5,
      within85pct: within85,
      verdict: nearest
        ? within5 <= 2
          ? "STANDOUT"
          : within5 >= 6
            ? "CROWD (generic framework shape)"
            : "moderate"
        : "no candidates",
    },
    "nearest-crowd",
  );
}

async function run(): Promise<void> {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!ids.length) throw new Error("usage: nearest-crowd.js <programId> ...");
  for (const id of ids) await analyze(id);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "nearest-crowd: fatal");
    process.exit(1);
  });
