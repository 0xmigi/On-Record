import bs58 from "bs58";
import { findProgramAddress } from "./fingerprint.js";
import { rpc } from "./helius.js";
import { logger } from "./logger.js";
import type { Network } from "./types.js";

// ---------------------------------------------------------------------------
// Otter Verify — the on-chain half of the verified-build flow.
//
// Submitting a program for verification writes a PDA under this program holding
// the build recipe: git url, commit, and the CLI args to reproduce it. OtterSec's
// worker then builds from that recipe and compares hashes off-chain.
//
// So the PDA means "verification was REQUESTED", never "the build is verified".
// Measured on mainnet 2026-08-10: 914 programs have a PDA, only 481 of them are
// verified — nearly half the requests never produce a match. The registry, not
// this account, remains the authority on the answer.
//
// What it IS good for is knowing who to bother asking. 481 of the 485 verified
// programs have one, so its absence is a near-certain "don't poll this". That
// turns the verify sweep from "ask about every program forever" into "ask about
// the ones that actually asked".
//
// Layout (Anchor): 8-byte discriminator · address 32 (the program) ·
// signer 32 · then borsh strings — cli version, git url, commit, args.
// PDA seeds = ["otter_verify", signer, programId]; confirmed by re-deriving all
// 1,097 live accounts (1,096 matched, one legacy outlier).
//
// NOTE the signer is whoever uploaded the recipe, which is NOT reliably the
// program's current upgrade authority — only 50% of them match, because
// authorities rotate and teams upload from a deploy key. So a program's PDA
// cannot be derived from what we store; it has to be looked up by content.
// ---------------------------------------------------------------------------

export const OTTER_VERIFY_PROGRAM_ID = "verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC";

/** Offset of the verified program's pubkey inside the PDA (after the 8-byte
 *  Anchor discriminator). Used as the memcmp key for targeted lookups. */
const PROGRAM_FIELD_OFFSET = 8;

/** The full request set is ~1,100 accounts and one call fetches it in under a
 *  second when sliced to just the program pubkey. Cheaper by far than a lookup
 *  per program, so the sweep reads the whole set and tests membership. */
const CACHE_MS = 10 * 60 * 1000;

/** Canonical Otter Verify PDA for (program, signer). Exported for completeness
 *  and point checks — see the note above on why lookups don't rely on it. */
export function otterVerifyPda(programId: string, signer: string): string {
  return bs58.encode(
    findProgramAddress(
      [Buffer.from("otter_verify", "utf8"), bs58.decode(signer), bs58.decode(programId)],
      bs58.decode(OTTER_VERIFY_PROGRAM_ID),
    ),
  );
}

interface RpcAccount {
  account?: { data?: [string, string] };
}

const cache = new Map<Network, { value: Set<string>; at: number }>();

/** Every program that has ever submitted a build for verification, in one call.
 *  Returns an empty set on failure — callers must treat "empty" as "unknown",
 *  never as "nobody requested verification". */
export async function fetchVerifyRequests(network: Network): Promise<Set<string>> {
  const hit = cache.get(network);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  try {
    const accounts = await rpc<RpcAccount[]>(network, "getProgramAccounts", [
      OTTER_VERIFY_PROGRAM_ID,
      {
        encoding: "base64",
        // just the program pubkey — the recipe strings would be ~10x the bytes
        // for data we don't use here
        dataSlice: { offset: PROGRAM_FIELD_OFFSET, length: 32 },
      },
    ]);
    const ids = new Set<string>();
    for (const a of accounts ?? []) {
      const raw = a.account?.data?.[0];
      if (!raw) continue;
      const buf = Buffer.from(raw, "base64");
      if (buf.length === 32) ids.add(bs58.encode(buf));
    }
    if (!ids.size) return hit?.value ?? ids; // empty answer: keep the last good set
    cache.set(network, { value: ids, at: Date.now() });
    return ids;
  } catch (err) {
    logger.warn({ network, err: String(err) }, "otter-verify request set fetch failed");
    // don't cache the failure, and don't downgrade a good set to empty
    return hit?.value ?? new Set();
  }
}

/** Has this program submitted a build for verification? Point lookup by content,
 *  for the one-program case where fetching the whole set would be wasteful. */
export async function hasVerifyRequest(network: Network, programId: string): Promise<boolean> {
  try {
    const accounts = await rpc<RpcAccount[]>(network, "getProgramAccounts", [
      OTTER_VERIFY_PROGRAM_ID,
      {
        encoding: "base64",
        dataSlice: { offset: 0, length: 0 },
        filters: [{ memcmp: { offset: PROGRAM_FIELD_OFFSET, bytes: programId } }],
      },
    ]);
    return (accounts ?? []).length > 0;
  } catch (err) {
    logger.warn({ programId, err: String(err) }, "otter-verify point lookup failed");
    return false;
  }
}
