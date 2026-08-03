// Seed the canonical programs that loader-event ingestion alone will never
// reach, so name search can find them and lineage has something to match against.
//
// Three distinct holes this closes. The first two were found by searching
// "metaplex" and getting only its callers back:
//
//   1. NO ROW  — a program that has not deployed or upgraded inside our window
//      has no subject at all (Metaplex Token Metadata, OpenBook v2, the
//      canonical Token-2022). Nothing to find.
//   2. NO NAME — a program that IS indexed but leaks no name: immutable, no
//      security.txt, no `programs/<name>/src/` panic path. SPL Token was the
//      worst case, the single most-invoked program on Solana sitting in the
//      index with name = null.
//   3. NO LOADER — a program deployed before the upgradeable loader existed has
//      no ProgramData account, so the old version of this script skipped it as
//      "not upgradeable". That silently excluded SPL Token, Memo v1/v2, the
//      Associated Token Account program, Serum v2 and Orca v1 — ordinary BPF
//      programs with real, fingerprintable bytecode sitting in their program
//      account. inspectProgramAccount() tells that case apart from a native
//      program (no bytecode anywhere) and the pipeline handles both now.
//
// Two input lists, deliberately separate:
//   • labels.yaml     — curated entities. A registry name outranks every other
//                       naming source (pipeline.ts), so an id here gets named.
//   • landmarks.*.txt — addresses only, no editorial. These get ingested and
//                       fingerprinted; they keep whatever name the binary gives.
//
//   ./node_modules/.bin/tsx src/seed-landmarks.ts [--dry] [--network=mainnet]
//
// Idempotent: named rows are left alone, existing subjects are never
// re-ingested. Costs ~1 RPC read per landmark plus a bytecode fetch for each
// program that is genuinely new.
import { readFileSync } from "node:fs";
import { eq, isNull, sql } from "drizzle-orm";
import {
  assertTlshAvailable,
  db,
  schema,
  logger,
  getAccountBytes,
  getBlockTime,
  inspectProgramAccount,
  parseProgramDataAccount,
  type EventEnrichment,
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
// The whole point of seeding landmarks is to give lineage something to match
// against. Run this without tlsh and it writes hundreds of rows with no
// fingerprint at all — the corpus grows, every distance comes back null, and
// nothing looks broken. Same guard backfill.ts has, for the same reason.
await assertTlshAvailable();
logger.info({ target, network, dry }, "target database");

const seeded = await seedFromLabels();
logger.info({ entities: seeded, network, dry }, "seed-landmarks: registry seeded");

// every curated program id, with the entity name that should win
const entities = await db
  .select({ name: schema.entities.name, programIds: schema.entities.programIds })
  .from(schema.entities)
  .where(eq(schema.entities.source, "labels"));

const targets: { id: string; name: string | null }[] = entities.flatMap((e) =>
  e.programIds.map((id) => ({ id, name: e.name as string | null })),
);

// …plus the address-only landmark list. A curated entity already covering an
// address wins: it carries a name, and the landmark entry carries none.
const curated = targets.length;
const seen = new Set(targets.map((t) => t.id));
const listed = readLandmarkList(network);
for (const id of listed) {
  if (seen.has(id)) continue;
  seen.add(id);
  targets.push({ id, name: null });
}
logger.info(
  { curated, listed: listed.length, targets: targets.length },
  "seed-landmarks: target program ids",
);

/** Addresses only, one per line; `#` comments and blanks ignored. Anything that
 *  is not plain base58 is a typo worth failing on, not skipping — a silently
 *  dropped line is a landmark that never gets indexed and never gets noticed. */
function readLandmarkList(net: Network): string[] {
  const path = new URL(`./landmarks.${net}.txt`, import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    logger.info({ path: path.pathname }, "seed-landmarks: no landmark list for this network");
    return [];
  }
  const ids: string[] = [];
  raw.split("\n").forEach((line, i) => {
    const s = line.replace(/#.*$/, "").trim();
    if (!s) return;
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) {
      logger.error({ line: i + 1, value: s }, "seed-landmarks: not a base58 address");
      process.exit(1);
    }
    ids.push(s);
  });
  return [...new Set(ids)];
}

let named = 0;
let ingested = 0;
let alreadyFine = 0;
let noBytecode = 0;
let failed = 0;

for (const t of targets) {
  const rows = await db
    .select({ id: schema.subjects.id, name: schema.subjects.name })
    .from(schema.subjects)
    .where(eq(schema.subjects.id, t.id));
  const existing = rows[0];

  // --- hole 2: indexed but nameless ---------------------------------------
  if (existing) {
    // A landmark-list entry carries no name by design — if the row is already
    // there, this script has nothing left to give it.
    if (existing.name || !t.name) {
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

  // --- holes 1 + 3: no row at all -----------------------------------------
  try {
    const acct = await inspectProgramAccount(network, t.id);
    if (acct.kind === "native") {
      // Built into the validator: no bytecode exists on chain, so there is
      // nothing to fingerprint and nothing honest to put in the corpus.
      logger.warn({ programId: t.id, name: t.name }, "native program — no bytecode to index");
      noBytecode++;
      continue;
    }
    if (acct.kind !== "upgradeable" && acct.kind !== "immutable") {
      logger.warn({ programId: t.id, name: t.name, kind: acct.kind }, "not a program account — skipping");
      noBytecode++;
      continue;
    }

    // The upgradeable loader records a deploy slot and an authority; loader
    // v1/v2 record neither, so those events are seeded undated (see
    // EventEnrichment.undated) rather than stamped with a fabricated `now`.
    let header: { programDataAddress: string | null; deployedSlot: number; upgradeAuthority: string | null };
    let blockTime: Date | null;
    let enrichment: EventEnrichment = {};
    if (acct.kind === "upgradeable") {
      const raw = await getAccountBytes(network, acct.programDataAddress);
      if (!raw) {
        // Closing a program reclaims its ProgramData account outright, leaving
        // the program account behind as a husk that still points at the gone
        // address. There is no bytecode left on chain to fingerprint — not a
        // failure, just a program that no longer exists. Curated lists keep
        // carrying these (deprecated protocol versions, rent-reclaimed bots).
        logger.warn(
          { programId: t.id, name: t.name, programData: acct.programDataAddress },
          "ProgramData reclaimed — program is closed, nothing to index",
        );
        noBytecode++;
        continue;
      }
      const parsed = parseProgramDataAccount(raw);
      if (!parsed) {
        logger.warn({ programId: t.id, name: t.name }, "ProgramData unparseable — skipping");
        failed++;
        continue;
      }
      header = {
        programDataAddress: acct.programDataAddress,
        deployedSlot: parsed.deployedSlot,
        upgradeAuthority: parsed.upgradeAuthority,
      };
      const seconds = await getBlockTime(network, parsed.deployedSlot);
      blockTime = seconds ? new Date(seconds * 1000) : new Date();
    } else {
      header = { programDataAddress: null, deployedSlot: 0, upgradeAuthority: null };
      blockTime = null;
      enrichment = { undated: true };
    }

    logger.info(
      { programId: t.id, name: t.name, loader: acct.kind, slot: header.deployedSlot },
      "ingesting a program with no loader event in window",
    );
    if (dry) {
      ingested++;
      continue;
    }
    const eventId = await recordDeploy(network, t.id, header, blockTime, enrichment);
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
    noBytecode,
    failed,
    namelessSubjectsRemaining: Number(stillNameless[0]?.n ?? 0),
    dry,
  },
  "seed-landmarks: done",
);
process.exit(0);
