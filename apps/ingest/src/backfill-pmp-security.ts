import { and, eq, inArray, sql } from "drizzle-orm";
import bs58 from "bs58";
import {
  db,
  schema,
  logger,
  rpc,
  fetchProgramMetadata,
  pmpCanonicalAddress,
  readPmpSecurity,
  securityTxtSource,
  PROGRAM_METADATA_PROGRAM_ID,
  type Network,
} from "@onrecord/core";
import { refreshInterest } from "./interest.js";
import { requireDatabaseTarget, requireRpcKey } from "./db-target.js";

// ---------------------------------------------------------------------------
// Re-read every program's PMP security account and store it (facts.pmpSecurity).
//
// Ingest probes the account once, at deploy/upgrade time. Teams usually publish
// metadata AFTER the deploy lands — minutes to weeks later — so the stored copy
// is missing for programs that published late, and stale for ones that edited
// theirs. Measured 2026-09-30: 59 mainnet programs on record have a canonical
// PMP security account, and 16 of them had none stored.
//
// Cheap on purpose: one getProgramAccounts per cluster lists every account
// under the "security" seed (header only), and only corpus programs whose
// canonical PDA shows up get the full read.
//
//   DATABASE_URL=… HELIUS_API_KEY=… tsx src/backfill-pmp-security.ts [--network=mainnet|devnet] [--dry]
//
// --dry prints every row it would change — and which of them would start (or
// stop) counting as a security.txt — and writes nothing. Accounts that have
// disappeared are reported, never deleted from facts: absence is one read, and
// the stored copy is what the program published.
// ---------------------------------------------------------------------------

const dry = process.argv.includes("--dry");
const only = process.argv.find((a) => a.startsWith("--network="))?.split("=")[1] as Network | undefined;

/** Order-independent JSON, so a re-serialized but identical record is not a change. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** Program ids whose canonical PMP security account exists on `network`. */
async function programsWithSecurityAccount(network: Network): Promise<Set<string>> {
  const seed = Buffer.alloc(16);
  seed.write("security");
  const accounts = await rpc<{ pubkey: string; account: { data: [string, string] } }[]>(
    network,
    "getProgramAccounts",
    [
      PROGRAM_METADATA_PROGRAM_ID,
      {
        encoding: "base64",
        dataSlice: { offset: 0, length: 33 },
        filters: [
          { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from([2])) } }, // metadata account
          { memcmp: { offset: 67, bytes: bs58.encode(seed) } },
        ],
      },
    ],
  );
  const out = new Set<string>();
  for (const a of accounts) {
    const programId = bs58.encode(Buffer.from(a.account.data[0], "base64").subarray(1, 33));
    // non-canonical accounts (written by a third party) are never surfaced
    if (pmpCanonicalAddress(programId, "security") === a.pubkey) out.add(programId);
  }
  logger.info({ network, seeded: accounts.length, canonical: out.size }, "pmp-security: listed");
  return out;
}

async function run(network: Network): Promise<void> {
  const onChain = await programsWithSecurityAccount(network);
  const rows = await db
    .select({ id: schema.subjects.id, name: schema.subjects.name, facts: schema.subjects.facts })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        sql`(${inArray(schema.subjects.id, [...onChain, ""])} or ${schema.subjects.facts} ? 'pmpSecurity')`,
      ),
    );

  const tally = { added: 0, changed: 0, same: 0, unreadable: 0, gone: 0, startsCounting: 0, stopsCounting: 0 };
  for (const row of rows) {
    const facts = (row.facts ?? {}) as Record<string, unknown>;
    const label = `${row.id} ${row.name ?? "(unnamed)"}`;
    if (!onChain.has(row.id)) {
      tally.gone++;
      console.log(`  gone      ${label} — stored, but no canonical account on chain now (kept)`);
      continue;
    }
    const md = await fetchProgramMetadata(network, row.id);
    if (!md.security) {
      tally.unreadable++;
      console.log(`  unread    ${label} — account exists but did not decode to JSON (External source, bad URL, not JSON)`);
      continue;
    }
    if (facts.pmpSecurity !== undefined && stable(facts.pmpSecurity) === stable(md.security)) {
      tally.same++;
      continue;
    }
    const before = securityTxtSource(facts);
    const after = securityTxtSource({ ...facts, pmpSecurity: md.security });
    const kind = facts.pmpSecurity === undefined ? "added" : "changed";
    tally[kind]++;
    if (!before && after) tally.startsCounting++;
    if (before && !after) tally.stopsCounting++;
    const read = readPmpSecurity(md.security);
    console.log(
      `  ${kind.padEnd(9)} ${label} — security.txt ${before ?? "none"} → ${after ?? "none"}` +
        (read && !read.counts ? " (no contact or policy: not counted)" : ""),
    );
    if (dry) continue;
    await db
      .update(schema.subjects)
      .set({
        facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({ pmpSecurity: md.security })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(schema.subjects.id, row.id));
    // disclosure is a third of the interest score, so re-rank with the new fact
    await refreshInterest(row.id);
  }
  logger.info({ network, dry, ...tally }, "pmp-security: done");
}

const target = requireDatabaseTarget("backfill-pmp-security.ts");
requireRpcKey("backfill-pmp-security.ts");
logger.info({ target, dry }, "pmp-security: start");
for (const network of only ? [only] : (["mainnet", "devnet"] as Network[])) await run(network);
process.exit(0);
