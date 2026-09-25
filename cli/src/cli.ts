#!/usr/bin/env node
import { isAddress } from "../../packages/core/dist/verify/chain.js";
import { diagnose } from "../../packages/core/dist/verify/doctor.js";
import { render } from "./render.ts";

// ---------------------------------------------------------------------------
// onrecord — command-line tools from On Record.
//
//   onrecord verify <program-id | on-record link> [--url <rpc>] [--json]
//
// Exit code 0 means verified; anything else means it isn't (or couldn't be
// checked), so the command can gate a CI step.
// ---------------------------------------------------------------------------

const USAGE = `usage: onrecord verify <program-id> [--url <rpc>] [--json]

Explains why a Solana program isn't verified, without building anything:
whether its recipe is stale, its source still exists, the right key signed it,
and what OtterSec's builder made of it. Then prints the commands that fix it.

  <program-id>     a program address, or an on-record.azuolas.xyz/p/<id> link
  -u, --url <rpc>  RPC endpoint or moniker (mainnet, devnet); default mainnet,
                   or $SOLANA_RPC_URL
  --json           print the report as JSON

  GITHUB_TOKEN     optional; raises GitHub's 60 requests/hour limit`;

const MONIKERS: Record<string, string> = {
  m: "https://api.mainnet-beta.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  d: "https://api.devnet.solana.com",
  devnet: "https://api.devnet.solana.com",
  t: "https://api.testnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  l: "http://127.0.0.1:8899",
  localhost: "http://127.0.0.1:8899",
};

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (command !== "verify") fail(`unknown command: ${command}`);

  let target: string | undefined;
  let url = process.env.SOLANA_RPC_URL || MONIKERS.mainnet!;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--json") json = true;
    else if (arg === "-u" || arg === "--url") {
      const value = rest[++i];
      if (!value) fail(`${arg} needs a value`);
      url = MONIKERS[value] ?? value;
    } else if (arg.startsWith("-")) fail(`unknown option: ${arg}`);
    else if (!target) target = arg;
    else fail(`unexpected argument: ${arg}`);
  }
  if (!target) fail("missing program id");

  // an On Record program link works as well as a bare id
  const programId = target.match(/\/p\/([1-9A-HJ-NP-Za-km-z]{32,44})/)?.[1] ?? target;
  if (!isAddress(programId)) fail(`not a Solana address: ${target}`);

  const report = await diagnose(programId, { rpcUrl: url, githubToken: process.env.GITHUB_TOKEN });
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`);
  return report.status === "verified" ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`onrecord: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  },
);
