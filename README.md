# ⊙ On Record

On Record tracks every program deployed or upgraded on Solana (mainnet + devnet) by
watching the BPF Upgradeable Loader. It shows what each program is, where its
code came from, and whether that code matches its source.

[on-record.azuolas.xyz](https://on-record.azuolas.xyz)

## What it shows and why

Block explorers focus on transactions and on-chain activity, but give a poor
overview of programs. On Record focuses on programs, and treats each one as a
project, or a module of one.

It reads each program's binary to work out its shape: the framework used, the
instructions, the source file names, and which other programs share its code.
Most new programs publish no IDL or repo, so this is often the only way to see
inside them.

The page also shows whether each version is verified. If the current version
isn't, it says why and how to fix it. If an upgrade broke the verification, it
shows which one.

For LLMs, the same page is available as plain text at
`on-record-api-production.up.railway.app/api/programs/<id>/dossier.md`.

## Verification

A program on chain is compiled bytecode that nobody can read. Its repo and its
audit describe source code. Verification proves the program on chain was built
from that source: someone rebuilds it and gets the same bytes.

Without it, you're trusting the team's word that the code you can read is the
code that runs. And since most Solana programs are upgradeable, that code can
change at any time.

Under 3% of upgradeable programs on mainnet are verified. It's slow to do, it
fails with no explanation, and it quietly lapses every time a program upgrades.
On Record aims to make it easy to do and hard to let lapse.

175 live programs tried to get verified and failed. On Record can explain 151
of them:

| Why it failed | Programs |
|---|---|
| The program was upgraded after the verification was submitted | 107 |
| The verification was submitted but never built | 28 |
| The repo or commit no longer exists | 16 |
| The build doesn't match, cause unknown | 24 |

Measured on mainnet, 25 Sep 2026.

## What's next

- Alerts when an upgrade breaks a program's verification, and when it's fixed.
- A command-line check that can run in CI.
- One command to build, deploy and verify a program, with every upgrade
  re-verified automatically.
- Permanent storage of each version's source, so anyone can rebuild it later.

To run it yourself, see [docs/DEPLOY.md](docs/DEPLOY.md).
