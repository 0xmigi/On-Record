import { createHash } from "node:crypto";
import { getAccountBytes, isOnCurve, rpc, type AuthorityClass, type Network } from "@onrecord/core";
import bs58 from "bs58";

// ---------------------------------------------------------------------------
// Authority classification (spec §4.2): "who can change it".
//   none       — frozen, no upgrade authority
//   squads     — authority account owned by a Squads program (team key)
//   program    — authority is a PDA / program-owned account (governance)
//   hot_wallet — a plain on-curve wallet key (single-key control)
// ---------------------------------------------------------------------------

export const SQUADS_PROGRAM_IDS = new Set([
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf", // Squads v4
  "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu", // Squads v3
]);

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export async function classifyAuthority(
  network: Network,
  authority: string | null,
): Promise<AuthorityClass> {
  if (!authority) return "none";

  // Off-curve keys are PDAs — controlled by some program (governance et al).
  try {
    if (!isOnCurve(bs58.decode(authority))) return "program";
  } catch {
    return "program";
  }

  // On-curve: check the owner. A plain wallet is system-owned (or nonexistent);
  // a Squads vault/multisig signer account is owned by the Squads program.
  // Failures propagate: a network hiccup must fail the stage (and be retried),
  // not permanently brand the authority a hot wallet (0.2 vs 1.0 on scoring).
  const owner = await getAccountOwner(network, authority);
  if (owner && SQUADS_PROGRAM_IDS.has(owner)) return "squads";
  if (owner && owner !== SYSTEM_PROGRAM) return "program";
  return "hot_wallet";
}

// ---------------------------------------------------------------------------
// Squads multisig inspection. A Squads-governed program's upgrade authority is
// usually a vault PDA (off-curve, often with no account at all), so the owner
// check above can't see it — but the deploy/upgrade TRANSACTION carries the
// Squads program and the Multisig account. Decoding that account yields the
// threshold ("2-of-3"), the strongest governance fact we can show.
// Layout verified on mainnet (Kamino upgrade multisig → 5-of-10, 2026-07-09).
// ---------------------------------------------------------------------------

const SQUADS_V4 = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const SQUADS_V3 = "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu";
// Anchor account discriminator: sha256("account:Multisig")[0..8]
const MULTISIG_V4_DISC = createHash("sha256").update("account:Multisig").digest().subarray(0, 8);

export interface MultisigInfo {
  address: string;
  version: "v4" | "v3";
  /** null when detected but not decodable (v3 legacy layout) */
  threshold: number | null;
  members: number | null;
}

/** Given the deploy/upgrade transaction, find and decode the Squads multisig
 *  behind it. Returns null when the tx doesn't involve Squads. */
export async function inspectSquadsAuthority(
  network: Network,
  deployTxSignature: string,
): Promise<MultisigInfo | null> {
  try {
    const tx = await rpc<{
      transaction: { message: { accountKeys: string[] } };
    } | null>(network, "getTransaction", [
      deployTxSignature,
      { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" },
    ]);
    const keys = tx?.transaction.message.accountKeys ?? [];
    const hasV4 = keys.includes(SQUADS_V4);
    const hasV3 = keys.includes(SQUADS_V3);
    if (!hasV4 && !hasV3) return null;

    // find the Multisig account among the tx accounts (owner + discriminator)
    const infos = await rpc<{ value: ({ owner: string; data: [string, string] } | null)[] }>(
      network,
      "getMultipleAccounts",
      [keys, { encoding: "base64", dataSlice: { offset: 0, length: 132 }, commitment: "confirmed" }],
    );
    for (let i = 0; i < keys.length; i++) {
      const acc = infos.value[i];
      if (!acc) continue;
      if (hasV4 && acc.owner === SQUADS_V4) {
        const data = Buffer.from(acc.data[0], "base64");
        if (data.length >= 100 && data.subarray(0, 8).equals(MULTISIG_V4_DISC)) {
          // Multisig: disc 8 · create_key 32 · config_authority 32 · threshold u16
          // · time_lock u32 · transaction_index u64 · stale_transaction_index u64
          // · rent_collector Option<Pubkey> · bump u8 · members Vec<Member>
          const threshold = data.readUInt16LE(72);
          const rentTag = data[94];
          const membersOff = rentTag === 1 ? 128 : 96;
          const members = data.length >= membersOff + 4 ? data.readUInt32LE(membersOff) : null;
          return { address: keys[i]!, version: "v4", threshold, members };
        }
      }
      if (hasV3 && acc.owner === SQUADS_V3) {
        // legacy v3: report detection without decoding (layout differs) —
        // stating nothing beats stating a wrong threshold
        return { address: keys[i]!, version: "v3", threshold: null, members: null };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// core's rpc client handles retry/backoff and timeouts — no bespoke fetch here

async function getAccountOwner(network: Network, address: string): Promise<string | null> {
  // getAccountBytes returns data only; owner needs its own zero-data call.
  // Retried/timed out by core's client; null only for a genuinely absent
  // account, never for a failed request (that throws, and the stage retries).
  const result = await rpc<{ value?: { owner?: string } | null }>(network, "getAccountInfo", [
    address,
    { encoding: "base64", dataSlice: { offset: 0, length: 0 } },
  ]);
  return result?.value?.owner ?? null;
}

// Re-export so authority.ts owns everything "who controls it".
export { getAccountBytes };
