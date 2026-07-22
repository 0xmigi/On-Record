// Seed the canonical programs that loader-event ingestion alone will never
// reach, so name search can find them.
//
// Two distinct holes this closes, both discovered by searching "metaplex" and
// getting only its callers back:
//
//   1. NO ROW  — a program that has not deployed or upgraded inside our window
//      has no subject at all (Metaplex Token Metadata, OpenBook v2, the
//      canonical Token-2022). Nothing to find.
//   2. NO NAME — a program that IS indexed but leaks no name: immutable, no
//      security.txt, no `programs/<name>/src/` panic path. SPL Token was the
//      worst case, the single most-invoked program on Solana sitting in the
//      index with name = null.
//
// A registry name outranks every other naming source (pipeline.ts), so listing
// an id in labels.yaml is the fix for both — this script is what applies it to
// rows that already exist and pulls in the ones that don't.
//
//   ./node_modules/.bin/tsx src/seed-landmarks.ts [--dry] [--network=mainnet]
//
// Idempotent: named rows are left alone, existing subjects are never
// re-ingested. Costs ~1 RPC read per landmark plus a bytecode fetch for each
// program that is genuinely new.
import { eq, isNull, sql } from "drizzle-orm";
import {
  db,
  schema,
  logger,
  getAccountBytes,
  getBlockTime,
  getProgramDataAddress,
  parseProgramDataAccount,
  type Network,
} from "@onrecord/core";
import { seedFromLabels } from "@onrecord/enrich";
import { requireDatabaseTarget, requireRpcKey } from "./db-target.js";
import { recordDeploy } from "./backfill.js";
import { fingerprintStage, identifyStage, classifyStage, scoreStage } from "./pipeline.js";

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const network: Network = argv.includes("--network=devnet") ? "devnet" : "mainnet";

process.env.INLINE_PIPELINE = "1"; // stages run in sequence, no Redis

const target = requireDatabaseTarget("seed-landmarks.ts");
requireRpcKey("seed-landmarks.ts");
logger.info({ target, network, dry }, "target database");

const seeded = await seedFromLabels();
logger.info({ entities: seeded, network, dry }, "seed-landmarks: registry seeded");

// every curated program id, with the entity name that should win
const entities = await db
  .select({ name: schema.entities.name, programIds: schema.entities.programIds })
  .from(schema.entities)
  .where(eq(schema.entities.source, "labels"));

const targets = entities.flatMap((e) => e.programIds.map((id) => ({ id, name: e.name })));
logger.info({ targets: targets.length }, "seed-landmarks: curated program ids");

let named = 0;
let ingested = 0;
let alreadyFine = 0;
let notUpgradeable = 0;
let failed = 0;

for (const t of targets) {
  const rows = await db
    .select({ id: schema.subjects.id, name: schema.subjects.name })
    .from(schema.subjects)
    .where(eq(schema.subjects.id, t.id));
  const existing = rows[0];

  // --- hole 2: indexed but nameless ---------------------------------------
  if (existing) {
    if (existing.name) {
      alreadyFine++;
      continue;
    }
    logger.info({ programId: t.id, name: t.name }, "naming an indexed-but-nameless program");
    if (!dry) {
      await db
        .update(schema.subjects)
        .set({
          name: t.name,
          // keep it searchable too — the corpus was built from a binary that
          // never mentions this name
          searchText: sql`lower(${t.name}) || E'\n' || coalesce(${schema.subjects.searchText}, '')`,
          updatedAt: new Date(),
        })
        .where(eq(schema.subjects.id, t.id));
    }
    named++;
    continue;
  }

  // --- hole 1: no row at all ----------------------------------------------
  try {
    const pd = await getProgramDataAddress(network, t.id);
    if (!pd) {
      // loader-v2 / native programs have no ProgramData account — there is no
      // deploy record to synthesize, so they stay out of the index by design
      logger.warn({ programId: t.id, name: t.name }, "not an upgradeable-loader program — skipping");
      notUpgradeable++;
      continue;
    }
    const raw = await getAccountBytes(network, pd);
    const parsed = raw ? parseProgramDataAccount(raw) : null;
    if (!parsed) {
      logger.warn({ programId: t.id, name: t.name }, "ProgramData unreadable — skipping");
      failed++;
      continue;
    }
    logger.info(
      { programId: t.id, name: t.name, slot: parsed.deployedSlot },
      "ingesting a program with no loader event in window",
    );
    if (dry) {
      ingested++;
      continue;
    }
    const seconds = await getBlockTime(network, parsed.deployedSlot);
    const blockTime = seconds ? new Date(seconds * 1000) : new Date();
    const eventId = await recordDeploy(
      network,
      t.id,
      {
        programDataAddress: pd,
        deployedSlot: parsed.deployedSlot,
        upgradeAuthority: parsed.upgradeAuthority,
      },
      blockTime,
    );
    if (!eventId) {
      alreadyFine++;
      continue;
    }
    await fingerprintStage(eventId);
    await identifyStage(eventId);
    await classifyStage(eventId);
    await scoreStage(eventId);
    ingested++;
  } catch (err) {
    // A 401/403 is not "this program is unusual", it is "the whole run has no
    // credentials" — every remaining landmark would fail the same way and the
    // summary would read as 30 harmless skips. Stop instead.
    const msg = String(err);
    if (/HTTP 40[13]/.test(msg)) {
      logger.error({ err: msg }, "RPC rejected our credentials — aborting rather than skipping 30 programs");
      process.exit(1);
    }
    logger.warn({ programId: t.id, name: t.name, err: msg }, "landmark failed, skipping");
    failed++;
  }
}

// a landmark ingested above got its name from the registry during identify —
// but anything still nameless with a curated id would have been caught by the
// naming branch on a second pass, so report the residue explicitly
const stillNameless = await db
  .select({ n: sql<number>`count(*)` })
  .from(schema.subjects)
  .where(isNull(schema.subjects.name));

logger.info(
  {
    named,
    ingested,
    alreadyFine,
    notUpgradeable,
    failed,
    namelessSubjectsRemaining: Number(stillNameless[0]?.n ?? 0),
    dry,
  },
  "seed-landmarks: done",
);
process.exit(0);
