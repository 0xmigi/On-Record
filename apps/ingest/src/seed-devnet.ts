import { and, eq, sql } from "drizzle-orm";
import {
  db,
  schema,
  logger,
  newId,
  getConfig,
  getSlot,
  getBlockTime,
  enumerateProgramAccounts,
  enumerateProgramData,
  getAccountBytes,
  parseProgramDataAccount,
  sha256Hex,
  tlshHash,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// One-off devnet watchlist seed (ROADMAP §1): backfill recent devnet lineages
// so the devnet→mainnet conversion stat produces matches from day one instead
// of waiting out an incubation cycle. Watchlist rows only — no events, no
// subjects; the live devnet poller owns the ongoing record.
//
//   railway ssh "node apps/ingest/dist/seed-devnet.js --days=30 --max=8000"
//
// Idempotent: an active row with the same sha256 is bumped, not duplicated.
// Cost: ~1 credit per program fetched (census: 30d cohort ≈ 6.2k → ~7k credits).
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const num = (k: string, dflt: number) => {
  const raw = argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  return raw ? Number(raw) : dflt;
};
const DAYS = num("days", 30);
const MAX = num("max", 8_000);

async function run(): Promise<void> {
  const cfg = await getConfig();
  const ttlMs = cfg.WATCHLIST_TTL_DAYS * 24 * 3_600_000;

  // slot clock: measure devnet's actual slot duration over ~9 days
  const current = await getSlot("devnet");
  const span = 2_000_000;
  const [tNow, tPast] = await Promise.all([
    getBlockTime("devnet", current - 100),
    getBlockTime("devnet", current - span),
  ]);
  const slotSecs = tNow && tPast ? (tNow - tPast) / (span - 100) : 0.4;
  const cutoff = current - Math.round((DAYS * 86_400) / slotSecs);

  logger.info({ current, slotSecs, cutoff, days: DAYS }, "seed-devnet: enumerating");
  const [headers, refs] = await Promise.all([
    enumerateProgramData("devnet"),
    enumerateProgramAccounts("devnet"),
  ]);
  const idByProgramData = new Map(refs.map((r) => [r.programDataAddress, r.programId]));

  const cohort = headers
    .filter((h) => h.deployedSlot >= cutoff)
    .sort((a, b) => b.deployedSlot - a.deployedSlot)
    .slice(0, MAX);
  logger.info(
    { total: headers.length, cohort: cohort.length, capped: cohort.length === MAX },
    "seed-devnet: start",
  );

  let added = 0;
  let bumped = 0;
  let gone = 0;
  let failed = 0;
  let done = 0;
  const seenThisRun = new Set<string>();

  for (const h of cohort) {
    try {
      const raw = await getAccountBytes("devnet", h.programDataAddress);
      const parsed = raw ? parseProgramDataAccount(raw) : null;
      if (!parsed) {
        gone++; // closed since enumeration, or not ProgramData anymore
        continue;
      }
      const sha256 = sha256Hex(parsed.bytecode);
      if (seenThisRun.has(sha256)) {
        bumped++;
        continue;
      }
      seenThisRun.add(sha256);

      const existing = await db
        .select({ id: schema.watchlist.id })
        .from(schema.watchlist)
        .where(and(eq(schema.watchlist.status, "active"), eq(schema.watchlist.sha256, sha256)));
      if (existing[0]) {
        await db
          .update(schema.watchlist)
          .set({
            deployCount: sql`${schema.watchlist.deployCount} + 1`,
            lastSeenAt: new Date(),
            expiresAt: new Date(Date.now() + ttlMs),
          })
          .where(eq(schema.watchlist.id, existing[0].id));
        bumped++;
        continue;
      }

      await db.insert(schema.watchlist).values({
        id: newId("wl"),
        kind: "fingerprint",
        sha256,
        tlsh: await tlshHash(parsed.bytecode),
        sizeBytes: parsed.bytecode.length,
        authority: parsed.upgradeAuthority ?? h.upgradeAuthority,
        programId: idByProgramData.get(h.programDataAddress) ?? null,
        source: "devnet_seed",
        expiresAt: new Date(Date.now() + ttlMs),
      });
      added++;
    } catch (err) {
      failed++;
      logger.warn({ programData: h.programDataAddress, err: String(err) }, "seed-devnet: item failed");
    }
    if (++done % 250 === 0)
      logger.info({ done, of: cohort.length, added, bumped, gone, failed }, "seed-devnet: progress");
  }

  logger.info({ done, added, bumped, gone, failed, of: cohort.length }, "seed-devnet: complete");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "seed-devnet: failed");
    process.exit(1);
  });
