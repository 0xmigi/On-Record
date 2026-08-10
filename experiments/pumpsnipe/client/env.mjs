// Find the Helius key without anyone having to export it first.
//
// Every script here needs mainnet RPC, and requiring `HELIUS_API_KEY=...` in
// front of each command is a trap: forget it and you get
// `401 Unauthorized` from deep inside web3.js, which reads like a broken script
// rather than a missing variable. The key already lives in the repo's gitignored
// .env, so just read it.
//
// Import this before anything that builds a Connection.

import fs from 'node:fs';

const CANDIDATES = [
  new URL('../../../.env', import.meta.url).pathname,   // repo root
  new URL('../.env', import.meta.url).pathname,         // experiment dir
];

if (!process.env.HELIUS_API_KEY) {
  for (const path of CANDIDATES) {
    if (!fs.existsSync(path)) continue;
    const line = fs.readFileSync(path, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('HELIUS_API_KEY='));
    if (!line) continue;
    const value = line.slice('HELIUS_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
    if (value) { process.env.HELIUS_API_KEY = value; break; }
  }
}

if (!process.env.HELIUS_API_KEY) {
  console.error(
    'No HELIUS_API_KEY found.\n' +
    'Looked in: ' + CANDIDATES.join(', ') + '\n' +
    'Set it in the repo .env, or run with HELIUS_API_KEY=... in front of the command.');
  process.exit(1);
}

export const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
export const MAINNET_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
