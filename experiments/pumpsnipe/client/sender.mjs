// Submission via Helius Sender.
//
// Sender forwards a transaction to validators and Jito at once, rather than
// letting it queue behind the normal RPC path. Unlike LaserStream it is on
// every plan including free, so this half of the upgrade is actually available
// to us.
//
// Its two conditions, from the docs and enforced on their side:
//   - a priority fee (setComputeUnitPrice) is mandatory, not advisory
//   - a tip must be transferred to one of ten designated accounts, inside the
//     same transaction. 0.001 SOL gets full routing; 0.000005 SOL gets the
//     SWQOS-only path; in between is best effort through fewer routes.
//
// The tip being inside the transaction is what makes this affordable. A snipe
// that loses the race reverts, and a reverted transaction rolls back the tip
// transfer with everything else — so tips are only ever paid on snipes that
// actually landed. A lost race costs the fee alone.

import {
  PublicKey, SystemProgram, VersionedTransaction, TransactionMessage,
} from '@solana/web3.js';

/// Sender's designated tip accounts, mainnet-beta.
export const TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
].map((k) => new PublicKey(k));

export const REGIONS = {
  slc: 'http://slc-sender.helius-rpc.com/fast',
  ewr: 'http://ewr-sender.helius-rpc.com/fast',
  lon: 'http://lon-sender.helius-rpc.com/fast',
  fra: 'http://fra-sender.helius-rpc.com/fast',
  ams: 'http://ams-sender.helius-rpc.com/fast',
  sg:  'http://sg-sender.helius-rpc.com/fast',
  tyo: 'http://tyo-sender.helius-rpc.com/fast',
};

/// Full-routing minimum. Below this Sender drops to fewer pathways.
export const MIN_TIP_LAMPORTS = 1_000_000;

export function tipInstruction(payer, lamports = MIN_TIP_LAMPORTS) {
  const to = TIP_ACCOUNTS[(Math.random() * TIP_ACCOUNTS.length) | 0];
  return SystemProgram.transfer({ fromPubkey: payer, toPubkey: to, lamports });
}

/**
 * Time each region with a real request and keep the fastest. Sender rejects
 * anything that isn't a transaction, so an invalid payload is enough to
 * measure the round trip — we want the network path, not a health check.
 */
export async function pickRegion({ samples = 3, verbose = false } = {}) {
  if (process.env.SENDER_REGION) {
    const r = process.env.SENDER_REGION;
    if (!REGIONS[r]) throw new Error(`unknown SENDER_REGION ${r}`);
    return { region: r, url: REGIONS[r], ms: null };
  }
  const results = [];
  for (const [region, url] of Object.entries(REGIONS)) {
    const times = [];
    for (let i = 0; i < samples; i++) {
      const t = Date.now();
      try {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
          signal: AbortSignal.timeout(5_000),
        });
        times.push(Date.now() - t);
      } catch { /* unreachable region, leave it out */ }
    }
    if (times.length) {
      results.push({ region, url, ms: Math.min(...times) });
    }
  }
  results.sort((a, b) => a.ms - b.ms);
  if (verbose) {
    for (const r of results) console.log(`  ${r.region.padEnd(4)} ${r.ms} ms`);
  }
  if (!results.length) throw new Error('no Sender region reachable');
  return results[0];
}

/**
 * Build, sign and serialise a v0 transaction.
 *
 * v0 rather than legacy because the account list is already 27 entries before
 * the ATA creates and the tip, and legacy runs out of room.
 */
export function buildSigned(payer, instructions, blockhash) {
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  return tx;
}

/**
 * Fire at Sender. Returns the signature — Sender does not confirm, so
 * confirmation is somebody else's problem (see `confirm`).
 */
export async function sendViaSender(url, tx, { skipPreflight = true } = {}) {
  const wire = Buffer.from(tx.serialize()).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'sendTransaction',
      params: [wire, { encoding: 'base64', skipPreflight, maxRetries: 0 }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json().catch(() => null);
  if (!j) throw new Error(`sender returned ${res.status} with no body`);
  if (j.error) throw new Error(`sender: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

/**
 * Submit through an ordinary RPC instead of Sender.
 *
 * Used against a local fork, where Sender is not merely unnecessary but
 * dangerous: it forwards to mainnet, so a run pointed at the fork would send
 * real transactions to the real chain. The caller picks this path by RPC URL,
 * which makes "local means local" a property of the code rather than of
 * whoever is typing the environment variables.
 */
export async function sendViaRpc(conn, tx, { skipPreflight = true } = {}) {
  return conn.sendRawTransaction(tx.serialize(), { skipPreflight, maxRetries: 0 });
}

/** Is this RPC a local fork rather than the real chain? */
export function isLocal(url) {
  return /^(https?:\/\/)?(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(url);
}

/** Poll the normal RPC until the signature resolves either way. */
export async function confirm(conn, sig, { timeoutMs = 30_000, everyMs = 400 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const st = await conn.getSignatureStatuses([sig]).catch(() => null);
    const v = st?.value?.[0];
    if (v) {
      if (v.err) return { landed: false, err: v.err, status: v };
      if (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') {
        return { landed: true, status: v };
      }
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return { landed: false, err: 'timeout' };
}

/** Serialised size, so we find out about the 1232-byte limit before a run. */
export function wireSize(tx) {
  return tx.serialize().length;
}
