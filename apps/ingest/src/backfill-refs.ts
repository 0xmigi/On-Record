process.env.INLINE_PIPELINE = "1"; // no Redis; this is a one-off walk

import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import {
  db,
  getAccountBytes,
  getProgramDataAddress,
  logger,
  schema,
  sha256Hex,
  type Network,
} from "@onrecord/core";
import { corpusIndex, extractReferences } from "./refs.js";

// ---------------------------------------------------------------------------
// Backfill references — for programs already on record, whose bytecode the
// pipeline no longer has in hand.
//
// New deploys and upgrades get their edges free inside the fingerprint stage.
// Everything deployed before that wiring needs its image fetched again, and
// THAT is the only expensive part of this feature: there is no bytecode cache,
// so each program costs two getAccountInfo calls (program account → its
// ProgramData address, then the image itself).
//
// So this does not walk the corpus. It walks OUT from a seed, breadth-first:
// fetch the seed set, read the programs they name, fetch those, repeat. The
// graph closes on itself quickly — an entity's programs mostly name each other
// and a handful of shared dependencies — so a seed of 8 reaches its whole
// neighbourhood for a fraction of what a full sweep would cost.
//
//   node dist/backfill-refs.js --seed=kamino --hops=1 --max=120
//   node dist/backfill-refs.js --seed=<programId>,<programId> --hops=2
//   node dist/backfill-refs.js --seed=kamino --dry-run     (fetch nothing)
//
// --max is a hard ceiling on IMAGES FETCHED, not programs discovered: the walk
// stops there and says what it skipped, rather than quietly spending an
// unbounded amount of somebody's RPC budget.
// ---------------------------------------------------------------------------

interface Options {
  network: Network;
  seed: string;
  hops: number;
  max: number;
  dryRun: boolean;
}

async function resolveSeed(network: Network, seed: string): Promise<string[]> {
  const parts = seed.split(",").map((s) => s.trim()).filter(Boolean);
  const looksLikeId = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
  if (parts.every(looksLikeId)) return parts;
  const rows = await db
    .select({ id: schema.subjects.id })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        ilike(schema.subjects.name, `%${seed}%`),
      ),
    );
  return rows.map((r) => r.id);
}

export async function backfillRefs(opts: Options): Promise<void> {
  const { network, hops, max, dryRun } = opts;
  const seeds = await resolveSeed(network, opts.seed);
  if (!seeds.length) {
    logger.warn({ seed: opts.seed }, "backfill-refs: seed matched nothing");
    return;
  }

  // Only programs on record can be walked to — an id named by a binary might
  // belong to something never ingested (a closed program, another cluster), and
  // there is nothing to fetch or attribute for those.
  const index = await corpusIndex(network, true);
  const known = new Set(
    (
      await db
        .select({ id: schema.subjects.id })
        .from(schema.subjects)
        .where(and(eq(schema.subjects.network, network), eq(schema.subjects.kind, "program")))
    ).map((r) => r.id),
  );

  logger.info(
    { seeds: seeds.length, hops, max, dryRun, corpus: index.size },
    "backfill-refs: start",
  );

  const done = new Set<string>();
  let frontier = seeds.filter((id) => known.has(id));
  let fetched = 0;
  let edges = 0;
  let skipped = 0;

  for (let hop = 0; hop <= hops; hop++) {
    const next = new Set<string>();
    for (const programId of frontier) {
      if (done.has(programId)) continue;
      done.add(programId);
      if (fetched >= max) {
        skipped++;
        continue;
      }
      if (dryRun) {
        fetched++;
        continue;
      }
      try {
        const pda = await getProgramDataAddress(network, programId);
        const raw = pda ? await getAccountBytes(network, pda) : null;
        fetched++;
        if (!raw) continue;
        // strip the 45-byte ProgramData header and trailing zero padding
        let end = raw.length;
        while (end > 45 && raw[end - 1] === 0) end--;
        const body = raw.subarray(45, end);
        const refs = await extractReferences(network, programId, body, sha256Hex(body));
        edges += refs.length;
        for (const r of refs) if (known.has(r) && !done.has(r)) next.add(r);
      } catch (err) {
        logger.warn({ programId, err: String(err) }, "backfill-refs: program failed");
      }
    }
    if (!next.size) break;
    frontier = [...next];
    logger.info({ hop: hop + 1, frontier: frontier.length, fetched, edges }, "backfill-refs: hop");
  }

  if (skipped) {
    logger.warn({ skipped, max }, "backfill-refs: hit --max, some programs left unfetched");
  }
  logger.info(
    { programs: done.size, fetched, edges, rpcCalls: fetched * 2, skipped },
    "backfill-refs: complete",
  );
}

// --- CLI --------------------------------------------------------------------
const isMain =
  process.argv[1]?.endsWith("backfill-refs.js") || process.argv[1]?.endsWith("backfill-refs.ts");
if (isMain) {
  const argv = process.argv.slice(2);
  const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const netArg = arg("network");
  backfillRefs({
    network: netArg === "devnet" ? "devnet" : "mainnet",
    seed: arg("seed") ?? "kamino",
    hops: Number(arg("hops") ?? 1),
    max: Number(arg("max") ?? 100),
    dryRun: argv.includes("--dry-run"),
  })
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err: String(err) }, "backfill-refs: failed");
      process.exit(1);
    });
}
