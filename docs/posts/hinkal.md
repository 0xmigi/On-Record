# Hinkal — draft post

**Program:** `8ZWGr2cv8uhDBUwc62NRDFYpz4zWgiLUxGGyd8dWhCa8`
**Status:** READY TO POST 2026-08-06
**Researched:** 2026-08-06 (deployed 2026-08-05)
**Brief:** `docs/programs/2026-08-06-hinkal-protocol.md`

---

## Final (approved 2026-08-06)

another privacy program was deployed to solana yesterday

it's called Hinkal Protocol

if you deposited tokens into it, you can:
 - send
 - swap
 - or any instruction list you hand it

all without public visibility

i wanted to learn more about it so here's what i found:

everyone's deposits go into a shared anonymizing pool (standard privacy design). your transfers in and out can't be hidden but everything done inside can be

say you want to swap half of what you have in there for another token. you build a proof (groth16 over alt_bn128) that says: i own enough to cover this, here's a fingerprint so i can't spend it twice, and here are the exact actions to run. it never says which deposit is yours

that proof plus your instructions runs past solana's 1232 byte limit, so it takes several transactions. one private swap here is six

the last one hands your tokens to a throwaway address, works down your actions, checks the amounts add up, and commits the proceeds into the pool as yours

a whitelisted relayer signs and pays for all of it on your behalf, taking its cut out of the tokens you're moving rather than in sol

hiding who paid whom is where privacy projects historically run into legal trouble. hinkal's answer is that the screening is baked into the proof, so an unscreened address can't produce a valid one. both deposit instructions carry a create_blocked_utxos flag to mark a deposit blocked on the way in. false on all 12 so far

i didn't know but hinkal has been deployed on ethereum and tron for a couple of years. this solana version spent 22 days on devnet, ships with no repo and an unverified build. its on-chain relayer whitelist holds exactly one key, the deployer's

*(attach: docs/diagrams/hinkal-swap.html recorded as a gif)*
*(reply: program id + on-record dossier link)*


---

## Verified facts

| Claim in the post | Value | Method |
|---|---|---|
| Went live yesterday | first deploy 2026-08-05 05:53:02 UTC | oldest ProgramData signature |
| Third instruction takes arbitrary instructions | `store_instructions(Vec<SolanaInstructionData>)`, struct is `{account_indexes: bytes, data: bytes, program_index: u8}` | published Anchor IDL |
| Throwaway PDA | `swapper_account`, seeded by a caller-supplied 32-byte `swapper_account_additional_seed` | IDL account seeds |
| Proceeds re-committed / delta checked | `validate_balance_diff.rs`, `perform_swap.rs` in recovered source tree | Rust panic paths in bytecode |
| Used once | 1 `swap2` in the program's entire history | Anchor discriminator decode of all 107 transactions |
| 2.000627 USDT → 2.000000 USDC | pre/post token balance deltas on the `swap2` transaction | `getTransaction` jsonParsed |
| Routed OKX DEX Router → Riptide | `proVF4pMXVaYqmy4NjniPh4pqKNfMmsihgd4wdkCX3u` (on-chain IDL name "OKX: DEX Router"), `riptK81hDxhe5pW5jSzSM9iRA8azgEgLJ4dXkPtBS7j` (bytecode strings contain riptide.so) | inner-instruction program ids |
| Fresh address each time | swapper PDA derived from a per-transaction seed | IDL account seeds |
| Calldata bound into the proof | circuit public signals include a "calldata binding hash"; `encode_instructions.rs`, `get_signed_message_hash.rs` in source tree | Hinkal GitBook "Solana Circuit" + panic paths |
| Relayer submits on your behalf | `relayer_fee` u64 arg; decoded 153,605 on a withdrawal that paid 0.153605 USDC to the submitter and 0.846395 USDC to the recipient | Borsh decode + token balance deltas |
| `transfer` has no recipient account | `transfer2`/`transfer6` account lists contain no `recipient`; `transact2`/`transact6` do | published IDL |
| `create_blocked_utxos` false on all deposits | 12 of 12 successful `proofless_deposit` calls | Borsh decode of every deposit's instruction data |
| 22 days on devnet | first devnet sighting 2026-07-13, matched on TLSH | incubation matcher |
| No repo, unverified build | no declared or found repo; no OtterSec record | disclosure probe + verify lookup |
| Relayer whitelist holds one key | `StorageAccount` at `4jRRzZ2PVxCwroyzp5Tcj1uZyFd8vAVSjv9p14wCME8t`, `whitelisted_relayers` = `[8xzyYDbvfpqYEGekNsm6KDyNXJybTLJhBWBQwabsZN49]`, same key as `owner` and as the upgrade authority | read the account, Borsh decode against the IDL type |
| `transfer2` never called | 0 invocations across all 107 lifetime transactions | discriminator decode; signature history walked to exhaustion, not sampled |

## Labelled as their claim, not mine

- **The access-token gate.** From Hinkal's GitBook "Solana Circuit" page, which
  describes an `AccessTokenChecker(treeDepth)` component. There is nothing about
  access tokens in this binary's strings and no access-token account in the IDL.
  On-chain, the program verifies a Groth16 proof against a verification key baked
  into it; that the key corresponds to a circuit containing that check is their
  word. The post says "per their own docs rather than anything i could read in
  the binary" for exactly this reason — do not drop that clause.
- **Chainalysis KYT screening and viewing keys** — hinkal.io. Not verifiable
  on-chain. Not claimed in the post.

## Do NOT claim

- Not that the program is vulnerable, and not that the July 2026 Ethereum
  double-spend has any bearing on this bytecode. Left out of the post entirely.
- Not that `close_nullifier` allows a double-spend. `NullifierAccount` carries an
  `is_used` flag and the instruction only ever ran on staged proofs that never
  settled, but the guard was not read.
- Not that the swap path can do lending, staking or LPing. The type signature is
  a generic CPI descriptor; one DEX swap is what was observed. The post says
  "arbitrary solana instructions" and describes only the swap that happened.
- Not custody, and not that one key can take the money. The vault is a
  program-owned PDA and the upgrade authority is a hot wallet — the post states
  the whitelist fact and stops.
- Not "Hinkal's first Solana deployment." Third-party coverage from April 2026
  already described Hinkal on Solana; only one Hinkal program is in the corpus,
  and the corpus is a sample of the chain.
- Not the `txns24h` figure (44) or the 85/day implied rate. The real number is
  107 transactions total, most of them proof-staging writes.
