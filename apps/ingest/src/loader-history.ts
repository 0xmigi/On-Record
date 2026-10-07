import bs58 from "bs58";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  schema,
  rpc,
  findProgramAddress,
  getSignaturesForAddress,
  LOADER_PROGRAM_ID,
  MAX_TX_VERSION,
  type Network,
} from "@onrecord/core";

// ---------------------------------------------------------------------------
// The loader record — every upgradeable-loader instruction that acted on a
// program, with who signed it, who paid, and the authority before and after.
//
// ProgramData is written only by the loader, so its signature history holds
// every deploy, upgrade, authority change, extend and close the program has
// had. It also holds transactions that merely pass the account in: programs
// that check their own upgrade authority (Anchor's `ProgramData` constraint)
// put it in every admin call. Calibrated on 150 random mainnet programs
// (2026-10-06): 111 of 944 transactions read, 12%, carried no loader
// instruction for the program, across 25 of the 150. Those are counted, not
// stored.
//
// Shared by the backfill and the pipeline: `refreshLoaderRecord` reads only what
// landed after the last walk, and `loaderRecord` is what deploy-vs-upgrade and
// the upgrade count are read from.
// ---------------------------------------------------------------------------

const LOADER_KEY = bs58.decode(LOADER_PROGRAM_ID);

export const programDataOf = (programId: string): string =>
  bs58.encode(findProgramAddress([bs58.decode(programId)], LOADER_KEY));

/** jsonParsed instruction type → our kind. The RPC parses every classic loader
 *  instruction; ones it doesn't know arrive raw and are decoded by tag below. */
const KIND: Record<string, string> = {
  deployWithMaxDataLen: "deploy",
  upgrade: "upgrade",
  setAuthority: "set_authority",
  setAuthorityChecked: "set_authority_checked",
  close: "close",
  extendProgram: "extend",
  extendProgramChecked: "extend_checked",
  migrate: "migrate",
};
/** bincode u32 tags of the instructions newer than the RPC's parser */
const RAW_KIND: Record<number, string> = { 8: "migrate", 9: "extend_checked" };

interface ParsedIx {
  programId: string;
  parsed?: { type: string; info: Record<string, unknown> };
  accounts?: string[];
  data?: string;
}
interface ParsedTx {
  slot: number;
  blockTime: number | null;
  version: "legacy" | number;
  meta: {
    err: unknown;
    innerInstructions?: { index: number; instructions: ParsedIx[] }[] | null;
  } | null;
  transaction: {
    message: {
      accountKeys: { pubkey: string; signer: boolean }[];
      instructions: ParsedIx[];
    };
  };
}

export type LoaderRow = typeof schema.loaderTxns.$inferInsert;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The rows one transaction contributes for one program. Empty when it touched
 *  the ProgramData without a loader instruction acting on it. */
export function loaderRows(
  network: Network,
  programId: string,
  programData: string,
  signature: string,
  tx: ParsedTx,
): LoaderRow[] {
  const keys = tx.transaction.message.accountKeys;
  const top = tx.transaction.message.instructions;
  const located: { ix: ParsedIx; outer: number; inner: number }[] = top.map((ix, i) => ({ ix, outer: i, inner: -1 }));
  for (const group of tx.meta?.innerInstructions ?? []) {
    group.instructions.forEach((ix, j) => located.push({ ix, outer: group.index, inner: j }));
  }

  const base = {
    network,
    signature,
    programId,
    programDataAddress: programData,
    slot: tx.slot,
    blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
    failed: tx.meta?.err != null,
    feePayer: keys[0]!.pubkey,
    signers: keys.filter((k) => k.signer).map((k) => k.pubkey),
    txVersion: String(tx.version),
  };

  const rows: LoaderRow[] = [];
  for (const { ix, outer, inner } of located) {
    if (ix.programId !== LOADER_PROGRAM_ID) continue;
    const invokedBy = inner === -1 ? null : (top[outer]?.programId ?? null);

    if (ix.parsed) {
      const { type, info } = ix.parsed;
      // the instruction has to act on THIS program's ProgramData — a deploy of
      // another program in the same transaction is that program's row
      if (info.programDataAccount !== programData && info.account !== programData) continue;
      const kind = KIND[type] ?? "unknown";
      const authority = str(info.authority);
      let authorityBefore: string | null = null;
      let authorityAfter: string | null = null;
      if (kind === "deploy") authorityAfter = authority;
      else if (kind === "upgrade") authorityBefore = authorityAfter = authority;
      else if (kind === "set_authority" || kind === "set_authority_checked") {
        authorityBefore = authority;
        authorityAfter = str(info.newAuthority); // absent = made immutable
      } else if (kind === "close") authorityBefore = authority;
      rows.push({
        ...base,
        outerIndex: outer,
        innerIndex: inner,
        kind,
        authorityBefore,
        authorityAfter,
        payer: str(info.payerAccount),
        buffer: str(info.bufferAccount),
        invokedBy,
        info: { type, ...info },
      });
      continue;
    }

    // unparsed: newer than the RPC's parser. Keep it if it names our account.
    if (!(ix.accounts ?? []).includes(programData)) continue;
    let tag: number | null = null;
    try {
      const data = bs58.decode(ix.data ?? "");
      if (data.length >= 4) tag = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
    } catch {
      // undecodable data is still worth a row; the kind says we don't know
    }
    rows.push({
      ...base,
      outerIndex: outer,
      innerIndex: inner,
      kind: (tag !== null && RAW_KIND[tag]) || "unknown",
      authorityBefore: null,
      authorityAfter: null,
      payer: null,
      buffer: null,
      invokedBy,
      info: { tag, accounts: ix.accounts ?? [], data: ix.data ?? null },
    });
  }
  return rows;
}

export interface Walk {
  walk: typeof schema.loaderWalks.$inferInsert;
  rows: LoaderRow[];
  /** Helius credits spent */
  credits: number;
}

/** Where a previous walk stopped, for reading only what landed since. */
export interface WalkFrom {
  signature: string;
  slot: number;
}

/** Read one program's loader record. Never throws: a failed listing comes back
 *  as an 'error' walk so the coverage table says so.
 *
 *  Two paths, chosen by the first page of signatures. A short history (BULK_OVER
 *  signatures or fewer) is read one getTransaction at a time, 1 credit each. A
 *  longer one is read in bulk, oldest first: the first full run spent 140k of
 *  its 270k credits on 7 programs whose ProgramData is passed into every call,
 *  for 4 loader rows between them. `maxBulkCalls` caps a bulk read below
 *  BULK_CAP; a walk that hits it is 'truncated'. */
export async function walkLoaderHistory(
  network: Network,
  programId: string,
  opts: { from?: WalkFrom; maxBulkCalls?: number } = {},
): Promise<Walk> {
  const programData = programDataOf(programId);
  const walk: Walk["walk"] = {
    network,
    programId,
    programDataAddress: programData,
    status: "complete",
    signatures: 0,
    nonLoader: 0,
    unread: 0,
    loaderRows: 0,
    newestSignature: null,
    newestSlot: null,
    oldestSlot: null,
    error: null,
    walkedAt: new Date(),
  };

  let sigs: { signature: string; slot: number }[];
  try {
    sigs = await getSignaturesForAddress(network, programData, { limit: 1000, until: opts.from?.signature });
  } catch (err) {
    return { walk: { ...walk, status: "error", error: String(err).slice(0, 500) }, rows: [], credits: 1 };
  }
  if (sigs.length > BULK_OVER) return walkBulk(network, programId, programData, walk, opts.from, opts.maxBulkCalls);

  walk.signatures = sigs.length;
  if (!sigs.length) return { walk: { ...walk, status: opts.from ? "complete" : "empty" }, rows: [], credits: 1 };
  walk.newestSignature = sigs[0]!.signature;
  walk.newestSlot = sigs[0]!.slot;
  walk.oldestSlot = sigs[sigs.length - 1]!.slot;

  const rows: LoaderRow[] = [];
  let credits = 1;
  for (const { signature } of sigs) {
    credits++;
    let tx: ParsedTx | null = null;
    try {
      tx = await rpc<ParsedTx | null>(network, "getTransaction", [
        signature,
        { maxSupportedTransactionVersion: MAX_TX_VERSION, encoding: "jsonParsed", commitment: "confirmed" },
      ]);
    } catch {
      tx = null;
    }
    if (!tx) {
      walk.unread++;
      continue;
    }
    const found = loaderRows(network, programId, programData, signature, tx);
    if (!found.length) walk.nonLoader++;
    rows.push(...found);
  }
  walk.loaderRows = rows.length;
  if (walk.unread > 0) walk.status = "partial";
  return { walk, rows, credits };
}

/** Helius getTransactionsForAddress: 100 full transactions per call, 10 credits
 *  (Developer plan and up). */
const BULK_PAGE = 100;
const BULK_CREDITS = 10;
/** Above this many signatures one bulk call is no dearer than reading them one
 *  at a time, and it is one round trip instead of dozens. Was 1000 (only the
 *  histories that overflow a signature page); the bulk read was checked against
 *  the stored per-transaction walks of 3 random 157–331-signature programs on
 *  2026-10-07 and produced the same rows, failed transactions included; so did
 *  incremental reads (`from`) on both paths for 2 more. */
const BULK_OVER = 10;
/** Bulk calls per program before the walk is called truncated: 200,000
 *  transactions, 20,000 credits. Oldest first, so a truncated bulk walk is
 *  missing its NEWEST history, never its genesis. */
const BULK_CAP = 2_000;

async function walkBulk(
  network: Network,
  programId: string,
  programData: string,
  walk: Walk["walk"],
  from: WalkFrom | undefined,
  maxCalls = BULK_CAP,
): Promise<Walk> {
  const rows: LoaderRow[] = [];
  let credits = 1; // the signature page that sent us here
  let token: string | null = null;
  try {
    for (let call = 0; ; call++) {
      if (call === maxCalls) {
        walk.status = "truncated";
        break;
      }
      const page: { data: (ParsedTx & { transaction: { signatures: string[] } })[]; paginationToken: string | null } =
        await rpc(network, "getTransactionsForAddress", [
          programData,
          {
            transactionDetails: "full",
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: MAX_TX_VERSION,
            sortOrder: "asc",
            limit: BULK_PAGE,
            ...(token ? { paginationToken: token } : {}),
            ...(from ? { filters: { slot: { gt: from.slot } } } : {}),
          },
        ]);
      credits += BULK_CREDITS;
      for (const tx of page.data) {
        const signature = tx.transaction.signatures[0]!;
        walk.signatures!++;
        walk.oldestSlot ??= tx.slot;
        walk.newestSlot = tx.slot;
        walk.newestSignature = signature;
        const found = loaderRows(network, programId, programData, signature, tx);
        if (!found.length) walk.nonLoader!++;
        rows.push(...found);
      }
      token = page.paginationToken;
      if (!token || page.data.length === 0) break;
    }
  } catch (err) {
    // a bulk walk that dies halfway keeps nothing: the rows would be real, but
    // the coverage row could not say what was missed
    return { walk: { ...walk, status: "error", error: String(err).slice(0, 500) }, rows: [], credits };
  }
  walk.loaderRows = rows.length;
  return { walk, rows, credits };
}

/** Write a walk: rows are append-only (a re-read collapses onto the same key),
 *  the coverage row is replaced. */
export async function storeWalk({ walk, rows }: Walk): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(schema.loaderTxns).values(rows.slice(i, i + 200)).onConflictDoNothing();
  }
  await db
    .insert(schema.loaderWalks)
    .values(walk)
    .onConflictDoUpdate({ target: [schema.loaderWalks.network, schema.loaderWalks.programId], set: walk });
}

type WalkRow = typeof schema.loaderWalks.$inferSelect;

/** Bring a program's loader record up to date. Reads only what landed after the
 *  stored walk, and merges the coverage row rather than replacing it. With
 *  `store: false` nothing is written and the caller gets the new rows to count.
 *
 *  A truncated walk is left alone: it stopped BULK_CAP calls in, and resuming
 *  it can cost that much again. Its counts stay a floor and say so.
 *  An error walk never overwrites a good coverage row. */
export async function refreshLoaderRecord(
  network: Network,
  programId: string,
  opts: { store?: boolean; maxBulkCalls?: number } = {},
): Promise<Walk & { previous: WalkRow | null }> {
  const [previous = null] = await db
    .select()
    .from(schema.loaderWalks)
    .where(and(eq(schema.loaderWalks.network, network), eq(schema.loaderWalks.programId, programId)));
  if (previous?.status === "truncated") return { walk: previous, rows: [], credits: 0, previous };

  const from =
    previous && previous.status !== "error" && previous.newestSignature && previous.newestSlot != null
      ? { signature: previous.newestSignature, slot: previous.newestSlot }
      : undefined;
  const w = await walkLoaderHistory(network, programId, { from, maxBulkCalls: opts.maxBulkCalls });
  if (w.walk.status === "error") {
    if (!previous && opts.store !== false) await storeWalk(w);
    return { ...w, previous };
  }
  if (from && previous) {
    const status =
      w.walk.status === "truncated"
        ? "truncated"
        : previous.status === "partial" || w.walk.status === "partial"
          ? "partial"
          : "complete";
    w.walk = {
      ...w.walk,
      status,
      signatures: previous.signatures + (w.walk.signatures ?? 0),
      nonLoader: previous.nonLoader + (w.walk.nonLoader ?? 0),
      unread: previous.unread + (w.walk.unread ?? 0),
      loaderRows: previous.loaderRows + (w.walk.loaderRows ?? 0),
      newestSignature: w.walk.newestSignature ?? previous.newestSignature,
      newestSlot: w.walk.newestSlot ?? previous.newestSlot,
      oldestSlot: previous.oldestSlot ?? w.walk.oldestSlot,
    };
  }
  if (opts.store !== false) await storeWalk(w);
  return { ...w, previous };
}

/** What the loader record says about a program's code history. */
export interface LoaderRecord {
  /** successful `upgrade` instructions. Not ProgramData signatures: those also
   *  count extends, authority changes, closes, failed attempts and every call
   *  that passes the account in to check the admin. */
  upgrades: number;
  /** some history is unread (a truncated or partial walk): upgrades is a floor */
  incomplete: boolean;
  /** the newest slot the record has read; anything above it is unknown */
  newestSlot: number | null;
  /** when the code last changed: the newest successful deploy or upgrade */
  lastCodeChangeAt: Date | null;
  /** the first successful deploy */
  genesis: { firstSignature: string; firstDeploySlot: number; firstDeployAt: Date | null } | null;
  /** the newest successful loader instruction signed by the current authority
   *  (else the newest at all): the transaction that names a multisig, if one
   *  holds the program */
  lastSignature: string | null;
}

/** Refresh the loader record, then read it. Throws when the chain could not be
 *  read and nothing is stored, so a pipeline stage retries rather than calling
 *  an upgraded program new. */
export async function loaderRecord(
  network: Network,
  programId: string,
  opts: { authority?: string | null; maxBulkCalls?: number } = {},
): Promise<LoaderRecord> {
  const w = await refreshLoaderRecord(network, programId, { maxBulkCalls: opts.maxBulkCalls });
  if (w.walk.status === "error" && !w.previous) throw new Error(`loader record unreadable: ${w.walk.error}`);
  const status = w.walk.status === "error" ? w.previous!.status : w.walk.status;
  const newestSlot = w.walk.status === "error" ? w.previous!.newestSlot : w.walk.newestSlot;

  const [agg] = (await db.execute(sql`
    select
      count(*) filter (where kind = 'upgrade' and not failed)::int as upgrades,
      (array_agg(signature order by slot, outer_index, inner_index) filter (where kind = 'deploy' and not failed))[1] as genesis_signature,
      min(slot) filter (where kind = 'deploy' and not failed) as genesis_slot,
      (array_agg(block_time order by slot, outer_index, inner_index) filter (where kind = 'deploy' and not failed))[1] as genesis_time,
      (array_agg(signature order by coalesce(authority_before = ${opts.authority ?? null}, false) desc, slot desc) filter (where not failed))[1] as last_signature,
      max(block_time) filter (where kind in ('deploy', 'upgrade') and not failed) as last_code_change_at
    from loader_txns
    where network = ${network} and program_id = ${programId}
  `)) as unknown as {
    upgrades: number;
    genesis_signature: string | null;
    genesis_slot: string | number | null;
    genesis_time: string | Date | null;
    last_signature: string | null;
    last_code_change_at: string | Date | null;
  }[];
  return {
    upgrades: agg?.upgrades ?? 0,
    incomplete: status === "truncated" || status === "partial",
    newestSlot: newestSlot ?? null,
    lastCodeChangeAt: agg?.last_code_change_at ? new Date(agg.last_code_change_at) : null,
    genesis:
      agg?.genesis_signature && agg.genesis_slot != null
        ? {
            firstSignature: agg.genesis_signature,
            firstDeploySlot: Number(agg.genesis_slot),
            firstDeployAt: agg.genesis_time ? new Date(agg.genesis_time) : null,
          }
        : null,
    lastSignature: agg?.last_signature ?? null,
  };
}

/** True when the only successful loader instruction at `slot` is an extend.
 *
 *  The ProgramData header's slot is what the poller diffs, and ExtendProgram
 *  rewrites it to the current slot without touching the code: measured on
 *  mainnet 2026-10-07, 2,167 poller "upgrades" sat on a slot whose only loader
 *  instruction was an extend. A slot with an extend AND an upgrade (the CLI
 *  extends before an upgrade that needs the room) is a code change.
 *
 *  Only meaningful where the record covers the slot: the caller checks that. */
export async function extendOnlyAt(network: Network, programId: string, slot: number): Promise<boolean> {
  const [row] = (await db.execute(sql`
    select
      bool_or(kind in ('extend', 'extend_checked')) as extended,
      bool_or(kind in ('deploy', 'upgrade')) as code
    from loader_txns
    where network = ${network} and program_id = ${programId} and slot = ${slot} and not failed
  `)) as unknown as { extended: boolean | null; code: boolean | null }[];
  return row?.extended === true && row.code !== true;
}
