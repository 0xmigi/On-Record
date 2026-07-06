import bs58 from "bs58";
import { LOADER_PROGRAM_ID, logger, type ChainEventType } from "@onrecord/core";

// ---------------------------------------------------------------------------
// BPF Upgradeable Loader instruction decoding (spec §3). Helius enhanced
// webhooks deliver parsed transactions; we walk top-level and inner
// instructions, keep the loader ones, and decode the bincode u32 discriminator.
//
// Loader instruction enum:
//   0 InitializeBuffer   (staging noise — ignored)
//   1 Write              (staging noise — ignored)
//   2 DeployWithMaxDataLen
//   3 Upgrade
//   4 SetAuthority
//   5 Close
//   6 ExtendProgram      (logged, not recorded)
//   7 SetAuthorityChecked
// ---------------------------------------------------------------------------

export interface HeliusInstruction {
  accounts: string[];
  data: string; // base58
  programId: string;
  innerInstructions?: HeliusInstruction[];
}

export interface HeliusEnhancedTx {
  signature: string;
  slot: number;
  timestamp?: number;
  transactionError?: unknown;
  instructions: HeliusInstruction[];
}

export interface ParsedLoaderEvent {
  type: ChainEventType;
  signature: string;
  instructionIndex: number;
  slot: number;
  blockTime: Date | null;
  programId: string | null; // null when only the ProgramData address is known
  programDataAddress: string | null;
  authorityBefore: string | null;
  authorityAfter: string | null;
}

export function parseWebhookPayload(payload: unknown): ParsedLoaderEvent[] {
  const txs = Array.isArray(payload) ? (payload as HeliusEnhancedTx[]) : [];
  const out: ParsedLoaderEvent[] = [];
  for (const tx of txs) {
    if (!tx || typeof tx.signature !== "string" || tx.transactionError) continue;
    let index = 0;
    const walk = (ins: HeliusInstruction[]) => {
      for (const ix of ins) {
        const myIndex = index++;
        if (ix.programId === LOADER_PROGRAM_ID) {
          const parsed = parseLoaderInstruction(tx, ix, myIndex);
          if (parsed) out.push(parsed);
        }
        if (ix.innerInstructions?.length) walk(ix.innerInstructions);
      }
    };
    walk(tx.instructions ?? []);
  }
  return out;
}

function parseLoaderInstruction(
  tx: HeliusEnhancedTx,
  ix: HeliusInstruction,
  instructionIndex: number,
): ParsedLoaderEvent | null {
  let disc: number;
  try {
    const data = bs58.decode(ix.data ?? "");
    if (data.length < 4) return null;
    disc = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
  } catch {
    return null;
  }

  const a = ix.accounts ?? [];
  const base = {
    signature: tx.signature,
    instructionIndex,
    slot: tx.slot,
    blockTime: tx.timestamp ? new Date(tx.timestamp * 1000) : null,
  };

  switch (disc) {
    case 0: // InitializeBuffer
    case 1: // Write
      return null; // staging noise (spec §3)
    case 2: // DeployWithMaxDataLen: [payer, programdata, program, buffer, rent, clock, system, authority]
      return {
        ...base,
        type: "deploy",
        programId: a[2] ?? null,
        programDataAddress: a[1] ?? null,
        authorityBefore: null,
        authorityAfter: a[7] ?? null,
      };
    case 3: // Upgrade: [programdata, program, buffer, spill, rent, clock, authority]
      return {
        ...base,
        type: "upgrade",
        programId: a[1] ?? null,
        programDataAddress: a[0] ?? null,
        authorityBefore: a[6] ?? null,
        authorityAfter: a[6] ?? null,
      };
    case 4: // SetAuthority: [account, current authority, (new authority)]
    case 7: // SetAuthorityChecked: [account, current authority, new authority]
      return {
        ...base,
        type: "set_authority",
        programId: null, // account 0 is the ProgramData (or buffer) address; resolved later
        programDataAddress: a[0] ?? null,
        authorityBefore: a[1] ?? null,
        authorityAfter: a[2] ?? null,
      };
    case 5: // Close: [account, recipient, (authority), (program)]
      return {
        ...base,
        type: "close",
        programId: a[3] ?? null,
        programDataAddress: a[0] ?? null,
        authorityBefore: a[2] ?? null,
        authorityAfter: null,
      };
    default:
      // Loader-v4 / unknown discriminators are out of scope but logged (spec §3)
      logger.info({ disc, signature: tx.signature }, "unknown loader discriminator");
      return null;
  }
}
