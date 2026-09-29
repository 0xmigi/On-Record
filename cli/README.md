# onrecord

Explains why a Solana program isn't verified, and prints the commands that fix it.

```text
onrecord verify <program-id>
```

It builds nothing and needs no Docker. It reads the program and its verification
uploads from chain, asks OtterSec what its builder did with each upload, and checks
that the source each one points at still exists:

| check     | question                                                                   |
| --------- | -------------------------------------------------------------------------- |
| `current` | Does the recipe describe the bytes on chain now, or a deploy from before an upgrade? |
| `source`  | Do the repo and commit it points at still exist on GitHub?                  |
| `signer`  | Was it uploaded by the program's current upgrade authority?                |
| `build`   | Did OtterSec ever build it, and did the bytes match?                        |

Then it names the problem and prints the `solana-verify` commands for it. Only a
genuine build mismatch needs a rebuild to go further, and for that it hands you the
exact local command.

## Usage

```text
onrecord verify <program-id | on-record.azuolas.xyz/p/<id>> [-u <rpc>] [--json]
```

- `-u, --url`: RPC endpoint or moniker (`mainnet`, `devnet`). Defaults to mainnet, or `$SOLANA_RPC_URL`.
- `--json`: the full report as JSON.
- `GITHUB_TOKEN`: optional. Unauthenticated GitHub checks are limited to 60 an hour.

Exit code 0 means verified, so it can gate a CI step.

## Running it from this repo

The checks live in `packages/core/src/verify/`, which also serves the Verified column
on program pages. The CLI is the terminal front end: it sits outside the pnpm
workspace, so it never touches the API or web builds, and the code it runs has no
dependencies. Build core once, then run it from the repo root:

```bash
pnpm install
packages/core/node_modules/.bin/tsc -p packages/core
node cli/src/cli.ts verify <program-id>
```

That needs Node 22.18 or newer, which runs TypeScript directly. `tsc -p cli` builds
`cli/dist` for older versions.

## Why these checks

Measured on mainnet on 2026-09-25: 1,028 programs have uploaded a verification recipe,
534 are verified, and 318 of the rest have since been closed. Run over the 175 live
programs that tried and never matched:

| diagnosis                                                         | programs |
| ----------------------------------------------------------------- | -------: |
| recipe describes a deploy the program has since upgraded past      |      107 |
| uploaded but never built (the `remote submit-job` step was skipped) |       28 |
| repo or commit no longer on GitHub                                 |       16 |
| genuine hash mismatch (needs a rebuild to diagnose)                |       24 |

That's 151 of 175 explained without building anything.
