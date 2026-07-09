// Crack open one "opaque" program: download its bytecode and show what's
// actually recoverable with no IDL and no source — printable strings.
//   node scripts/inspect.mjs <programId>
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].trim();
}
const core = await import("../packages/core/dist/index.js");
const { getProgramDataAddress, getAccountBytes, extractStrings } = core;

const programId = process.argv[2] || "DgBLc1GJpvwWdb9UbDDkMFPGMbC1sCvP5APgjC43AQp5";
const pda = await getProgramDataAddress("mainnet", programId);
const bytes = await getAccountBytes("mainnet", pda);
let end = bytes.length;
while (end > 45 && bytes[end - 1] === 0) end--;
const body = bytes.subarray(45, end);
const strings = extractStrings(body);

console.log(`program: ${programId}`);
console.log(`bytecode: ${(body.length / 1024).toFixed(0)} KB · ${strings.length} printable strings extracted\n`);

// the interesting ones: source file paths, error messages, identifiers
const paths = strings.filter((s) => /\.rs\b|\/src\/|instructions?\/|state\/|\.toml/i.test(s));
const words = strings.filter(
  (s) => /^[A-Za-z][A-Za-z0-9_ ]{5,60}$/.test(s) && !/\.rs\b/.test(s),
);
const urls = strings.filter((s) => /https?:\/\/|github|\.io|\.com|\.xyz/i.test(s));

const show = (label, arr) => {
  console.log(`── ${label} (${arr.length}) ──`);
  for (const s of [...new Set(arr)].slice(0, 25)) console.log("  " + s.slice(0, 90));
  console.log();
};
show("source file paths (leaked by Rust panics)", paths);
show("URLs / repos", urls);
show("identifiers / messages", words);
