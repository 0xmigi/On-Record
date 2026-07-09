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
// One-off re-enrichment: backfill recovered identity (name / repo / socials /
// security.txt) onto program subjects that were ingested before the pipeline
// learned to read it from the binary. Re-fetches each ProgramData account,
// derives identity, and updates the subject (coalescing — never un-names).
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

      await db
        .update(schema.subjects)
        .set({
          name: sql`coalesce(${schema.subjects.name}, ${bi.name})`,
          repoUrl: sql`coalesce(${schema.subjects.repoUrl}, ${bi.repoUrl})`,
          facts: {
            social: bi.social,
            website: bi.website,
            hasSecurityTxt: bi.hasSecurityTxt,
            anchor: bi.anchor,
          },
          updatedAt: new Date(),
        })
        .where(eq(schema.subjects.id, s.id));
      if (bi.name) named++;
    } catch (err) {
      logger.warn({ id: s.id, err: String(err) }, "reenrich: subject failed");
    }
    if (++done % 25 === 0) logger.info({ done, of: subs.length, named }, "reenrich: progress");
  }
  logger.info({ done, named, of: subs.length }, "reenrich: complete");
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
