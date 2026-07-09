// Test a real funder tracer on a few deploy authorities from the snapshot.
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const KEY = process.env.HELIUS_API_KEY;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, t = 4) { let e; for (let i = 0; i < t; i++) { try { return await fn(); } catch (x) { e = x; await sleep(200 * 2 ** i); } } throw e; }
async function rpc(method, params) {
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (res.status === 429) throw new Error("429");
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// well-known Solana funding sources (hot wallets / bridges / programs)
const KNOWN = {
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9": "Binance",
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM": "Binance",
  H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS: "Coinbase",
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S": "Coinbase",
  GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE: "Coinbase",
  AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2: "Bybit",
  "9un5wqE3q4oCjyrDkwsdD48KteCJitQX5978Vh7KKxHo": "OKX",
  "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD": "OKX",
  A77HErqtfN1hLLpvZ9pCtu66FEtM8BveoaKbbMoZ4RiR: "Bitget",
  u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w: "Gate.io",
  "11111111111111111111111111111111": "System Program",
};

async function traceFunder(authority) {
  let before, oldest, pages = 0;
  while (pages++ < 8) {
    const sigs = await withRetry(() => rpc("getSignaturesForAddress", [authority, { limit: 1000, before }]));
    if (!sigs.length) break;
    oldest = sigs[sigs.length - 1];
    if (sigs.length < 1000) break;
    before = oldest.signature;
  }
  if (!oldest) return { funder: null, label: null, pages, txCountAtLeast: 0 };
  const tx = await withRetry(() => rpc("getTransaction", [oldest.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed", commitment: "confirmed" }]));
  if (!tx?.meta) return { funder: null, label: null, pages };
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const authIdx = keys.indexOf(authority);
  // funder = account with the largest SOL outflow in the authority's first tx
  let funder = null, worst = 0;
  for (let i = 0; i < keys.length; i++) {
    if (i === authIdx) continue;
    const d = tx.meta.postBalances[i] - tx.meta.preBalances[i];
    if (d < worst) { worst = d; funder = keys[i]; }
  }
  if (!funder) funder = keys[0];
  return { funder, label: KNOWN[funder] ?? null, outflowSol: (-worst / 1e9).toFixed(4), pages };
}

const snap = JSON.parse(readFileSync(new URL("../data/mainnet-snapshot.json", import.meta.url), "utf8"));
const sample = snap.programs.filter((p) => p.authority).slice(0, 8);
for (const p of sample) {
  const r = await traceFunder(p.authority);
  console.log(`${(p.name || p.programId.slice(0, 8)).padEnd(22)} auth ${p.authority.slice(0, 6)}… → funder ${r.funder ? r.funder.slice(0, 8) + "…" : "?"} ${r.label ? "(" + r.label + ")" : ""} ${r.outflowSol ? r.outflowSol + " SOL" : ""}`);
}
