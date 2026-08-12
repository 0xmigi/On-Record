import { and, eq, like } from "drizzle-orm";
import bs58 from "bs58";
import {
  db,
  schema,
  logger,
  findProgramAddress,
  getAccountBytes,
  parseProgramDataAccount,
  LOADER_PROGRAM_ID,
} from "@onrecord/core";
import { ingestDeployHistory } from "./timeline.js";

// ---------------------------------------------------------------------------
// Replace the synthetic promote rows with real mainnet history.
//
//   railway ssh "node apps/ingest/dist/repair-promoted-history.js [--dry]"
//
// The first version of counterpart promotion wrote ONE synthetic event per
// program to stand in for its entire mainnet life. On the dossier that read as
// "upgraded ×25" in the header above a table with a single deploy row — and the
// synthetic id rendered in the Receipt column as though you could click through
// to a transaction, which is the one thing the record must never do.
//
// This walks each affected program's ProgramData signature history, inserts a
// real event per deploy/upgrade, and only then deletes the synthetic row. Order
// matters: a program whose history walk fails keeps its placeholder rather than
// losing its mainnet timeline entirely.
// ---------------------------------------------------------------------------

const dry = process.argv.includes("--dry");
const PREFIX = "counterpart-promote:";

const programDataOf = (programId: string): string =>
  bs58.encode(findProgramAddress([bs58.decode(programId)], bs58.decode(LOADER_PROGRAM_ID)));

async function run(): Promise<void> {
  const rows = await db
    .select({ id: schema.events.id, programId: schema.events.programId })
    .from(schema.events)
    .where(and(eq(schema.events.network, "mainnet"), like(schema.events.signature, `${PREFIX}%`)));

  logger.info({ count: rows.length, dry }, "repair-promoted-history: start");

  let repaired = 0;
  let failed = 0;
  for (const row of rows) {
    const pd = programDataOf(row.programId);
    try {
      const raw = await getAccountBytes("mainnet", pd);
      const parsed = raw ? parseProgramDataAccount(raw) : null;
      if (!parsed) {
        logger.warn({ programId: row.programId }, "repair: no mainnet ProgramData — keeping placeholder");
        failed++;
        continue;
      }

      const history = await ingestDeployHistory(
        "mainnet",
        row.programId,
        pd,
        parsed.upgradeAuthority ?? null,
      );
      if (!history.total) {
        logger.warn({ programId: row.programId }, "repair: empty history — keeping placeholder");
        failed++;
        continue;
      }

      // Only now is it safe to drop the stand-in.
      if (!dry) await db.delete(schema.events).where(eq(schema.events.id, row.id));
      repaired++;
      logger.info(
        {
          programId: row.programId,
          real: history.total,
          inserted: history.inserted,
          truncated: history.truncated,
        },
        "repair: real mainnet history in place",
      );
    } catch (err) {
      failed++;
      logger.error({ programId: row.programId, err: String(err) }, "repair: failed");
    }
  }
  logger.info({ of: rows.length, repaired, failed, dry }, "repair-promoted-history: complete");
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "repair-promoted-history: fatal");
    process.exit(1);
  });
