# Chancery — draft post

**Program:** `ChnryP5RcZtMvP8vvVyPGUhwCg6uDJc53vCe3sxr11Sz`
**Status:** unposted draft
**Researched:** 2026-07-28 (deployed same day)

---

## Draft A — code-first (recommended)

deployed to mainnet overnight. native rust, 1mb, unverified, no repo anywhere.

`ChnryP5RcZtMvP8vvVyPGUhwCg6uDJc53vCe3sxr11Sz`

it panics with full source paths, so the module tree falls straight out of the
binary:

settlement/ — mint_direct, mint_trilateral, redeem_direct, redeem_trilateral
control/ — freeze_issued_token_account
limits/ — register_limit_policy, usage_window
evidence/ — evidence_policy
cross_chain/ — emit_outbound_message, consume_inbound_message
issuance/ — tlv_parser, verify_issued_token_deployment

the pda seeds fill in the rest: issued-token-control, reserve-destination,
settlement-intent, basic-freeze-record, pending-config-change.

and the token-2022 authorities it wires up: permanent-delegate,
default-account-state, confidential-transfer, transfer-hook, pause.

so it's an issuance rail. mint against a reserve, freeze a holder, cap what
they can move per window, keep a record of why. there are five separate pause
scopes — global, asset, pathway, counterparty, executor.

70 instructions. 222 error codes. 54 events. every config path has a
`_with_pending_change` twin, so changes are timelocked.

then i opened the policy link in its security.txt. it's a bvi proprietary
trading company, and the page spends its first paragraph listing what it isn't:
not an issuer page, not a minting page, not a redeeming page, not a custody
page, not an exchange page, not a counterparty page. it disclaims that anyone
is an issuer, operator, custodian, broker or fiduciary — naming an LLC that
isn't the company on the domain.

the security.txt cites v1.0.0 and commit 983791f. no repo is published to check
either against, and the build isn't verified.

the upgrade authority is a single hot wallet. prefix `Govn`.

none of the 70 instructions have been called.

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
| Crypto | `sol_secp256k1_recover` + rotating signer sets | syscall table + IDL |

Timeline detail worth using: the policy page's "last updated" (13 July) is the
same day as the first devnet deploy (13 July). Legal page and first test
landed together.

## Inferences — label as such if used

- **Regulated/permissioned asset issuance.** From token-2022 extension set
  (permanent-delegate, default-account-state, confidential-transfer,
  transfer-hook) + evidence/limits/permissions modules. Strong.
- **An existing legacy SPL token is meant to migrate in.** From
  `migrate_legacy_to_token2022` + `LegacyMigrationConfig`. Strong but the token
  isn't named on-chain.
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
