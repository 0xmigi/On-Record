# On Record — grading design (working backwards from Solana)

> Goal: a real-time system that grades every program the moment it hits the
> chain. Not a static snapshot — a windowed stream. "330" always means "330
> loader events **in the last 48h**"; the live view is "N in the last hour."

## 0. The frame: it's a stream, windowed

The source of truth is the **BPF Upgradeable Loader instruction stream**, live via
Helius webhook / Laserstream. Every event carries a slot + blockTime. Everything
downstream is time-windowed (live / 1h / 24h / 7d). Scores are computed on
arrival and **re-computed over time** as lagging signals (usage, TVL, upgrade
cadence) accrue. The snapshot we have is just a 48h replay of this stream.

## 1. What does EVERY program have? (the observable surface)

Working backwards from the chain, here's the raw material — universal to every
deployed program — grouped by when it becomes available.

**A. Identity anchors (at deploy, always present)**
- **Program ID** — the executable account address.
- **Owner = loader** → mutability class: Upgradeable loader (mutable), BPFLoader2
  (immutable/legacy), Loader v4 (new). *(We only enumerate the upgradeable loader
  today — BPFLoader2 immutable deploys are a known blind spot.)*
- **ProgramData account** → deploy slot, upgrade authority (or null = frozen),
  allocated size, and **deploy cost = rent locked** (~2.2 SOL median, real skin).

**B. From the bytecode (the ELF is always there — the richest layer)**
- **Size**.
- **Framework** — Anchor / Pinocchio / Steel / Shank / native — from the syscall
  ABI (`sol_invoke_signed_rust` vs `_c`) + marker strings (`anchor:idl`,
  `IdlCreateAccount`, `ConstraintHasOne`) + discriminator patterns. *(52% Anchor
  in our data; the rest classifiable by signature.)*
- **Syscall / capability profile** — the imported-syscall table (from the ELF
  dynamic symbols) is a precise capability fingerprint: does it CPI
  (`sol_invoke_signed`), hash (`sol_sha256`, `sol_keccak256`), use PDAs
  (`sol_try_find_program_address`), do curve/secp ops, read sysvars? This vector
  says *what the program can do* — universal, structured, cheap.
- **Instruction surface** — count of instruction handlers / discriminators.
- **Identity strings** — crate name (Rust panic paths), embedded security.txt,
  repo + socials. *(De-opaques ~53%.)*
- **Integration hints** — constant addresses + strings naming what it talks to
  (e.g. `damm_v2` → Meteora). Confirmable later against the live CPI graph.

**C. From provenance (the deploy tx + funding)**
- **Deployer** (fee payer of the deploy tx).
- **Funding trail** (who funded the deployer — CEX / bridge / known / fresh).
- **Authority structure** (multisig / immutable / hot wallet).
- **Deployer history** — has this wallet deployed before? Serial deployer, farm,
  or first-timer. (A cluster key: many programs → one funder = a farm.)

**D. From behavior over time (tx history — lagging, real-time updated)**
- **Usage** — txns + unique signers per window. *(A booster, never a gate —
  unannounced ≠ dead; they paid ~$180 to deploy.)*
- **CPI graph** — which programs it actually invokes (from inner instructions) →
  its real integrations (Token program? an AMM? an oracle?).
- **TVL** — value held in its accounts / PDAs.
- **Upgrade cadence** — how often the code changes (and, for upgrades, how big
  the change is).

## 2. Deploy vs Upgrade — a classification, not a filter

New deploy = fresh program id, **trust from zero**. Upgrade = existing program
changed, **trust exists, magnitude matters** (a Jupiter swap upgrade moves
billions). Two separate streams, each graded differently (see §3). This is a
*split at the top of the funnel*, not the funnel itself.

## 3. Grading = three axes, not one number

The old "novelty 77" jammed unrelated things into one score. Separate them:

- **Novelty** — *is it structurally new?* Fuzzy distance to the nearest KNOWN
  program (bytecode + capability-profile similarity). "No known relative" =
  novel; "94% match to Raydium" = a fork. Explainable by construction.
- **Conviction** — *is it a real effort?* Deploy cost / SOL locked, funder
  credibility, authority structure, framework maturity, recovered identity.
- **Traction** — *is it alive?* Usage, CPI integrations, TVL. Lagging;
  re-scored over time.

For **upgrades**, novelty is irrelevant — grade by **impact**: the traction of
the program being upgraded × the size of the change.

## 4. The real funnel (progressive, real-time)

Each stage is a genuine cut on a real criterion — this is where "grading"
becomes a funnel:

```
loader events (window)                 e.g. 330 / 48h   [have]
  ├─ split: new deploys | upgrades     200 | 130        [have]
  ▼ (new deploys stream)
  parse bytecode: framework, syscalls, instr, identity   [partial → build]
  ▼
  drop template/fork clones            fuzzy similarity  [BUILD — the gate]
  ▼
  above conviction floor               cost + funder + not-a-farm   [partial]
  ▼
  ranked radar, by chosen axis         novelty / conviction / traction
```

## 5. Build order

1. **Program Profiler** (foundation) — parse the ELF properly: syscall table,
   framework signature, instruction/discriminator count, integration constants.
   Universal, cheap (we already fetch bytecode), feeds every axis. This is the
   "work backwards from Solana" core.
2. **Fuzzy novelty** — similarity over {capability vector + bytecode fingerprint}
   → nearest-known-program distance. Defines novelty + the clone gate. Fills the
   ghosted funnel stage.
3. **Deployer graph** — cluster by funder/deployer to kill farms + surface serial
   builders.
4. **Live pipeline** — webhook → profile → grade → windowed radar, real-time.

## Accepted gaps (today)
BPFLoader2 immutable deploys not enumerated. Framework DB seeded with
Anchor/Pinocchio; Steel/Shank/Quasar signatures TBD. CPI graph + TVL not yet
pulled. Novelty still the placeholder blend until step 2 lands.
