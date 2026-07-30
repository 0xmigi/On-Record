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
import { linkIncubation } from "./incubation.js";
import { fingerprintStage, identifyStage, classifyStage, scoreStage } from "./pipeline.js";

// ---------------------------------------------------------------------------
// Program-ID devnet→mainnet lineage, for named programs.
//
// The linking itself lives in incubation.ts and now runs inline on every mainnet
// event, so this script is no longer how the fact gets written — it is the
// repair tool for programs whose mainnet events all predate that change, and the
// way to link a program the radar never ingested at all (it runs the pipeline
// for the subject first, so the dossier renders).
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

async function run(): Promise<void> {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!ids.length) throw new Error("usage: backfill-incubation.js <programId> [<programId> ...]");
  let linked = 0;
  for (const programId of ids) {
    const pd = programDataOf(programId);
    logger.info({ programId, programData: pd }, "incubation-backfill: start");
    try {
      await ensureSubject(programId, pd);
      // the mainnet debut is the anchor the devnet history has to precede — read
      // it from the chain rather than the subject row, which may hold a later
      // sighting if the program was first seen mid-life
      const main = await getDeployHistory("mainnet", pd);
      const fact = await linkIncubation(programId, main.firstDeployAt, { probeChain: true });
      if (fact) linked++;
      else logger.warn({ programId }, "no devnet-first twin at this address — no lineage");
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
