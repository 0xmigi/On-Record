// Try the program-id → source-repo lookup on one program, before it runs on
// every program. Prints the evidence, not just the verdict: what the binary
// leaked, what the pipeline would have skipped, which files matched, and how
// many other repos could have claimed the same link.
//
//   node scripts/repo-link.mjs <programId> [...more]
//
// Needs GITHUB_TOKEN (a token with no scopes is enough). HELIUS_API_KEY is used
// when present; otherwise the bytecode comes off the public RPC, so this runs
// with nothing but a GitHub token in the environment.
import { readFileSync } from "node:fs";

try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2].trim();
  }
} catch {
  // no .env here — env vars on the command line are fine
}

const core = await import("../packages/core/dist/index.js");
const { getProgramDataAddress, getAccountBytes, deriveBytecodeIdentity, searchRepoByProgramId } =
  core;

if (!process.env.GITHUB_TOKEN) {
  console.error("GITHUB_TOKEN is unset — the lookup no-ops without it.\n");
  console.error('  GITHUB_TOKEN="$(gh auth token)" node scripts/repo-link.mjs <programId>');
  process.exit(1);
}

const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

/** ProgramData bytes without Helius: one getAccountInfo, base64. */
async function publicProgramData(programId) {
  const call = async (method, params) => {
    const res = await fetch(PUBLIC_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await res.json()).result;
  };
  const program = await call("getAccountInfo", [programId, { encoding: "jsonParsed" }]);
  const pda = program?.value?.data?.parsed?.info?.programData;
  if (!pda) throw new Error("not an upgradeable program (no ProgramData account)");
  const data = await call("getAccountInfo", [pda, { encoding: "base64" }]);
  return Buffer.from(data.value.data[0], "base64");
}

async function programDataBytes(programId) {
  if (process.env.HELIUS_API_KEY) {
    const pda = await getProgramDataAddress("mainnet", programId);
    return getAccountBytes("mainnet", pda);
  }
  return publicProgramData(programId);
}

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error("usage: node scripts/repo-link.mjs <programId> [...more]");
  process.exit(1);
}

for (const programId of ids) {
  console.log(`\n━━ ${programId}`);
  let identity;
  try {
    const raw = await programDataBytes(programId);
    let end = raw.length;
    while (end > 45 && raw[end - 1] === 0) end--;
    identity = deriveBytecodeIdentity(raw.subarray(45, end));
  } catch (err) {
    console.log(`   bytecode unavailable: ${err.message}`);
    continue;
  }

  console.log(`   binary says   name=${identity.name ?? "—"} · crate=${identity.crate ?? "—"}`);
  const declared = identity.repoUrl;
  console.log(`   declared repo ${declared ?? "— (this is why the lookup runs)"}`);
  if (declared) {
    console.log("   → in the pipeline this program is SKIPPED; forcing the lookup anyway");
  }

  const started = Date.now();
  const link = await searchRepoByProgramId(programId, {
    crateName: identity.crate,
    bustCache: true,
    maxWaitMs: 30_000,
  });
  const ms = Date.now() - started;

  if (!link) {
    console.log(`   → no repo linked (${ms}ms) — nothing survived the both-directions test`);
    continue;
  }
  console.log(`   → ${link.repoUrl}  (${ms}ms)`);
  console.log(
    `     method=${link.method} · crate confirmed=${link.crateConfirmed} · ` +
      `files=${link.matchCount} · other candidates=${link.otherCandidates}`,
  );
  for (const p of link.matchedPaths) console.log(`       ${p}`);
}
console.log();
