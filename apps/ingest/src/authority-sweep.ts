import { sql } from "drizzle-orm";
import {
  db,
  logger,
  rpc,
  parseProgramDataHeader,
  PROGRAMDATA_HEADER_LEN,
  type AuthorityClass,
  type Network,
} from "@onrecord/core";
import { classifyAuthority, inspectSquadsAuthority, type MultisigInfo } from "@onrecord/enrich";
import { requireDatabaseTarget, requireRpcKey } from "./db-target.js";
import { programDataOf, refreshLoaderRecord } from "./loader-history.js";
import { refreshDossier } from "./revalidate.js";

// ---------------------------------------------------------------------------
// Authority sweep: catch upgrade-authority changes the poller can't see.
//
// The poller finds work by the ProgramData header's deploy slot, and
// SetAuthority doesn't move it. So a program whose control moved (to a
// multisig, to a new wallet, to nobody) and whose code didn't change never
// reaches the pipeline: its loader record misses the change, and
// subjects.authority, authority_class and facts.multisig keep naming the old
// controller. Wallet alerts match on those (alerts.ts), so they followed the
// old one.
//
// Each pass reads every live program's 45-byte ProgramData header, 100 per
// getMultipleAccounts call, and compares its authority with
//   - the loader record's newest authority (the last successful deploy,
//     upgrade or authority change): where they differ, the record is missing
//     the change, so it is brought up to date from ProgramData history;
//   - subjects.authority: where they differ, authority, authority_class and
//     facts.multisig are re-derived the way identifyStage derives them.
// A program with no loader walk yet is walked only when its subject drifted.
// Closed programs (header gone) are left to the closed sweep.
//
// `dry` reads everything, chain included, and writes nothing. It is how the
// first pass was calibrated:
//   ./node_modules/.bin/tsx src/authority-sweep.ts [--network mainnet|devnet] [--write]
//     [--max-walks N]   loader-record refreshes per pass, default 200
// ---------------------------------------------------------------------------

/** Bulk calls one program's refresh may spend: 5,000 transactions, 500 credits */
const MAX_BULK_CALLS = 50;
const AUTHORITY_KINDS = sql`('deploy', 'upgrade', 'set_authority', 'set_authority_checked')`;

interface Row {
  id: string;
  authority: string | null;
  authority_class: string | null;
  multisig: string | null;
  walk_status: string | null;
  has_record: boolean;
  record_authority: string | null;
}

export interface AuthorityChange {
  programId: string;
  from: string | null;
  to: string | null;
  classFrom: string | null;
  classTo: AuthorityClass | null;
  /** the loader record now holds the transaction that made the change */
  recorded: boolean;
}

export interface AuthoritySweep {
  network: Network;
  dry: boolean;
  programs: number;
  live: number;
  notLive: number;
  agree: number;
  /** chain ≠ loader record: the record missed a change */
  recordBehind: number;
  /** chain ≠ subjects.authority */
  subjectBehind: number;
  walked: number;
  /** a change the record still can't account for after its refresh */
  unexplained: string[];
  /** past --max-walks: picked up next pass */
  deferred: number;
  changes: AuthorityChange[];
}

/** Current header of each ProgramData address: authority, or null when the
 *  account is gone or no longer a program image. Throws on RPC error, so a
 *  transient failure skips the pass rather than reading as "closed". */
async function readHeaders(
  network: Network,
  addresses: string[],
): Promise<Map<string, { upgradeAuthority: string | null } | null>> {
  const out = new Map<string, { upgradeAuthority: string | null } | null>();
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const res = await rpc<{ value: ({ lamports: number; data: [string, string] } | null)[] }>(
      network,
      "getMultipleAccounts",
      [chunk, { encoding: "base64", dataSlice: { offset: 0, length: PROGRAMDATA_HEADER_LEN }, commitment: "confirmed" }],
    );
    chunk.forEach((address, j) => {
      const acc = res.value[j];
      const header = acc && acc.lamports > 0 ? parseProgramDataHeader(Buffer.from(acc.data[0], "base64")) : null;
      out.set(address, header ? { upgradeAuthority: header.upgradeAuthority } : null);
    });
  }
  return out;
}

/** The loader record's newest authority for one program: what its last
 *  successful deploy, upgrade or authority change left in control. */
async function recordAuthority(network: Network, programId: string): Promise<{ found: boolean; authority: string | null }> {
  const [r] = (await db.execute(sql`
    select authority_after from loader_txns
    where network = ${network} and program_id = ${programId} and not failed and kind in ${AUTHORITY_KINDS}
    order by slot desc, outer_index desc, inner_index desc limit 1
  `)) as unknown as { authority_after: string | null }[];
  return r ? { found: true, authority: r.authority_after } : { found: false, authority: null };
}

/** loaderRecord's lastSignature, read from what is stored: the newest
 *  successful loader instruction the current authority signed, else the newest
 *  at all. The transaction that names a Squads multisig, if one holds it. */
async function lastSignatureOf(network: Network, programId: string, authority: string | null): Promise<string | null> {
  const [r] = (await db.execute(sql`
    select signature from loader_txns
    where network = ${network} and program_id = ${programId} and not failed
    order by coalesce(authority_before = ${authority}, false) desc, slot desc limit 1
  `)) as unknown as { signature: string }[];
  return r?.signature ?? null;
}

export async function sweepAuthority(
  network: Network = "mainnet",
  opts: { dry?: boolean; maxWalks?: number } = {},
): Promise<AuthoritySweep> {
  const dry = opts.dry ?? false;
  const maxWalks = opts.maxWalks ?? 200;
  const rows = (await db.execute(sql`
    select s.id, s.authority, s.authority_class, s.facts->'multisig'->>'address' as multisig,
      w.status as walk_status, r.program_id is not null as has_record, r.authority_after as record_authority
    from subjects s
    left join loader_walks w on w.network = s.network and w.program_id = s.id
    left join lateral (
      select t.program_id, t.authority_after from loader_txns t
      where t.network = s.network and t.program_id = s.id and not t.failed and t.kind in ${AUTHORITY_KINDS}
      order by t.slot desc, t.outer_index desc, t.inner_index desc limit 1
    ) r on true
    where s.network = ${network} and s.kind = 'program' and (s.facts->>'closedAt') is null
  `)) as unknown as Row[];

  const pdOf = new Map(rows.map((r) => [r.id, programDataOf(r.id)]));
  const headers = await readHeaders(network, [...pdOf.values()]);

  const out: AuthoritySweep = {
    network,
    dry,
    programs: rows.length,
    live: 0,
    notLive: 0,
    agree: 0,
    recordBehind: 0,
    subjectBehind: 0,
    walked: 0,
    unexplained: [],
    deferred: 0,
    changes: [],
  };

  for (const r of rows) {
    const header = headers.get(pdOf.get(r.id)!);
    if (!header) {
      out.notLive++;
      continue;
    }
    out.live++;
    const chain = header.upgradeAuthority;
    const recordBehind = r.has_record && chain !== r.record_authority;
    const subjectBehind = chain !== r.authority;
    if (!recordBehind && !subjectBehind) {
      out.agree++;
      continue;
    }
    if (recordBehind) out.recordBehind++;
    if (subjectBehind) out.subjectBehind++;

    try {
      // bring the loader record up to date where it missed the change, or has
      // never been read for a program whose control moved
      let recorded = r.has_record && !recordBehind;
      if ((recordBehind || !r.has_record) && r.walk_status !== "truncated") {
        if (out.walked >= maxWalks) {
          out.deferred++;
          continue;
        }
        out.walked++;
        const w = await refreshLoaderRecord(network, r.id, { store: !dry, maxBulkCalls: MAX_BULK_CALLS });
        if (dry) {
          const newest = w.rows
            .filter((x) => !x.failed && ["deploy", "upgrade", "set_authority", "set_authority_checked"].includes(x.kind))
            .sort((a, b) => Number(b.slot) - Number(a.slot) || b.outerIndex - a.outerIndex || b.innerIndex - a.innerIndex)[0];
          recorded = newest ? newest.authorityAfter === chain : recorded;
        } else {
          const now = await recordAuthority(network, r.id);
          recorded = now.found && now.authority === chain;
        }
      }
      if ((recordBehind || !r.has_record) && !recorded) out.unexplained.push(r.id);

      if (!subjectBehind) continue;

      // re-derive control the way identifyStage does
      let classTo = await classifyAuthority(network, chain);
      let multisig: MultisigInfo | null = null;
      if (network !== "devnet" && (classTo === "program" || classTo === "squads")) {
        const lastSignature = await lastSignatureOf(network, r.id, chain);
        if (lastSignature) multisig = await inspectSquadsAuthority(network, lastSignature);
        if (multisig) classTo = "squads";
      }
      out.changes.push({ programId: r.id, from: r.authority, to: chain, classFrom: r.authority_class, classTo, recorded });
      if (dry) continue;

      // guarded on the authority read: a pipeline write since is newer
      const facts = multisig
        ? sql`coalesce(facts, '{}'::jsonb) || ${JSON.stringify({ multisig })}::jsonb`
        : sql`coalesce(facts, '{}'::jsonb) - 'multisig'`;
      const updated = await db.execute(sql`
        update subjects set authority = ${chain}, authority_class = ${classTo}, facts = ${facts}, updated_at = now()
        where id = ${r.id} and network = ${network} and authority is not distinct from ${r.authority}
        returning id
      `);
      if (updated.length) refreshDossier(r.id);
    } catch (err) {
      logger.warn({ id: r.id, err: String(err) }, "authority sweep: program failed");
    }
  }

  logger.info(
    {
      network,
      dry,
      programs: out.programs,
      live: out.live,
      agree: out.agree,
      recordBehind: out.recordBehind,
      subjectBehind: out.subjectBehind,
      walked: out.walked,
      unexplained: out.unexplained.length,
      deferred: out.deferred,
      changed: out.changes.length,
    },
    "authority sweep: done",
  );
  return out;
}

// --- CLI entry (skipped when imported by the cron) --------------------------
const isMain =
  process.argv[1]?.endsWith("authority-sweep.js") || process.argv[1]?.endsWith("authority-sweep.ts");
if (isMain) {
  const target = requireDatabaseTarget("authority-sweep.ts");
  requireRpcKey("authority-sweep.ts");
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const network: Network = flag("network") === "devnet" ? "devnet" : "mainnet";
  sweepAuthority(network, { dry: !argv.includes("--write"), maxWalks: Number(flag("max-walks") ?? 200) })
    .then((r) => {
      const count = (key: (c: AuthorityChange) => string) =>
        r.changes.reduce<Record<string, number>>((acc, c) => ((acc[key(c)] = (acc[key(c)] ?? 0) + 1), acc), {});
      console.log(
        JSON.stringify(
          {
            target,
            ...r,
            unexplained: r.unexplained.length,
            unexplainedSample: r.unexplained.slice(0, 10),
            changes: r.changes.length,
            byClass: count((c) => `${c.classFrom ?? "null"} → ${c.classTo ?? "null"}`),
            recordedInLoaderRecord: count((c) => String(c.recorded)),
            sample: r.changes.slice(0, 10),
          },
          null,
          2,
        ),
      );
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err: String(err) }, "authority sweep: failed");
      process.exit(1);
    });
}
