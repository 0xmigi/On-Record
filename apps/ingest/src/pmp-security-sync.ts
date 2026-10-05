import { and, eq, inArray, sql } from "drizzle-orm";
import bs58 from "bs58";
import {
  db,
  schema,
  logger,
  rpc,
  decodePmpSecurityAccount,
  pmpCanonicalAddress,
  securityTxtSource,
  PROGRAM_METADATA_PROGRAM_ID,
  type Network,
} from "@onrecord/core";
import { refreshInterest } from "./interest.js";

// ---------------------------------------------------------------------------
// Keep facts.pmpSecurity in step with the chain.
//
// Ingest probes a program's PMP security account once, at deploy/upgrade time.
// Teams usually publish metadata AFTER the deploy lands — minutes to weeks
// later — so the stored copy goes missing for late publishers and stale for
// anyone who edits theirs. Measured 2026-09-30: 59 mainnet programs on record
// had a canonical PMP security account, and 16 had none stored.
//
// Cost is the design constraint, because this runs every day. ONE
// getProgramAccounts per cluster returns every account under the "security"
// seed, data included, and everything is decoded locally — no per-program
// read, however large the corpus gets. At Helius list prices (2026-10-05):
// 10 credits per getProgramAccounts plus 2 per 0.1 MB returned; ~225 accounts
// of a few hundred bytes each comes to ~25 credits a day for both clusters.
// The only other traffic is off-chain: an account whose payload is a URL gets
// that URL fetched, which is not an RPC call.
//
// Writes only what changed. Accounts that disappeared are logged, never
// deleted from facts: the stored copy is what the program published.
// ---------------------------------------------------------------------------

export interface PmpSyncResult {
  network: Network;
  /** canonical security accounts on chain */
  onChain: number;
  added: number;
  changed: number;
  same: number;
  unreadable: number;
  gone: number;
  /** programs that now have a security.txt and did not before */
  startsCounting: number;
  stopsCounting: number;
}

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

/** Every canonical PMP security account on `network`, raw bytes, in one call. */
async function listSecurityAccounts(network: Network): Promise<Map<string, Buffer>> {
  const seed = Buffer.alloc(16);
  seed.write("security");
  const accounts = await rpc<{ pubkey: string; account: { data: [string, string] } }[]>(
    network,
    "getProgramAccounts",
    [
      PROGRAM_METADATA_PROGRAM_ID,
      {
        encoding: "base64",
        filters: [
          { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from([2])) } }, // metadata account
          { memcmp: { offset: 67, bytes: bs58.encode(seed) } },
        ],
      },
    ],
  );
  const out = new Map<string, Buffer>();
  for (const a of accounts) {
    const data = Buffer.from(a.account.data[0], "base64");
    const programId = bs58.encode(data.subarray(1, 33));
    // non-canonical accounts (written by a third party) are never surfaced
    if (pmpCanonicalAddress(programId, "security") === a.pubkey) out.set(programId, data);
  }
  return out;
}

export async function syncPmpSecurity(
  network: Network,
  opts: { dry?: boolean; verbose?: boolean } = {},
): Promise<PmpSyncResult> {
  const onChain = await listSecurityAccounts(network);
  const rows = await db
    .select({ id: schema.subjects.id, name: schema.subjects.name, facts: schema.subjects.facts })
    .from(schema.subjects)
    .where(
      and(
        eq(schema.subjects.network, network),
        eq(schema.subjects.kind, "program"),
        sql`(${inArray(schema.subjects.id, [...onChain.keys(), ""])} or ${schema.subjects.facts} ? 'pmpSecurity')`,
      ),
    );

  const r: PmpSyncResult = {
    network,
    onChain: onChain.size,
    added: 0,
    changed: 0,
    same: 0,
    unreadable: 0,
    gone: 0,
    startsCounting: 0,
    stopsCounting: 0,
  };
  const say = (line: string) => opts.verbose && console.log(line);

  for (const row of rows) {
    const facts = (row.facts ?? {}) as Record<string, unknown>;
    const label = `${row.id} ${row.name ?? "(unnamed)"}`;
    const data = onChain.get(row.id);
    if (!data) {
      r.gone++;
      say(`  gone      ${label} — stored, but no canonical account on chain now (kept)`);
      continue;
    }
    const security = await decodePmpSecurityAccount(data);
    if (!security) {
      r.unreadable++;
      say(`  unread    ${label} — account did not decode (External source, dead URL, not JSON or text)`);
      continue;
    }
    if (facts.pmpSecurity !== undefined && stable(facts.pmpSecurity) === stable(security)) {
      r.same++;
      continue;
    }
    const before = securityTxtSource(facts);
    const after = securityTxtSource({ ...facts, pmpSecurity: security });
    const kind = facts.pmpSecurity === undefined ? "added" : "changed";
    r[kind]++;
    if (!before && after) r.startsCounting++;
    if (before && !after) r.stopsCounting++;
    say(`  ${kind.padEnd(9)} ${label} — security.txt ${before ?? "none"} → ${after ?? "none"}`);
    if (opts.dry) continue;
    await db
      .update(schema.subjects)
      .set({
        facts: sql`coalesce(${schema.subjects.facts}, '{}'::jsonb) || ${JSON.stringify({ pmpSecurity: security })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(schema.subjects.id, row.id));
    // disclosure is a third of the interest score — re-rank with the new fact.
    // Database work only; it makes no RPC call.
    await refreshInterest(row.id);
  }
  logger.info({ ...r, dry: Boolean(opts.dry) }, "pmp-security sync");
  return r;
}
