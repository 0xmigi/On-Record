import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { sql } from "drizzle-orm";
import { db, logger, rpc, type Network } from "@onrecord/core";
import { requireDatabaseTarget, requireRpcKey } from "./db-target.js";

// ---------------------------------------------------------------------------
// Fill the tables behind builder profiles (/b/<address>, migration 0011).
//
//   multisig_members  every Squads v4 multisig that controls a program on
//                     record, read from its account now: one getMultipleAccounts
//                     per 100 multisigs. A multisig's rows are replaced whole, so
//                     a member removed on chain leaves the table.
//   funding_trails    imported from a funding cache written by the deployer-
//                     behavior research (research/deployer-behavior/
//                     _research-funding.ts): one row per wallet traced.
//
//   ./node_modules/.bin/tsx src/backfill-wallets.ts [flags]
//     --network mainnet|devnet   default mainnet
//     --funding FILE             funding-cache.json to import (else skipped)
//     --write                    apply (default: dry run, writes nothing)
// ---------------------------------------------------------------------------

const SCRIPT = "backfill-wallets.ts";
const SQUADS_V4 = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const MULTISIG_DISC = createHash("sha256").update("account:Multisig").digest().subarray(0, 8);

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const network = (flag("network") ?? "mainnet") as Network;
const write = process.argv.includes("--write");
const fundingFile = flag("funding");

interface Multisig {
  address: string;
  threshold: number;
  members: string[];
}

/** Multisig: disc 8 · create_key 32 · config_authority 32 · threshold u16 ·
 *  time_lock u32 · transaction_index u64 · stale_transaction_index u64 ·
 *  rent_collector Option<Pubkey> · bump u8 · members Vec<Member{key, mask u8}>
 *  (same layout as enrich/authority.ts inspectSquadsAuthority) */
function decodeMultisig(address: string, owner: string, data: Buffer): Multisig | null {
  if (owner !== SQUADS_V4 || data.length < 100 || !data.subarray(0, 8).equals(MULTISIG_DISC)) return null;
  const threshold = data.readUInt16LE(72);
  let o = data[94] === 1 ? 128 : 96;
  const n = data.readUInt32LE(o);
  o += 4;
  if (data.length < o + n * 33) return null;
  const members: string[] = [];
  for (let i = 0; i < n; i++, o += 33) members.push(bs58.encode(data.subarray(o, o + 32)));
  return { address, threshold, members };
}

async function multisigs(): Promise<void> {
  const rows = (await db.execute(sql`
    select distinct facts->'multisig'->>'address' as address from subjects
    where network = ${network} and kind = 'program' and facts->'multisig'->>'version' = 'v4'
  `)) as unknown as { address: string }[];
  const found: Multisig[] = [];
  let unreadable = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100).map((r) => r.address);
    const res = await rpc<{ value: ({ owner: string; data: [string, string] } | null)[] }>(network, "getMultipleAccounts", [
      chunk,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    chunk.forEach((a, j) => {
      const acc = res.value[j];
      const ms = acc ? decodeMultisig(a, acc.owner, Buffer.from(acc.data[0], "base64")) : null;
      if (ms) found.push(ms);
      else unreadable++;
    });
  }
  const memberRows = found.reduce((n, m) => n + m.members.length, 0);
  logger.info({ multisigs: rows.length, decoded: found.length, unreadable, memberRows, write }, "backfill-wallets: multisig members");
  if (!write) return;
  for (const m of found) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`delete from multisig_members where network = ${network} and multisig = ${m.address}`);
      const values = JSON.stringify(m.members.map((member) => ({ member })));
      await tx.execute(sql`
        insert into multisig_members (network, multisig, member, version, threshold, member_count)
        select ${network}, ${m.address}, v.member, 'v4', ${m.threshold}, ${m.members.length}
        from jsonb_to_recordset(${values}::jsonb) as v(member text)
        on conflict do nothing
      `);
    });
  }
}

type Cached = { busy: boolean; empty?: boolean; funder: string | null; lamports: number | null; at: number | null; error?: string };

async function funding(file: string): Promise<void> {
  const cache = JSON.parse(readFileSync(file, "utf8")) as Record<string, Cached>;
  const rows = Object.entries(cache)
    .filter(([, c]) => !c.error)
    .map(([address, c]) => ({
      address,
      funder: c.funder,
      lamports: c.lamports,
      funded_at: c.at ? new Date(c.at * 1000).toISOString() : null,
      busy: c.busy,
    }));
  logger.info(
    { rows: rows.length, busy: rows.filter((r) => r.busy).length, withFunder: rows.filter((r) => r.funder).length, write },
    "backfill-wallets: funding trails",
  );
  if (!write) return;
  for (let i = 0; i < rows.length; i += 1000) {
    const batch = JSON.stringify(rows.slice(i, i + 1000));
    await db.execute(sql`
      insert into funding_trails (network, address, funder, lamports, funded_at, busy)
      select ${network}, v.address, v.funder, v.lamports, v.funded_at, v.busy
      from jsonb_to_recordset(${batch}::jsonb) as v(address text, funder text, lamports bigint, funded_at timestamptz, busy boolean)
      on conflict (network, address) do update set
        funder = excluded.funder, lamports = excluded.lamports, funded_at = excluded.funded_at,
        busy = excluded.busy, read_at = now()
    `);
  }
}

async function run(): Promise<void> {
  const target = requireDatabaseTarget(SCRIPT);
  requireRpcKey(SCRIPT);
  logger.info({ target, network, write }, "backfill-wallets: start");
  await multisigs();
  if (fundingFile) await funding(fundingFile);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: String(err) }, "backfill-wallets: fatal");
    process.exit(1);
  });
