import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  schema,
  logger,
  getAccountBytes,
  getDeployHistory,
  parseProgramDataAccount,
  deriveBytecodeIdentity,
  deployRentLamports,
  sha256Hex,
  tlshHash,
  newId,
  type Network,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// One-off re-enrichment: backfill recovered identity (name / repo / socials /
// security.txt), fingerprint (sha256/TLSH — corpus rows too, for subjects
// ingested while the tlsh CLI was missing from the image), deploy cost, and
// deploy history onto existing program subjects. Re-fetches each ProgramData
// account and updates the subject. Facts are MERGED (jsonb ||), never
// replaced — pipeline stages stash keys there (nearest, funder, codeMatch…)
// that this pass must not clobber. Coalescing name — never un-names.
//
//   INLINE_PIPELINE=1 tsx src/reenrich.ts [--network=mainnet]
// ---------------------------------------------------------------------------

async function run(network: Network): Promise<void> {
  const subs = await db
    .select({ id: schema.subjects.id, network: schema.subjects.network })
    .from(schema.subjects)
    .where(and(eq(schema.subjects.network, network), eq(schema.subjects.kind, "program")));
  logger.info({ subjects: subs.length, network }, "reenrich: start");

  let named = 0;
  let upgraded = 0;
  let tlshFilled = 0;
  let done = 0;
  for (const s of subs) {
    try {
      const ev = await db
        .select({ pd: schema.events.programDataAddress })
        .from(schema.events)
        .where(and(eq(schema.events.programId, s.id), isNotNull(schema.events.programDataAddress)))
        .limit(1);
      const pd = ev[0]?.pd;
      if (!pd) continue;
      const raw = await getAccountBytes(s.network as Network, pd);
      if (!raw) continue;
      const parsed = parseProgramDataAccount(raw);
      if (!parsed) continue;
      const bi = deriveBytecodeIdentity(parsed.bytecode);

      // fingerprint: recompute sha256 + TLSH (fills rows ingested while the
      // tlsh CLI was broken in the image)
      const sha256 = sha256Hex(parsed.bytecode);
      const tlsh = await tlshHash(parsed.bytecode);
      if (tlsh) tlshFilled++;

      // deploy vs upgrade from the ProgramData signature history
      const dh = await getDeployHistory(s.network as Network, pd);
      const upgradeCount = Math.max(0, dh.txCount - 1);
      const deployType = upgradeCount > 0 ? "upgrade" : "deploy";

      const factsPatch = {
        social: bi.social,
        website: bi.website,
        hasSecurityTxt: bi.hasSecurityTxt,
        anchor: bi.anchor,
        upgradeCount,
        upgradeCountTruncated: dh.truncated,
        deployCostLamports: deployRentLamports(raw.length),
        ...(bi.securityTxt ? { securityTxt: bi.securityTxt } : {}),
      };

      await db
        .update(schema.subjects)
        .set({
          // coalesce (never un-name) — but a mojibake'd name (latin1-decoded
          // UTF-8, e.g. "â€”") is corrupt, not operator-set: replace it
          name: sql`case when ${schema.subjects.name} ~ '(â|Ã.|�)' then ${bi.name}
                    else coalesce(${schema.subjects.name}, ${bi.name}) end`,
          repoUrl: sql`coalesce(${schema.subjects.repoUrl}, ${bi.repoUrl})`,
          sha256,
          tlsh,
          sizeBytes: parsed.bytecode.length,
          firstDeployAt: dh.firstDeployAt,
          deployType,
          facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify(factsPatch)}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(schema.subjects.id, s.id));

      // corpus: ensure this program has a TLSH-bearing row for the neighbor scan
      if (tlsh) {
        const existing = await db
          .select({ id: schema.fingerprintCorpus.id, tlsh: schema.fingerprintCorpus.tlsh })
          .from(schema.fingerprintCorpus)
          .where(
            and(
              eq(schema.fingerprintCorpus.programId, s.id),
              eq(schema.fingerprintCorpus.sha256, sha256),
            ),
          )
          .limit(1);
        if (!existing[0]) {
          await db.insert(schema.fingerprintCorpus).values({
            id: newId("fpc"),
            programId: s.id,
            network: s.network,
            sha256,
            tlsh,
            sizeBytes: parsed.bytecode.length,
          });
        } else if (!existing[0].tlsh) {
          await db
            .update(schema.fingerprintCorpus)
            .set({ tlsh })
            .where(eq(schema.fingerprintCorpus.id, existing[0].id));
        }
      }

      if (bi.name) named++;
      if (deployType === "upgrade") upgraded++;
    } catch (err) {
      logger.warn({ id: s.id, err: String(err) }, "reenrich: subject failed");
    }
    if (++done % 25 === 0)
      logger.info({ done, of: subs.length, named, upgraded, tlshFilled }, "reenrich: progress");
  }
  logger.info({ done, named, upgraded, tlshFilled, of: subs.length }, "reenrich: complete");
}

const argv = process.argv.slice(2);
const netArg = argv.find((a) => a.startsWith("--network="))?.split("=")[1];
const network: Network = netArg === "devnet" ? "devnet" : "mainnet";
run(network)
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "reenrich: failed");
    process.exit(1);
  });
