import { getAccountBytes, isOnCurve, rpcUrl, type AuthorityClass, type Network } from "@onrecord/core";
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
  try {
    const owner = await getAccountOwner(network, authority);
    if (owner && SQUADS_PROGRAM_IDS.has(owner)) return "squads";
    if (owner && owner !== SYSTEM_PROGRAM) return "program";
  } catch {
    // network hiccup — fall through to the conservative read
  }
  return "hot_wallet";
}

async function getAccountOwner(network: Network, address: string): Promise<string | null> {
  // getAccountBytes returns data only; owner needs its own zero-data call.
  const res = await fetch(rpcUrl(network), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }],
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { result?: { value?: { owner?: string } | null } };
  return json.result?.value?.owner ?? null;
}

// Re-export so authority.ts owns everything "who controls it".
export { getAccountBytes };
