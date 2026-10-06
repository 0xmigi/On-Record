import bs58 from "bs58";
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
// Shared by the backfill and, later, the incremental sweep: pass `from` to read
// only what landed after the last walk.
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
 *  Two paths, chosen by the first page of signatures. A history that fits in
 *  one page (all but a few dozen programs) is read one getTransaction at a time,
 *  1 credit each. A longer one is read in bulk, oldest first: the first full
 *  run spent 140k of its 270k credits on 7 programs whose ProgramData is passed
 *  into every call, for 4 loader rows between them. */
export async function walkLoaderHistory(
  network: Network,
  programId: string,
  opts: { from?: WalkFrom } = {},
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
  if (sigs.length === 1000) return walkBulk(network, programId, programData, walk, opts.from);

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
): Promise<Walk> {
  const rows: LoaderRow[] = [];
  let credits = 1; // the signature page that sent us here
  let token: string | null = null;
  try {
    for (let call = 0; ; call++) {
      if (call === BULK_CAP) {
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
