import {
  db,
  schema,
  newId,
  logger,
  getSlot,
  enumerateProgramAccounts,
  enumerateProgramData,
  type Network,
} from "@onrecord/core";
import { fingerprintStage, identifyStage, classifyStage, scoreStage } from "./pipeline.js";

// ---------------------------------------------------------------------------
// Backfill (SPEC §3). The loader's signature history is not queryable, so we
// read chain state: enumerate ProgramData accounts (deploy slot + authority)
// and Program accounts (programId → ProgramData), join them, keep those inside
// the window, and drive each through the normal pipeline stages inline.
//
//   INLINE_PIPELINE=1 tsx src/backfill.ts [--window-hours=48] [--max=500] [--network=mainnet]
//
// Populates the Radar on first run without waiting for live webhook traffic.
// ---------------------------------------------------------------------------

const SLOTS_PER_SECOND = 2.5; // ~400ms/slot

interface Options {
  network: Network;
  windowHours: number;
  max: number;
}

function parseArgs(argv: string[]): Options {
  const get = (k: string, d: string) =>
    argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
  const network = get("network", "mainnet") === "devnet" ? "devnet" : "mainnet";
  return {
    network,
    windowHours: Number(get("window-hours", "48")),
    max: Number(get("max", "500")),
  };
}

export async function runBackfill(opts: Options): Promise<{ scanned: number; ingested: number }> {
  const { network, windowHours, max } = opts;
  process.env.INLINE_PIPELINE = "1"; // stages run in sequence, no Redis

  const currentSlot = await getSlot(network);
  const cutoffSlot = currentSlot - Math.floor(windowHours * 3600 * SLOTS_PER_SECOND);
  logger.info({ network, currentSlot, cutoffSlot, windowHours }, "backfill: enumerating loader state");

  // two enumerations of loader-owned accounts, joined on the ProgramData address
  const [programAccounts, dataHeaders] = await Promise.all([
    enumerateProgramAccounts(network),
    enumerateProgramData(network),
  ]);
  const pdToProgram = new Map(programAccounts.map((p) => [p.programDataAddress, p.programId]));
  logger.info(
    { programs: programAccounts.length, programData: dataHeaders.length },
    "backfill: enumerated",
  );

  // keep deploys inside the window, newest first, capped
  const recent = dataHeaders
    .filter((h) => h.deployedSlot >= cutoffSlot && pdToProgram.has(h.programDataAddress))
    .sort((a, b) => b.deployedSlot - a.deployedSlot)
    .slice(0, max);
  logger.info({ recent: recent.length }, "backfill: programs in window");

  let ingested = 0;
  for (const h of recent) {
    const programId = pdToProgram.get(h.programDataAddress)!;
    // block time is approximate from slot delta; good enough for windowing
    const blockTime = new Date(Date.now() - (currentSlot - h.deployedSlot) * (1000 / SLOTS_PER_SECOND));
    try {
      const eventId = await recordDeploy(network, programId, h, blockTime);
      if (!eventId) continue; // already ingested
      await fingerprintStage(eventId);
      await identifyStage(eventId);
      await classifyStage(eventId);
      await scoreStage(eventId);
      ingested++;
      if (ingested % 25 === 0) logger.info({ ingested, of: recent.length }, "backfill: progress");
    } catch (err) {
      logger.warn({ programId, err: String(err) }, "backfill: program failed, skipping");
    }
  }

  logger.info({ scanned: recent.length, ingested }, "backfill: done");
  return { scanned: recent.length, ingested };
}

/** Insert a synthetic deploy event for a backfilled program (idempotent on a
 *  synthetic signature keyed by ProgramData address + slot). */
async function recordDeploy(
  network: Network,
  programId: string,
  header: { programDataAddress: string; deployedSlot: number; upgradeAuthority: string | null },
  blockTime: Date,
): Promise<string | null> {
  const signature = `backfill:${header.programDataAddress}:${header.deployedSlot}`;
  const id = newId("evt");
  const inserted = await db
    .insert(schema.events)
    .values({
      id,
      network,
      type: "deploy",
      signature,
      instructionIndex: 0,
      slot: header.deployedSlot,
      blockTime,
      programId,
      programDataAddress: header.programDataAddress,
      authorityBefore: null,
      authorityAfter: header.upgradeAuthority,
    })
    .onConflictDoNothing({ target: [schema.events.signature, schema.events.instructionIndex] })
    .returning({ id: schema.events.id });
  return inserted[0]?.id ?? null;
}

// run as a script (tsx sets argv[1] to the source path)
const isMain = process.argv[1]?.endsWith("backfill.ts") || process.argv[1]?.endsWith("backfill.js");
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  runBackfill(opts)
    .then((r) => {
      logger.info(r, "backfill complete");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: String(err) }, "backfill failed");
      process.exit(1);
    });
}
