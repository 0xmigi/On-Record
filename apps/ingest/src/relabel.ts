// Apply the registry to rows that are already indexed: names from labels.yaml,
// and a recomputed category under the widened taxonomy.
//
// WHY THIS EXISTS
//   Both changes are retroactive. The pipeline only categorises and names a
//   program when an event for it comes through, so widening Category or adding
//   an entity does nothing for the ~4,000 programs already on record until
//   something re-runs it over them. reclassify.ts re-runs the dedup gate and
//   reenrich.ts re-reads bytecode; neither touches the category or the name.
//
// WHAT IT OVERRIDES, AND WHAT IT WILL NOT
//   A registry name outranks every other naming source (pipeline.ts), so a
//   curated name replaces one recovered from the binary — that is the point:
//   the binary gives up the CRATE name, so Jupiter's lend programs are on
//   record as `vaults` and `liquidity`, and two unrelated programs both came
//   back `amm`. It will not name a program the registry has nothing to say
//   about, and it never clears a name to null.
//
//   INLINE_PIPELINE=1 tsx src/relabel.ts [--dry] [--network=mainnet|devnet|all]
//
// Idempotent and offline — no RPC, no bytecode fetch. It reads what is already
// stored, so it is cheap to re-run after every registry edit.
import { and, eq, sql } from "drizzle-orm";
import { db, schema, logger, buildSearchText, type Category, type Fingerprint, type Network } from "@onrecord/core";
import { categorize, findEntityForProgram, seedFromLabels } from "@onrecord/enrich";
import { requireDatabaseTarget } from "./db-target.js";

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const netArg = argv.find((a) => a.startsWith("--network="))?.split("=")[1] ?? "all";
const networks: Network[] =
  netArg === "mainnet" ? ["mainnet"] : netArg === "devnet" ? ["devnet"] : ["mainnet", "devnet"];

const target = requireDatabaseTarget("relabel.ts");
logger.info({ target, networks, dry }, "target database");

const seeded = await seedFromLabels();
logger.info({ entities: seeded }, "relabel: registry seeded");

let scanned = 0;
let renamed = 0;
let recategorised = 0;
const before: Record<string, number> = {};
const after: Record<string, number> = {};

for (const network of networks) {
  // the subject plus the IDL from its most recent fingerprinted event — the
  // profile carries the recovered instruction surface, the IDL is the fallback
  // for rows profiled before instructionNames existed
  const rows = await db.execute(sql`
    select s.id, s.name, s.category, s.profile,
           e.enrichment -> 'fingerprint' -> 'idl' as idl
    from subjects s
    left join lateral (
      select enrichment from events
      where program_id = s.id and enrichment ? 'fingerprint'
      order by slot desc limit 1
    ) e on true
    where s.kind = 'program' and s.network = ${network}
  `);
  const subjects = (rows as unknown as { rows: SubjectRow[] }).rows ?? (rows as unknown as SubjectRow[]);
  logger.info({ network, subjects: subjects.length }, "relabel: scanning");

  for (const s of subjects) {
    scanned++;
    before[s.category ?? "null"] = (before[s.category ?? "null"] ?? 0) + 1;

    const entity = await findEntityForProgram(s.id);
    const fp = s.idl ? ({ idl: s.idl } as Fingerprint) : undefined;
    const category: Category = categorize(
      fp,
      entity ? { entityId: entity.id, entityCategory: entity.category } : undefined,
      s.profile ?? undefined,
    );
    after[category] = (after[category] ?? 0) + 1;

    // never clear a name; only replace one when the registry has a better answer
    const name = betterName(s.name, entity?.name ?? null);
    const nameChanged = name !== null && name !== s.name;
    const categoryChanged = category !== s.category;
    if (!nameChanged && !categoryChanged) continue;

    if (nameChanged) {
      renamed++;
      logger.info({ programId: s.id, from: s.name, to: name }, "relabel: name");
    }
    if (categoryChanged) recategorised++;
    if (dry) continue;

    await db
      .update(schema.subjects)
      .set({
        category,
        ...(nameChanged
          ? {
              name,
              // the stored corpus was built from a binary that never mentions
              // this name — prepend it so search can still reach the row
              searchText: sql`lower(${name}) || E'\n' || coalesce(${schema.subjects.searchText}, '')`,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.subjects.id, s.id));
  }
}

/** Which of the two names the program should carry.
 *
 *  The registry wins by default — that is the whole point, since what the
 *  binary gives up is the crate name. But a registry entry is an ENTITY name
 *  as often as a program name, and swapping "Orca Whirlpool program" for
 *  "Orca" or "Marinade Liquid Staking" for "Marinade" loses information for
 *  no gain. So the registry name is treated as a floor, not a ceiling: when
 *  the name already on the row spells out the registry name and says more,
 *  it stays. Anything else — a crate name, a different name, no name — is
 *  replaced. */
function betterName(current: string | null, registry: string | null): string | null {
  if (!registry) return current;
  if (!current) return registry;
  const c = current.toLowerCase();
  const r = registry.toLowerCase();
  if (c !== r && c.includes(r)) return current;
  return registry;
}

const fmt = (t: Record<string, number>) =>
  Object.entries(t)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

logger.info({ scanned, renamed, recategorised, dry }, "relabel: done");
logger.info({ before: fmt(before) }, "relabel: categories before");
logger.info({ after: fmt(after) }, "relabel: categories after");
process.exit(0);

interface SubjectRow {
  id: string;
  name: string | null;
  category: string | null;
  profile: import("@onrecord/core").ProgramProfile | null;
  idl: Fingerprint["idl"] | null;
}
