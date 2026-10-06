import { b58decode, b58encode, MAX_TX_VERSION, type Rpc } from "./chain.js";
import { findProgramAddress, isOnCurve } from "./curve.js";

// ---------------------------------------------------------------------------
// Who controls the upgrade authority, because the fix steps depend on it.
//
// Measured on mainnet 2026-09-28: Squads v4 vaults control 8% of live
// upgradeable programs but 38% of failed verifications (66 of 174). 54 of those
// 66 are stale, and 43 have a recipe signed by a key other than the vault. The
// single-signer commands the doctor printed can't fix any of them: the vault
// has to sign the recipe, and an upgrade is a proposal, not a transaction.
//
// A vault address doesn't say which multisig it belongs to, so this reads
// recent transactions for a Squads instruction, which names the multisig as its
// first account; deriving that multisig's vaults confirms the match. The
// ProgramData account comes first: it only appears in deploys, upgrades and
// authority changes, so an upgrade executed through Squads is right there. The
// vault's own history is the fallback, and on a busy protocol it's mostly user
// traffic (13 of 66 Squads programs were missed looking there alone).
// ---------------------------------------------------------------------------

export const SQUADS_V4 = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
export const SQUADS_V3 = "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu";

export type AuthorityKind =
  | { kind: "none" }
  | { kind: "wallet" }
  | {
      kind: "squads";
      version: "v4" | "v3";
      multisig: string;
      vaultIndex: number;
      threshold: number | null;
      members: string[];
    }
  /** Off-curve, but no Squads multisig found: another program controls it. */
  | { kind: "program" };

/** How many of the vault's recent transactions to look through. */
const SCAN = 10;

export async function identifyAuthority(
  rpc: Rpc,
  authority: string | null,
  programData?: string,
): Promise<AuthorityKind> {
  if (authority === null) return { kind: "none" };
  if (isOnCurve(b58decode(authority))) return { kind: "wallet" };

  const tried = new Set<string>();
  for (const address of programData ? [programData, authority] : [authority]) {
    const found = await scan(rpc, address, authority, tried);
    if (found) return found;
  }
  return { kind: "program" };
}

async function scan(rpc: Rpc, address: string, authority: string, tried: Set<string>): Promise<AuthorityKind | null> {
  let sigs: { signature: string }[] = [];
  try {
    sigs = await rpc<{ signature: string }[]>("getSignaturesForAddress", [address, { limit: SCAN }]);
  } catch {
    return null;
  }
  for (const { signature } of sigs) {
    const tx = await rpc<RpcTx | null>("getTransaction", [
      signature,
      { encoding: "json", maxSupportedTransactionVersion: MAX_TX_VERSION },
    ]).catch(() => null);
    if (!tx) continue;
    const keys = [
      ...tx.transaction.message.accountKeys,
      ...(tx.meta?.loadedAddresses?.writable ?? []),
      ...(tx.meta?.loadedAddresses?.readonly ?? []),
    ];
    for (const ix of tx.transaction.message.instructions) {
      const program = keys[ix.programIdIndex];
      if (program !== SQUADS_V4 && program !== SQUADS_V3) continue;
      const candidate = keys[ix.accounts[0] ?? -1];
      if (!candidate || tried.has(candidate)) continue;
      tried.add(candidate);
      const found = matchVault(program, candidate, authority);
      if (found !== null) return readMultisig(rpc, program === SQUADS_V4 ? "v4" : "v3", candidate, found);
    }
  }
  return null;
}

/** The vault index at which `multisig` derives `authority`, or null. */
function matchVault(program: string, multisig: string, authority: string): number | null {
  const pid = b58decode(program);
  const ms = b58decode(multisig);
  if (program === SQUADS_V4) {
    for (let i = 0; i < 4; i++) {
      const vault = findProgramAddress([Buffer.from("multisig"), ms, Buffer.from("vault"), Uint8Array.from([i])], pid);
      if (b58encode(vault) === authority) return i;
    }
  } else {
    for (let i = 1; i < 4; i++) {
      const idx = Buffer.alloc(4);
      idx.writeUInt32LE(i);
      const vault = findProgramAddress([Buffer.from("squad"), ms, idx, Buffer.from("authority")], pid);
      if (b58encode(vault) === authority) return i;
    }
  }
  return null;
}

async function readMultisig(rpc: Rpc, version: "v4" | "v3", multisig: string, vaultIndex: number): Promise<AuthorityKind> {
  const base = { kind: "squads" as const, version, multisig, vaultIndex, threshold: null, members: [] as string[] };
  const res = await rpc<{ value: { owner: string; data: [string, string] } | null }>("getAccountInfo", [
    multisig,
    { encoding: "base64" },
  ]).catch(() => null);
  const acc = res?.value;
  if (!acc || acc.owner !== (version === "v4" ? SQUADS_V4 : SQUADS_V3)) return base;
  const d = Buffer.from(acc.data[0], "base64");
  try {
    // v4 Multisig: create_key, config_authority, threshold u16, time_lock u32,
    // transaction_index u64, stale_transaction_index u64, rent_collector
    // Option<Pubkey>, bump u8, members Vec<{ key, permissions u8 }>
    // v3 Ms: threshold u16, authority_index u16, transaction_index u32,
    // ms_change_index u32, bump u8, create_key, allow_external_execute bool,
    // keys Vec<Pubkey>
    let o = 8;
    let threshold: number;
    const members: string[] = [];
    if (version === "v4") {
      o += 64;
      threshold = d.readUInt16LE(o);
      o += 2 + 4 + 8 + 8;
      o += d[o] === 1 ? 33 : 1;
      o += 1;
      const n = d.readUInt32LE(o);
      o += 4;
      for (let i = 0; i < n; i++, o += 33) members.push(b58encode(d.subarray(o, o + 32)));
    } else {
      threshold = d.readUInt16LE(o);
      o += 2 + 2 + 4 + 4 + 1 + 32 + 1;
      const n = d.readUInt32LE(o);
      o += 4;
      for (let i = 0; i < n; i++, o += 32) members.push(b58encode(d.subarray(o, o + 32)));
    }
    return { ...base, threshold, members };
  } catch {
    return base;
  }
}

interface RpcTx {
  transaction: {
    message: {
      accountKeys: string[];
      instructions: { programIdIndex: number; accounts: number[] }[];
    };
  };
  meta: { loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
}
