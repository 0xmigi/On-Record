// Feasibility probe: can we enumerate ProgramData accounts off the loader?
// Reports count + payload size + elapsed for a header-only (45-byte) slice.
import { readFileSync } from "node:fs";

const KEY = readFileSync(new URL("../.env", import.meta.url), "utf8")
  .split("\n")
  .find((l) => l.startsWith("HELIUS_API_KEY="))
  .split("=")[1]
  .trim();

const URL_ = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  let num = BigInt("0x" + Buffer.from(bytes).toString("hex").padStart(2, "0"));
  let out = "";
  while (num > 0n) { out = B58[Number(num % 58n)] + out; num /= 58n; }
  for (const b of bytes) { if (b === 0) out = "1" + out; else break; }
  return out || "1";
}
const PROGRAMDATA_TAG = b58(Buffer.from([3, 0, 0, 0]));

async function rpc(method, params) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, bytes: text.length, text };
}

console.log("tag base58:", PROGRAMDATA_TAG);
console.log("verifying key…");
const v = await rpc("getVersion", []);
console.log("getVersion:", v.status, v.text.slice(0, 120));
const s = await rpc("getSlot", [{ commitment: "confirmed" }]);
console.log("getSlot:", s.text.slice(0, 120));

console.log("\nenumerating ProgramData accounts (dataSlice 45 bytes)… this may be big/slow");
const t0 = Date.now();
const r = await rpc("getProgramAccounts", [
  LOADER,
  {
    encoding: "base64",
    filters: [{ memcmp: { offset: 0, bytes: PROGRAMDATA_TAG } }],
    dataSlice: { offset: 0, length: 45 },
    commitment: "confirmed",
  },
]);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
if (!r.ok) {
  console.log(`FAILED status=${r.status} in ${elapsed}s:`, r.text.slice(0, 300));
} else {
  const json = JSON.parse(r.text);
  const arr = json.result ?? [];
  console.log(`OK: ${arr.length.toLocaleString()} ProgramData accounts, ${(r.bytes / 1e6).toFixed(1)} MB, ${elapsed}s`);
  // decode slots to find the recent window
  const now = Date.now();
  const slotsPerSec = 2.5;
  let recent48h = 0, withAuth = 0;
  let minSlot = Infinity, maxSlot = 0;
  for (const row of arr) {
    const buf = Buffer.from(row.account.data[0], "base64");
    if (buf.length < 45 || buf.readUInt32LE(0) !== 3) continue;
    const slot = Number(buf.readBigUInt64LE(4));
    if (slot < minSlot) minSlot = slot;
    if (slot > maxSlot) maxSlot = slot;
    if (buf[12] === 1) withAuth++;
  }
  const cutoff48 = maxSlot - 48 * 3600 * slotsPerSec;
  for (const row of arr) {
    const buf = Buffer.from(row.account.data[0], "base64");
    if (buf.length < 45 || buf.readUInt32LE(0) !== 3) continue;
    const slot = Number(buf.readBigUInt64LE(4));
    if (slot >= cutoff48) recent48h++;
  }
  console.log(`slot range: ${minSlot.toLocaleString()} … ${maxSlot.toLocaleString()}`);
  console.log(`with upgrade authority: ${withAuth.toLocaleString()} (${((withAuth / arr.length) * 100).toFixed(1)}%) · immutable: ${(arr.length - withAuth).toLocaleString()}`);
  console.log(`deployed/upgraded in last ~48h (by last-deploy slot): ${recent48h.toLocaleString()}`);
}
