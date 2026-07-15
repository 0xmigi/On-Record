import { and, desc, eq } from "drizzle-orm";
import {
  db,
  schema,
  logger,
  getSlot,
  getProgramDataAddress,
  getAccountBytes,
  parseProgramDataHeader,
  type Network,
} from "@onrecord/core";
import { recordDeploy } from "./backfill.js";
import { fingerprintStage, identifyStage, classifyStage, scoreStage } from "./pipeline.js";

// ---------------------------------------------------------------------------
// Verified-program backfill. The radar's live feed only sees programs deployed
// after the poller started, so historical protocols (Phoenix, Kamino, …) never
// enter the index and their program ids 404 on lookup. This seeds them from the
// OtterSec verified-builds registry — the same source our `verified` flag reads
// — so every verified program is at least *referenceable* via search/dossier.
//
// Targeted, not enumerated: we resolve each known program id individually
// (getProgramDataAddress → header) rather than scanning the whole loader, which
// would load every ProgramData header on mainnet into a 256MB container.
//
// These land as synthetic deploys dated to their ProgramData slot (the LAST
// upgrade, not the original deploy) — fine for referenceability. They won't
// appear in the "new deploys" window; they're old by definition.
// ---------------------------------------------------------------------------

const OSEC_LIST = "https://verify.osec.io/verified-programs";
const SLOTS_PER_SECOND = 2.5;

interface VerifiedListPage {
  meta?: { total?: number; total_pages?: number };
  verified_programs?: string[];
}

/** Page through the OtterSec verified-programs registry, collecting every
 *  verified program id (deduped). */
export async function fetchVerifiedProgramIds(): Promise<string[]> {
  const ids = new Set<string>();
  let page = 1;
  let totalPages = 1;
  do {
    // pagination is PATH-based (/verified-programs/{page}); the ?page= query
    // param is silently ignored and always returns page 1.
    const res = await fetch(`${OSEC_LIST}/${page}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`osec verified-programs page ${page}: HTTP ${res.status}`);
    const json = (await res.json()) as VerifiedListPage;
    for (const id of json.verified_programs ?? []) ids.add(id);
    totalPages = json.meta?.total_pages ?? page;
    page++;
  } while (page <= totalPages);
  return [...ids];
}

export interface VerifiedBackfillResult {
  total: number;
  ingested: number;
  skipped: number;
  failed: number;
}

/** Seed the index with the OtterSec verified programs. `max` caps the run
 *  (smoke tests); omit for the full set. Idempotent — re-runs skip programs
 *  already recorded at the same ProgramData slot. */
export async function runVerifiedBackfill(
  opts: { network?: Network; max?: number; reenrich?: boolean } = {},
): Promise<VerifiedBackfillResult> {
  process.env.INLINE_PIPELINE = "1"; // stages run in sequence, no Redis
  const network = opts.network ?? "mainnet";

  const all = await fetchVerifiedProgramIds();
  const targets = opts.max ? all.slice(0, opts.max) : all;
  const currentSlot = await getSlot(network);
  logger.info(
    { verified: all.length, targets: targets.length, network },
    "verified-backfill: start",
  );

  let ingested = 0;
  let skipped = 0;
  let failed = 0;

  for (const programId of targets) {
    try {
      // reenrich: re-run identify on the already-ingested event so existing
      // programs pick up new enrichment (e.g. the genesis timeline row) without
      // re-fingerprinting. No new event is recorded.
      if (opts.reenrich) {
        const rows = await db
          .select({ id: schema.events.id })
          .from(schema.events)
          .where(and(eq(schema.events.programId, programId), eq(schema.events.network, network)))
          .orderBy(desc(schema.events.slot))
          .limit(1);
        const eventId = rows[0]?.id;
        if (!eventId) {
          skipped++;
          continue;
        }
        await identifyStage(eventId);
        ingested++;
        if (ingested % 25 === 0) {
          logger.info({ ingested, of: targets.length }, "verified-backfill: reenrich progress");
        }
        continue;
      }

      // resolve programId → ProgramData, then read its header for slot+authority
      const programDataAddress = await getProgramDataAddress(network, programId);
      if (!programDataAddress) {
        skipped++; // not an upgradeable-loader program (or account gone)
        continue;
      }
      const pdBytes = await getAccountBytes(network, programDataAddress);
      const header = pdBytes ? parseProgramDataHeader(pdBytes) : null;
      if (!header) {
        skipped++; // ProgramData missing/closed
        continue;
      }

      const blockTime = new Date(
        Date.now() - (currentSlot - header.deployedSlot) * (1000 / SLOTS_PER_SECOND),
      );
      const eventId = await recordDeploy(
        network,
        programId,
        { programDataAddress, deployedSlot: header.deployedSlot, upgradeAuthority: header.upgradeAuthority },
        blockTime,
      );
      if (!eventId) {
        skipped++; // already ingested at this slot
        continue;
      }

      await fingerprintStage(eventId);
      await identifyStage(eventId);
      await classifyStage(eventId);
      await scoreStage(eventId);
      ingested++;
      if (ingested % 25 === 0) {
        logger.info({ ingested, of: targets.length }, "verified-backfill: progress");
      }
    } catch (err) {
      failed++;
      logger.warn({ programId, err: String(err) }, "verified-backfill: program failed");
    }
  }

  const result = { total: targets.length, ingested, skipped, failed };
  logger.info(result, "verified-backfill: done");
  return result;
}

// run as a script: INLINE_PIPELINE=1 tsx src/backfill-verified.ts [--max=5] [--network=mainnet]
const isMain =
  process.argv[1]?.endsWith("backfill-verified.ts") ||
  process.argv[1]?.endsWith("backfill-verified.js");
if (isMain) {
  const arg = (k: string, d: string) =>
    process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
  const network: Network = arg("network", "mainnet") === "devnet" ? "devnet" : "mainnet";
  const maxRaw = arg("max", "");
  runVerifiedBackfill({ network, max: maxRaw ? Number(maxRaw) : undefined })
    .then((r) => {
      logger.info(r, "verified-backfill complete");
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: String(err) }, "verified-backfill failed");
      process.exit(1);
    });
}
