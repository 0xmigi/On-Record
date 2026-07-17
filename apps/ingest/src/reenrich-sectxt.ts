import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  schema,
  logger,
  getAccountBytes,
  parseProgramDataAccount,
  deriveBytecodeIdentity,
  type Network,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// Targeted backfill for the security.txt alignment fix (parseSecurityTxt no
// longer drops empty interior values). Only programs that already carry a
// `securityTxt` in facts can be affected, so we touch just those — one RPC
// (getAccountBytes) each — and re-derive identity with the fixed parser.
//
// Facts keys derived purely from the bytecode (securityTxt / website / social /
// hasSecurityTxt / anchor) are OVERWRITTEN, since the old values may be the
// scrambled ones. repoUrl is replaced ONLY when the stored value is corrupt
// (empty / non-URL) — a null or a real URL (incl. registry-sourced) is kept.
// name is coalesced (never un-named); its source field is first in the block
// and unaffected by the shift.
//
//   INLINE_PIPELINE=1 tsx src/reenrich-sectxt.ts [--network=mainnet|devnet]
// ---------------------------------------------------------------------------

async function run(network: Network): Promise<void> {
  const subs = await db
    .select({ id: schema.subjects.id })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        sql`${schema.subjects.facts} ? 'securityTxt'`,
      ),
    );
  logger.info({ subjects: subs.length, network }, "reenrich-sectxt: start");

  let fixed = 0;
  let failed = 0;
  let done = 0;
  for (const s of subs) {
    try {
      const ev = await db
        .select({ pd: schema.events.programDataAddress })
        .from(schema.events)
        .where(and(eq(schema.events.programId, s.id), isNotNull(schema.events.programDataAddress)))
        .limit(1);
      const pd = ev[0]?.pd;
      if (!pd) {
        failed++;
        continue;
      }
      const raw = await getAccountBytes(network, pd);
      if (!raw) {
        failed++;
        continue;
      }
      const parsed = parseProgramDataAccount(raw);
      if (!parsed) {
        failed++;
        continue;
      }
      const bi = deriveBytecodeIdentity(parsed.bytecode);

      const factsPatch = {
        social: bi.social,
        website: bi.website,
        hasSecurityTxt: bi.hasSecurityTxt,
        anchor: bi.anchor,
        ...(bi.securityTxt ? { securityTxt: bi.securityTxt } : {}),
      };

      await db
        .update(schema.subjects)
        .set({
          name: sql`case when ${schema.subjects.name} ~ '(â|Ã.|�)' then ${bi.name}
                    else coalesce(${schema.subjects.name}, ${bi.name}) end`,
          repoUrl: sql`case
                    when ${schema.subjects.repoUrl} is null
                      or ${schema.subjects.repoUrl} ~* '^https?://' then ${schema.subjects.repoUrl}
                    else ${bi.repoUrl} end`,
          facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify(factsPatch)}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(schema.subjects.id, s.id));
      fixed++;
    } catch (err) {
      failed++;
      logger.warn({ id: s.id, err: String(err) }, "reenrich-sectxt: subject failed");
    }
    if (++done % 25 === 0)
      logger.info({ done, of: subs.length, fixed, failed }, "reenrich-sectxt: progress");
  }
  logger.info({ done, fixed, failed, of: subs.length }, "reenrich-sectxt: complete");
}

const argv = process.argv.slice(2);
const netArg = argv.find((a) => a.startsWith("--network="))?.split("=")[1];
const network: Network = netArg === "devnet" ? "devnet" : "mainnet";
run(network)
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "reenrich-sectxt: failed");
    process.exit(1);
  });
