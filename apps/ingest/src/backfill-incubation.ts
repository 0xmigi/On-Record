import { eq } from "drizzle-orm";
import bs58 from "bs58";
import {
  db,
  schema,
  logger,
  newId,
  getAccountBytes,
  getDeployHistory,
  parseProgramDataAccount,
  findProgramAddress,
} from "@onrecord/core";
import { fingerprintStage, identifyStage, classifyStage, scoreStage } from "./pipeline.js";

// ---------------------------------------------------------------------------
// One-off: program-ID devnet→mainnet lineage backfill.
//
// Serious teams reuse the same program keypair across clusters, so a mainnet
// program's deploy history often has a devnet twin at the SAME address. This
// links them directly (a stronger provenance signal than the fingerprint
// watchlist): for each mainnet program id, if a devnet program exists at the
// same address AND its first deploy predates mainnet's, write an `incubation`
// fact (matchedOn: "program_id"). Ingests the mainnet subject first if it isn't
// tracked yet, so the dossier renders.
//
//   railway ssh "node apps/ingest/dist/backfill-incubation.js <programId> [<programId> ...]"
//
// Idempotent: re-running refreshes the incubation fact; existing subjects are
// not re-ingested.
// ---------------------------------------------------------------------------

process.env.INLINE_PIPELINE = "1"; // stages run in sequence, no Redis

const LOADER = bs58.decode("BPFLoaderUpgradeab1e11111111111111111111111");
const programDataOf = (programId: string): string =>
  bs58.encode(findProgramAddress([bs58.decode(programId)], LOADER));

/** Ingest the mainnet subject through the normal pipeline if it isn't tracked. */
async function ensureSubject(programId: string, pd: string): Promise<void> {
  const existing = await db
    .select({ id: schema.subjects.id })
    .from(schema.subjects)
    .where(eq(schema.subjects.id, programId));
  if (existing[0]) {
    logger.info({ programId }, "incubation-backfill: subject already tracked");
    return;
  }

  const raw = await getAccountBytes("mainnet", pd);
  const parsed = raw ? parseProgramDataAccount(raw) : null;
  if (!parsed) throw new Error("no ProgramData account on mainnet — not an upgradeable program");
  const dh = await getDeployHistory("mainnet", pd);

  const eventId = newId("evt");
  const inserted = await db
    .insert(schema.events)
    .values({
      id: eventId,
      network: "mainnet",
      type: "deploy",
      signature: `incubation-backfill:${pd}`,
      instructionIndex: 0,
      slot: dh.firstDeploySlot ?? dh.lastDeploySlot ?? 0,
      blockTime: dh.firstDeployAt ?? new Date(),
      programId,
      programDataAddress: pd,
      authorityBefore: null,
      authorityAfter: parsed.upgradeAuthority ?? null,
    })
    .onConflictDoNothing({ target: [schema.events.signature, schema.events.instructionIndex] })
    .returning({ id: schema.events.id });
  const evId = inserted[0]?.id;
  if (!evId) {
    logger.info({ programId }, "incubation-backfill: deploy event already present");
    return;
  }

  await fingerprintStage(evId);
  await identifyStage(evId);
  await classifyStage(evId);
  await scoreStage(evId);
  logger.info({ programId }, "incubation-backfill: ingested mainnet subject");
}

/** Compute + persist the incubation fact if the program is genuinely devnet-first. */
async function writeIncubation(programId: string, pd: string): Promise<boolean> {
  const onDevnet = await getAccountBytes("devnet", programId);
  if (!onDevnet) {
    logger.warn({ programId }, "no devnet program at the same address — no lineage");
    return false;
  }
  const [dev, main] = await Promise.all([
    getDeployHistory("devnet", pd),
    getDeployHistory("mainnet", pd),
  ]);
  if (!dev.firstDeployAt || !main.firstDeployAt) {
    logger.warn({ programId }, "incomplete deploy history on one cluster");
    return false;
  }
  if (dev.firstDeployAt >= main.firstDeployAt) {
    logger.warn(
      { programId, devnet: dev.firstDeployAt, mainnet: main.firstDeployAt },
      "not devnet-first — skipping (mainnet came first or same time)",
    );
    return false;
  }

  const incubationDays =
    Math.round(((main.firstDeployAt.getTime() - dev.firstDeployAt.getTime()) / 86_400_000) * 10) / 10;
  const incubation = {
    devnetProgramId: programId, // same address on both clusters
    firstDevnetAt: dev.firstDeployAt.toISOString(),
    incubationDays,
    devnetIterations: dev.txCount, // ProgramData writes: deploy + upgrades
    matchedOn: "program_id" as const,
  };

  const rows = await db
    .select({ facts: schema.subjects.facts })
    .from(schema.subjects)
    .where(eq(schema.subjects.id, programId));
  const facts = (rows[0]?.facts ?? {}) as Record<string, unknown>;
  await db
    .update(schema.subjects)
    .set({ facts: { ...facts, incubation }, updatedAt: new Date() })
    .where(eq(schema.subjects.id, programId));
  logger.info({ programId, incubation }, "incubation-backfill: wrote incubation fact");
  return true;
}

async function run(): Promise<void> {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!ids.length) throw new Error("usage: backfill-incubation.js <programId> [<programId> ...]");
  let linked = 0;
  for (const programId of ids) {
    const pd = programDataOf(programId);
    logger.info({ programId, programData: pd }, "incubation-backfill: start");
    try {
      await ensureSubject(programId, pd);
      if (await writeIncubation(programId, pd)) linked++;
    } catch (err) {
      logger.error({ programId, err: String(err) }, "incubation-backfill: failed");
    }
  }
  logger.info({ of: ids.length, linked }, "incubation-backfill: complete");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "incubation-backfill: fatal");
    process.exit(1);
  });
