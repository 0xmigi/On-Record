import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { LOADER_PROGRAM_ID } from "@onrecord/core";
import {
  bulkHistoryRefused,
  isPlanRefusal,
  programDataOf,
  resetBulkRefusal,
  walkLoaderHistory,
  type RpcCall,
} from "./loader-history.js";

// The loader walk on a Helius plan without getTransactionsForAddress (Free,
// from 23 Oct 2026): a long history must still be read, one getTransaction at a
// time, capped, and the refusal paid for once per process, not once per walk.

const PROGRAM = "5yv9aXx1vjRoCH1Ubxi7RNQggv9NHXxZC7zwUKLG4jYi";
const PD = programDataOf(PROGRAM);
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const sig = (slot: number) => `sig${slot}`;

/** slot 1 deploys, every 10th slot upgrades, the rest pass the ProgramData in */
function tx(slot: number) {
  const type = slot === 1 ? "deployWithMaxDataLen" : slot % 10 === 0 ? "upgrade" : null;
  return {
    slot,
    blockTime: 1_760_000_000 + slot,
    version: 0 as const,
    meta: { err: null, innerInstructions: [] },
    transaction: {
      signatures: [sig(slot)],
      message: {
        accountKeys: [{ pubkey: PAYER, signer: true }],
        instructions: type
          ? [{ programId: LOADER_PROGRAM_ID, parsed: { type, info: { programDataAccount: PD, authority: PAYER } } }]
          : [{ programId: PROGRAM, accounts: [PD], data: "1" }],
      },
    },
  };
}

/** A fake Helius over a history of `n` transactions at slots 1..n. `bulk` is
 *  what getTransactionsForAddress does: refuse with a message, or serve. */
function chain(n: number, bulk: { refuse: string } | "serve") {
  const calls: Record<string, number> = {};
  const newestFirst = Array.from({ length: n }, (_, i) => n - i);
  const call: RpcCall = async <T>(method: string, params: unknown[]): Promise<T> => {
    calls[method] = (calls[method] ?? 0) + 1;
    const o = params[1] as Record<string, unknown>;
    if (method === "getSignaturesForAddress") {
      let list = newestFirst;
      if (o.until) list = list.slice(0, list.indexOf(Number(String(o.until).slice(3))));
      if (o.before) list = list.slice(list.indexOf(Number(String(o.before).slice(3))) + 1);
      return list.slice(0, o.limit as number).map((slot) => ({ signature: sig(slot), slot })) as T;
    }
    if (method === "getTransactionsForAddress") {
      if (bulk !== "serve") throw new Error(`helius rpc getTransactionsForAddress: ${bulk.refuse}`);
      const start = o.paginationToken ? Number(o.paginationToken) : 1;
      const end = Math.min(n, start + (o.limit as number) - 1);
      const data = [];
      for (let s = start; s <= end; s++) data.push(tx(s));
      return { data, paginationToken: end < n ? String(end + 1) : null } as T;
    }
    if (method === "getTransaction") return tx(Number(String(params[0]).slice(3))) as T;
    throw new Error(`unexpected ${method}`);
  };
  return { call, calls };
}

beforeEach(() => resetBulkRefusal());

test("a refused bulk read falls back to getTransaction, oldest first, and finds the same rows", async () => {
  const { call, calls } = chain(50, { refuse: "HTTP 403" });
  const w = await walkLoaderHistory("mainnet", PROGRAM, { rpc: call });

  assert.equal(w.walk.status, "complete");
  assert.equal(w.walk.signatures, 50);
  assert.equal(calls.getTransaction, 50);
  // a deploy and 5 upgrades; the other 44 only passed the account in
  assert.deepEqual(
    w.rows.map((r) => r.kind),
    ["deploy", "upgrade", "upgrade", "upgrade", "upgrade", "upgrade"],
  );
  assert.equal(w.walk.nonLoader, 44);
  assert.equal(w.walk.oldestSlot, 1);
  assert.equal(w.walk.newestSlot, 50);
  assert.equal(w.walk.newestSignature, sig(50));
  assert.equal(w.credits, 1 + 50); // the signature page, then one per transaction
  assert.equal(bulkHistoryRefused(), true);
});

test("the refusal is remembered: the next long walk never asks for the bulk read", async () => {
  await walkLoaderHistory("mainnet", PROGRAM, { rpc: chain(20, { refuse: "HTTP 403" }).call });
  const { call, calls } = chain(30, { refuse: "HTTP 403" });
  const w = await walkLoaderHistory("mainnet", PROGRAM, { rpc: call });
  assert.equal(calls.getTransactionsForAddress, undefined);
  assert.equal(w.walk.status, "complete");
  assert.equal(w.walk.signatures, 30);
});

test("the fallback is capped at the caller's bulk credit ceiling, keeps the genesis, and says truncated", async () => {
  // 2 bulk calls = 20 credits = 20 reads
  const { call, calls } = chain(50, { refuse: "This method is not available on the free plan" });
  const w = await walkLoaderHistory("mainnet", PROGRAM, { rpc: call, maxBulkCalls: 2 });
  assert.equal(w.walk.status, "truncated");
  assert.equal(calls.getTransaction, 20);
  assert.equal(w.walk.signatures, 20);
  assert.equal(w.walk.oldestSlot, 1);
  assert.equal(w.walk.newestSlot, 20);
  assert.equal(w.rows[0]!.kind, "deploy");
});

test("the fallback pages signatures past the first 1000 and stops at 500 reads by default", async () => {
  const { call, calls } = chain(2_500, { refuse: "HTTP 403" });
  const w = await walkLoaderHistory("mainnet", PROGRAM, { rpc: call });
  assert.equal(calls.getSignaturesForAddress, 3);
  assert.equal(calls.getTransaction, 500);
  assert.equal(w.walk.status, "truncated");
  assert.equal(w.walk.oldestSlot, 1); // the listing reached the bottom, so genesis was read
  assert.equal(w.walk.newestSlot, 500);
  assert.equal(w.credits, 3 + 500);
});

test("an incremental fallback walk reads only what landed after the last one", async () => {
  const { call, calls } = chain(60, { refuse: "HTTP 403" });
  const w = await walkLoaderHistory("mainnet", PROGRAM, { rpc: call, from: { signature: sig(40), slot: 40 } });
  assert.equal(w.walk.status, "complete");
  assert.equal(calls.getTransaction, 20);
  assert.equal(w.walk.oldestSlot, 41);
  assert.equal(w.walk.newestSlot, 60);
  assert.deepEqual(
    w.rows.map((r) => r.slot),
    [50, 60],
  );
});

test("on a plan that serves the bulk read, nothing changes", async () => {
  const { call, calls } = chain(250, "serve");
  const w = await walkLoaderHistory("mainnet", PROGRAM, { rpc: call });
  assert.equal(w.walk.status, "complete");
  assert.equal(calls.getTransactionsForAddress, 3);
  assert.equal(calls.getTransaction, undefined);
  assert.equal(w.walk.signatures, 250);
  assert.equal(w.credits, 1 + 3 * 10);
  assert.equal(bulkHistoryRefused(), false);
});

test("a transient bulk failure is an error walk, not a refusal", async () => {
  const { call, calls } = chain(50, { refuse: "HTTP 429 (after 5 attempts)" });
  const w = await walkLoaderHistory("mainnet", PROGRAM, { rpc: call });
  assert.equal(w.walk.status, "error");
  assert.equal(w.rows.length, 0);
  assert.equal(calls.getTransaction, undefined);
  assert.equal(bulkHistoryRefused(), false);
});

test("what counts as the plan refusing the method", () => {
  for (const msg of [
    "helius rpc getTransactionsForAddress: HTTP 403",
    "helius rpc getTransactionsForAddress: HTTP 401",
    "helius rpc getTransactionsForAddress: Method not found",
    "helius rpc getTransactionsForAddress: getTransactionsForAddress is only available on paid plans",
    "helius rpc getTransactionsForAddress: Please upgrade to access this method",
    "helius rpc getTransactionsForAddress: method not supported",
  ]) {
    assert.equal(isPlanRefusal(new Error(msg)), true, msg);
  }
  for (const msg of [
    "helius rpc getTransactionsForAddress: HTTP 429 (after 5 attempts)",
    "helius rpc getTransactionsForAddress: HTTP 503 (after 5 attempts)",
    "helius rpc getTransactionsForAddress: HTTP 400",
    "TypeError: fetch failed",
    "TimeoutError: The operation was aborted due to timeout",
  ]) {
    assert.equal(isPlanRefusal(new Error(msg)), false, msg);
  }
});
