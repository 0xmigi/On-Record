# On Record — program shape (two specs, not one feature)

> Status: **specs only, nothing built.** Written 2026-07-31 after reading
> [sbpf-eye](https://github.com/Perelyn-sama/sbpf-eye) and asking whether it
> unlocked the parked "anatomy of a call" idea. It doesn't — because that idea
> was actually two features wearing one name, and they need opposite sources.

Today the dossier answers *what a program declares* (name, IDL, security.txt)
and *what it imports* (syscalls, capabilities, embedded pubkeys). It does not
answer either of the two questions people actually ask about a program:

- **Who does it talk to?** → §1, the call graph. Comes from **transactions**.
- **What does it look like inside?** → §2, the internal shape. Comes from
  **bytecode**.

Conflating them is what stalled this. They share no data source, no cost model,
and no failure mode.

---

## 0. Why static analysis cannot answer "who does it talk to"

The instinct is to disassemble and look for calls. It does not work, and it is
worth writing down so nobody re-derives it.

A CPI is `sol_invoke_signed_rust(instruction, account_infos, seeds)`. The callee's
program id is a **field inside a struct built at runtime**, and in practice it
comes from an account the caller was handed. It is not an immediate in the
instruction stream. Statically you recover *"invokes at 14 sites"*, never
*"invokes Jupiter"*.

The exception is a hardcoded id — `declare_id!`-style constants embedded in
`.rodata`. On Record already mines those: that is what the `integrations` field
is. It catches Jupiter's hard-coded program id in DoubleZero's shred program, and
it misses every dynamic target.

So: **the call graph is a runtime fact and must be read from runtime data.**

---

## 1. Anatomy of a call — the CPI tree

### What it is

For a given program: which programs it invokes, how deep, how often, and in what
shape. Rendered on the dossier as a tree.

### Source

`getTransaction(sig, { maxSupportedTransactionVersion: 0 })` →
`meta.innerInstructions`. The runtime records every CPI, with the real program id
and the nesting depth (`stackHeight`), for free. No decoding, no heuristics.

This was proven ad-hoc during the SSTS research: unioning inner instructions over
~14 transactions on the Backpack SPCX mint surfaced `FewRXXTz…`, Backpack's
private controller program, which appears in no metadata anywhere.

### Method

1. Sample the program's recent signatures (`getSignaturesForAddress`), capped —
   200 is plenty and the tree converges long before that.
2. For each, walk `transaction.message.instructions` + `meta.innerInstructions`.
3. Keep every edge `(caller programId, callee programId, stackHeight)`.
4. Union across the sample. Count occurrences per edge.
5. Store on `subjects.facts.callGraph`.

### What it must record

| Field | Why |
|---|---|
| `edges[]` — `{ from, to, depth, count }` | the tree itself |
| `sampled` — how many txns were walked | a tree from 3 txns is not a tree from 200 |
| `windowStart` / `windowEnd` | a program's callees change; the tree is dated |
| `truncated` | the signature page cap was hit |

**Never render a callee count without the sample size next to it.** A program
called twice today has a "complete" call graph that means nothing. This is the
same discipline as `upgradeCountTruncated` and `txns24hTruncated`.

### Cost

The real constraint. One `getTransaction` per signature, so a 200-txn sample is
200 RPC calls **per program**. At ~157 mainnet deploys/day that cannot run in the
pipeline.

Gate it the way `repo-link.ts` is gated: a sweep over survivors, not the deploy
stream. Candidates should be programs that are (a) not clones, (b) not closed,
(c) actually used — `momentum.txns24h > 0`, since a program with no transactions
has no call graph to find. Sample lazily on first dossier view if that proves
cheaper than sweeping.

### Failure modes

- **A quiet program has no tree.** Absence of edges is absence of traffic, not
  absence of integrations. Say so in the UI.
- **Sampling bias.** The most recent 200 txns are whatever that program was doing
  this morning. A settlement path that runs weekly will not appear. Sample across
  a window, not just the head.
- **Rank does not equal importance.** A program that CPIs the token program on
  every instruction will dominate by count and tell you nothing.

---

## 2. Internal shape — what the binary looks like inside

### What it is

A structural read of the program itself: how many functions, how big they are,
how many CPI sites exist, where the syscalls sit, how complex the control flow
is. This is the axis worth expanding — it applies to **every** program including
the ones with zero transactions, which is exactly where the current dossier goes
thin.

### Source

The SBF ELF, which we already fetch and hash. Nothing new from the chain.

### Method (this is where sbpf-eye's approach applies)

sbpf-eye decodes the `.text` section into instructions, splits basic blocks at
branch boundaries, recovers function entry points, and builds intra-program call
edges. It is Rust and it is a TUI, so it is a **reference for the technique**,
not a dependency — the useful part is the parsing order.

It also documents a real trap worth stealing: unresolved relocation placeholders
(`src = 1, imm = -1`) must not be treated as direct call edges, or every function
appears to call itself.

Porting sequence:

1. **Instruction decode.** SBF is fixed 64-bit slots; this is the easy part.
2. **Basic blocks** — split on jumps, calls, exits.
3. **Function entries** — from call targets and the ELF symbol table when present.
4. **Reachability** — from the entrypoint. Dead code is a signal in itself.
5. **CPI sites** — count `sol_invoke_signed_*` call sites and which function each
   sits in.

### What it buys the dossier

| Metric | What a reader learns |
|---|---|
| function count, median function size | hand-rolled vs framework-generated |
| basic blocks per function | branch-heavy validation vs straight-line math |
| CPI site count | how much of this program is orchestration |
| unreachable bytes | dead code, or a build shipping more than it runs |
| entrypoint fan-out | one dispatcher, or many |

This composes with what already exists. `instructionCount` says how many
instructions a program exposes; internal shape says how much program is behind
each one. A 25-instruction standard with 33 source files reads very differently
from a 25-instruction binary that is one 4,000-line match arm.

### Cost

Cheap and offline. It runs on bytes we already have, needs no RPC, and is
deterministic — so it belongs in the fingerprint stage next to `profileProgram`,
and it can be backfilled over the whole corpus from stored bytecode.

The risk is not cost, it is **correctness**: a decoder that silently mis-parses
produces confident numbers that are wrong. Ship it behind a comparison against a
known-good disassembler on a sample before it renders anywhere.

---

## 3. Build order, if either gets picked up

**Internal shape first.** It is offline, deterministic, backfillable, applies to
every program including devnet and zero-traffic ones, and has no sampling
caveats. It also makes the ranking better — real complexity is a far stronger
"is this a toy" signal than `sizeBytes`, which is what `smallAnonymousPrior`
currently gropes at.

**Call graph second**, and only for programs with traffic. Higher cost, needs its
own sweep, and its answer is only as good as the sample. It is the more
impressive dossier panel and the less useful one.

---

## 4. What not to do

- Do not render a CPI tree derived from static analysis. It will be wrong in the
  interesting cases and right only where `integrations` already tells you.
- Do not put either behind the ingest pipeline's hot path. One is RPC-expensive,
  the other is CPU-expensive; both belong in sweeps.
- Do not report a call graph without its sample size, or an internal-shape metric
  without saying it came from the deployed binary rather than source.
