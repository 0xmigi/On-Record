// Which key signs.
//
// Deliberately NOT the machine's default `~/.config/solana/id.json`. That key is
// what every bare `solana` command uses, and a program that signs automatically
// in a loop should have a blast radius of exactly its trading capital. It also
// keeps the identity that ends up in a published run log separate from the one
// used for everything else.
//
// Resolution order:
//   KEYPAIR=<path>            explicit, always wins
//   ../sniper-keypair.json    the dedicated key, gitignored
//   ~/.config/solana/id.json  last resort, and it says so out loud

import fs from 'node:fs';
import os from 'node:os';
import { Keypair } from '@solana/web3.js';

const DEDICATED = new URL('../sniper-keypair.json', import.meta.url).pathname;
const CLI_DEFAULT = `${os.homedir()}/.config/solana/id.json`;

export function resolveKeypairPath() {
  if (process.env.KEYPAIR) return { path: process.env.KEYPAIR, kind: 'KEYPAIR env' };
  if (fs.existsSync(DEDICATED)) return { path: DEDICATED, kind: 'dedicated' };
  return { path: CLI_DEFAULT, kind: 'CLI DEFAULT' };
}

export function loadPayer() {
  const { path, kind } = resolveKeypairPath();
  if (!fs.existsSync(path)) throw new Error(`no keypair at ${path}`);
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8'))));
  return { payer, path, kind };
}
