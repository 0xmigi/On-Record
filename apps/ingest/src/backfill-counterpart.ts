import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema, logger, rpc, type Network } from "@onrecord/core";
import { otherNetwork, recordCounterpart } from "./counterpart.js";

// ---------------------------------------------------------------------------
// Backfill cross-cluster presence over the existing corpus, and promote the
// devnet rows that turn out to be mainnet programs.
//
//   railway ssh "node apps/ingest/dist/backfill-counterpart.js [--force] [--limit N] [--no-promote]"
//
// Two passes, because the full probe is 2-5 RPC calls and most programs are on
// one cluster only:
//
//   1. SIEVE — getMultipleAccounts, 100 addresses per call, against the other
//      cluster. Answers "is anything executable at this address there" for the
//      whole corpus in ~120 round-trips. Everything that comes back empty is
//      written as a settled `present: false` and never probed again.
//   2. PROBE — the full per-program read (ProgramData header, authority class,
//      Squads escalation) for the ~1,042 addresses the sieve found. A devnet
//      row found live on mainnet is re-ingested from mainnet here, so the row
//      moves to the mainnet radar carrying mainnet figures, with its devnet
//      life recorded as incubation history.
//
// Without the sieve this would be ~35,000 calls to learn that 91% of the corpus
// lives on one cluster. With it, ~1,200.
//
// Idempotent. Re-running refreshes; --force re-probes rows that already have a
// counterpart fact (presence is a fact with a timestamp, and it goes stale —
// a devnet program ships to mainnet and the old `present: false` is then wrong).
// --no-promote probes and records without moving anything, for a dry look.
// ---------------------------------------------------------------------------

process.env.INLINE_PIPELINE = "1"; // promotion runs the stages in sequence, no Redis

const force = process.argv.includes("--force");
const promote = !process.argv.includes("--no-promote");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : null;

const SIEVE_CHUNK = 100;

/** Which addresses in this batch have an executable account on `network`. */
async function sieve(network: Network, ids: string[]): Promise<Set<string>> {
  const hits = new Set<string>();
  for (let i = 0; i < ids.length; i += SIEVE_CHUNK) {
    const batch = ids.slice(i, i + SIEVE_CHUNK);
    const res = await rpc<{ value: ({ executable: boolean } | null)[] }>(
      network,
      "getMultipleAccounts",
      [batch, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }],
    );
    res.value.forEach((acc, k) => {
      if (acc?.executable) hits.add(batch[k]!);
    });
    logger.info(
      { network, done: Math.min(i + SIEVE_CHUNK, ids.length), total: ids.length, hits: hits.size },
      "counterpart-backfill: sieving",
    );
  }
  return hits;
}

/** Settle the misses in one statement per batch — probed, nothing there. */
async function markAbsent(ids: string[], other: Network): Promise<void> {
  if (!ids.length) return;
  const fact = JSON.stringify({
    network: other,
    present: false,
    alive: null,
    sizeBytes: null,
    deployedSlot: null,
    deployedAt: null,
    authority: null,
    authorityClass: null,
    checkedAt: new Date().toISOString(),
  });
  await db
    .update(schema.subjects)
    .set({
      facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || jsonb_build_object('counterpart', ${fact}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(sql`${schema.subjects.id} in ${ids}`);
}

async function run(): Promise<void> {
  for (const home of ["devnet", "mainnet"] as Network[]) {
    const other = otherNetwork(home);
    const rows = await db
      .select({ id: schema.subjects.id })
      .from(schema.subjects)
      .where(
        force
          ? and(eq(schema.subjects.kind, "program"), eq(schema.subjects.network, home))
          : and(
              eq(schema.subjects.kind, "program"),
              eq(schema.subjects.network, home),
              isNull(sql`${schema.subjects.facts} -> 'counterpart'`),
            ),
      )
      .limit(limit ?? 100_000);

    if (!rows.length) {
      logger.info({ home }, "counterpart-backfill: nothing to do");
      continue;
    }
    const ids = rows.map((r) => r.id);
    logger.info({ home, other, count: ids.length }, "counterpart-backfill: start");

    const present = await sieve(other, ids);
    const absent = ids.filter((id) => !present.has(id));

    for (let i = 0; i < absent.length; i += 500) await markAbsent(absent.slice(i, i + 500), other);
    logger.info({ home, absent: absent.length }, "counterpart-backfill: settled absences");

    let done = 0;
    let promoted = 0;
    for (const id of present) {
      const before = home;
      await recordCounterpart(home, id, { promote });
      if (promote && before === "devnet") {
        const after = await db
          .select({ network: schema.subjects.network })
          .from(schema.subjects)
          .where(eq(schema.subjects.id, id));
        if (after[0]?.network === "mainnet") promoted++;
      }
      if (++done % 25 === 0) {
        logger.info({ home, done, total: present.size, promoted }, "counterpart-backfill: probing");
      }
    }
    logger.info(
      { home, other, present: present.size, absent: absent.length, promoted },
      "counterpart-backfill: done",
    );
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "counterpart-backfill: failed");
    process.exit(1);
  });
