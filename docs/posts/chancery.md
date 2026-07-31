# Chancery — draft post

**Program:** `ChnryP5RcZtMvP8vvVyPGUhwCg6uDJc53vCe3sxr11Sz`
**Status:** SHIPPED 2026-07-28
**Researched:** 2026-07-28 (deployed same day)

---

## Posted version

amateur sleuth find:

USDv might be getting more freezable?

last night someone deployed a program 'chancery' with an ability called
migrate_legacy_to_token2022

token2022 is the newer token format and migrating is not unusual. it has
optional switches. this program turns on the more tradfi looking ones:

> freeze your account
> move your balance without your signature
> new accounts arrive frozen until someone approves you

currently USDv's mint has no freeze authority. it is set to null so nobody can
freeze anything.

migrating a token to the chancery program would change this

is it USDv? the program's own security page names solomon dao llc. solomon
makes USDv. the migration form asks for two things, the old mint and the old
program. USDv has both, in the right shape

pre-announcement or inconsequential, i don't know but interesting to see
on-chain

*(reply: program id + on-record dossier link)*

**Benign reading that survived to the end:** Chancery may simply be the
Programmable Monetary Policy engine described in Solomon's own
"USDv for Businesses" docs — pathway/fee/limit/usage-window/evidence modules
map onto it closely, with the Token-2022 extension set as table stakes rather
than the point. The posted closer leaves room for this deliberately.

---

## Draft A — short (recommended)

there are 1.5m usdv on solana right now and nobody can freeze them. the mint's
freeze authority is null.

a program showed up on mainnet overnight that would change that.

`ChnryP5RcZtMvP8vvVyPGUhwCg6uDJc53vCe3sxr11Sz`

unverified, no repo, but it ships an idl and a security policy page — and the
policy page names solomon dao llc. solomon issues usdv.

two of its instructions are enable_legacy_migration and
migrate_legacy_to_token2022, and the config they write identifies the old token
by exactly two things: its mint, and the program that controls it. usdv is a
legacy spl mint controlled by a program from dec 2024. it fits.

what it migrates into is a token where the issuer holds permanent-delegate,
freeze, and default-account-state. in english: they can freeze your account,
move your balance without your signature, and new accounts show up frozen until
someone approves them.

none of that is possible against usdv today.

the whole thing sits under one hot wallet, and not one of its 70 instructions
has ever been called.

---

## Draft A-long — forensic version (kept for reference)

there are 1.5m usdv on solana and nobody can freeze them. the freeze authority
on the mint is null.

a program that deployed to mainnet overnight changes that.

`ChnryP5RcZtMvP8vvVyPGUhwCg6uDJc53vCe3sxr11Sz`

native rust, 1mb, unverified, no repo. it panics with full source paths, so the
module tree falls straight out of the binary:

settlement/ — mint_direct, mint_trilateral, redeem_direct, redeem_trilateral
control/ — freeze_issued_token_account
limits/ — register_limit_policy, usage_window
evidence/ — evidence_policy
cross_chain/ — emit_outbound_message, consume_inbound_message

two of its 70 instructions are enable_legacy_migration and
migrate_legacy_to_token2022. the struct they write has exactly two identifying
fields: legacy_mint and legacy_program.

how i get from there to usdv: the policy link in its security.txt names solomon
dao llc, solomon issues usdv, and usdv is a legacy spl mint whose mint
authority is a pda of a program from dec 2024. mint plus program — that's the
pair the struct wants. no wallet overlap, just their own document and the fit.

the token-2022 authorities chancery wires up on the other side:
permanent-delegate, default-account-state, confidential-transfer,
transfer-hook, pause.

so after migration the issuer can freeze an account, move a balance without the
holder's signature, and new accounts arrive frozen until someone whitelists
them. none of that is possible against usdv today.

the rest is built to match: five separate pause scopes, per-counterparty spend
limits with usage windows, evidence policies, 222 error codes, every config
path timelocked behind a `_with_pending_change` twin.

the upgrade authority is a single hot wallet. prefix `Govn`.

none of the 70 instructions have been called yet.

---

## Draft B — trapdoor (legal voice first)

there's a page on a bvi trading company's site that opens by telling you what
it is not. not an issuer page. not a minting page. not a redeeming page. not a
custody page, brokerage page, exchange page, counterparty page. nobody named on
it is an issuer, operator, custodian, broker or fiduciary.

it's the security policy for a solana program that shipped overnight.

`ChnryP5RcZtMvP8vvVyPGUhwCg6uDJc53vCe3sxr11Sz`

the program's instruction list, in full sincerity: mint_direct.
withdraw_reserve. freeze_issued_token_account. redeem_trilateral.
register_evidence_policy. set_counterparty_pause.

native rust, 1mb, unverified. it panics with source paths so the modules read
straight out of the binary — settlement, issuance, control, limits, evidence,
fees, permissions, cross_chain. token-2022 wiring for permanent-delegate,
default-account-state, confidential-transfer and transfer-hook, which between
them mean accounts start frozen and the issuer can move your balance.

built carefully, too: 222 error codes, timelocked config changes, five pause
scopes, rotating cross-chain signer sets.

all of it sits under one hot wallet that can replace the program at will, on a
build nobody can reproduce.

none of the 70 instructions have been called.

---

## Verified facts

| claim | value | method |
|---|---|---|
| Deploy | 2026-07-28 02:03 UTC, slot 435654089 | ProgramData, 0 upgrades |
| Size / cost | 1,029,057 B, 7.165 SOL rent | on-chain |
| Framework | native (no anchor runtime) | On Record classifier |
| Verified build | No | osec/verify lookup |
| Repo | none published anywhere | program record + security.txt has no source_code field |
| Authority | `Govn5WGvmeW6g4cGHYVKq3Hd8H758C7Bv27D8dZ5a34d`, hot wallet, mutable | ProgramData |
| Binary sha256 | `ccbb4c46a4196fb747a95f8119c17b8621c1609c1bf03ff0c1d50bfdfbe4a72c` | dump |
| IDL | published: 70 ix, 23 accounts, 222 errors, 78 types, 54 events | `/api/programs/:id/idl` |
| Usage | 0 of 70 instructions called; 0 txns touch the program | 23-txn window |
| security.txt | name Chancery, expiry 2031-07-20, PGP key, `v1.0.0` + rev `983791f9…` | on-chain |
| Policy page | soletechltd.org/chancery-policy, "Last updated: 13 July 2026" | HTTP 200 |
| Domain owner | "Sole Tech Business Ltd", BVI, "proprietary trading company" | soletechltd.org |
| Other entity named | SOLOMON DAO LLC (in the disclaimer, not the domain) | policy page |
| Devnet incubation | 4 iterations, first 2026-07-13 23:38 UTC, 14.1 days | `79RQQN3A4HHrogrBTwUw5py8UMhhyKFFb1CmVGagZ55t` |
| Five pause scopes | global, asset, pathway, counterparty, executor | IDL instruction names |
| Legacy migration | `enable_legacy_migration`, `migrate_legacy_to_token2022` | IDL |
| Migration struct | `LegacyMigrationConfig { legacy_program, legacy_mint, legacy_supply_snapshot, … }` | IDL types |
| Crypto | `sol_secp256k1_recover` + rotating signer sets | syscall table + IDL |
| **USDv mint** | `Ex5DaKYMCN6QWFA4n67TmMwsH8MJV68RX6YXTmVM532C` | Jupiter token search |
| **USDv is legacy SPL** | owner `TokenkegQfeZ…`, not Token-2022 | getAccountInfo |
| **USDv freeze authority** | `null` | getAccountInfo, 2026-07-28 |
| USDv supply / decimals | 1,512,045.796585391 @ 9 | mint account |
| USDv mint authority | `7XAdHs5QBYaHPwi9Vkj7aSMA4ZzcfazBb8kB2LEPncoa`, a PDA | owner = `D4AiKFxj…` |
| Solomon issuance program | `D4AiKFxjZBrhd6MeRAAj6wNxFcZJuRMBrXW9UpqeS8Ax`, upgradeable | getAccountInfo |
| Chancery deployer funding | `Govn5…` ← 30 SOL, 2026-07-27 16:07 ← `J3hYfJPT…` ← `BCNsaGbV…` | getWalletFundedBy |
| Solomon funding root | `7XAdHs5…` and `CSJJKrBP…` (Solomon upgrade auth) both ← `B75Yy4ZK…` | getWalletFundedBy |
| IDL upload | 40+ txns at 03:22 UTC, 79 min after the 02:03 deploy | authority tx history |

Timeline detail worth using: the policy page's "last updated" (13 July) is the
same day as the first devnet deploy (13 July). Legal page and first test
landed together.

## Inferences — label as such if used

- **Regulated/permissioned asset issuance.** From token-2022 extension set
  (permanent-delegate, default-account-state, confidential-transfer,
  transfer-hook) + evidence/limits/permissions modules. Strong.
- **The legacy token is USDv.** Chain of evidence: their own policy page names
  SOLOMON DAO LLC → Solomon Labs issues USDv → USDv is a legacy SPL mint whose
  authority is a PDA of program `D4AiKFxj…` → `LegacyMigrationConfig` wants
  exactly a (`legacy_mint`, `legacy_program`) pair. Strong, but **document +
  structural fit only**. The two funding chains do NOT meet: Chancery runs
  `Govn5…` ← `J3hYf…` ← `BCNsaGbV…`, Solomon runs `7XAdHs5…`/`CSJJKrBP…` ←
  `B75Yy4ZK…`. If someone presses, say the policy page names the entity — don't
  claim a wallet link.
- **EVM-side counterparty.** `sol_secp256k1_recover` + `RemoteDomainPolicy` +
  `CrossChainSignerSet`. Reasonable, not proven.

## Do NOT claim

- **Not "a fork of kdex."** The radar shows 0.91 similarity / TLSH 27, but kdex
  is Anchor and Chancery is native — almost certainly a size/structure artifact,
  not shared code. The next three neighbours all sit at 28–30, i.e. a generic
  cluster. Leave it out.
- Don't call it a scam. Nothing here is fraudulent on its face; the story is the
  gap between how finished the machine is and who can rewrite it.
- Don't name individuals. Entities as printed on the page only.
- The 23 txns in the window do **not** touch the program — don't render them as
  "23 transactions of activity".

## Tool bugs found while researching

1. `idlPresent: false` on the program record, but `/idl` returns a full 70-ix
   IDL. Likely captured at ingest before the IDL was published and never
   refreshed — the dossier counts "IDL" as a missing disclosure while the IDL
   tab renders it.
2. `nearest.deployedAt` for kdex reads 2026-01-15 in the Chancery payload but
   2026-07-09 on kdex's own record.
