# On Record — Spec v2 (the radar)

> **v1 was an "agentic newsroom" that wrote tweet-sized *stories* from chain
> events. v2 kills the newsroom.** On Record is an on-chain-first radar for
> **novel Solana programs**. It watches every program deployed or upgraded on
> mainnet, strips the copy-paste, and ranks what's left by how novel it actually
> is. No stories. No LLM prose. Addresses, slots, signatures — with a plain
> caption on the facts, never instead of them.

The product answers a question no explorer and no crypto AI agent can today —
*"show me the top novel programs deployed to Solana today"* — because that is a
**novelty-definition problem, not a data-fetch problem**, and the definition is
the entire product.

---

## 1. The funnel

Every program that reaches mainnet flows through one native program — the **BPF
Upgradeable Loader** (`BPFLoaderUpgradeab1e11111111111111111111111`). That single
chokepoint is the entire input.

```
~2,000 deploy + upgrade events / day     all loader instructions (raw feed)
   │  drop exact-bytecode dupes (sha256)
   ▼
   Y   unique bytecode                    "new" — a program image never seen before
   │  drop near-dupes (TLSH cluster: pump.fun forks, SPL/candy/token variants)
   ▼
   Z   structurally novel                 no known relative in the fingerprint corpus
   │  rank by novelty score
   ▼
  Top N on the Radar, today
```

`2000 → Y → Z` is itself a **surface** (see §6, The Funnel). Those three live
numbers are the thesis. No explorer shows them.

## 2. The novelty model (the IP)

Every deploy that survives dedup is scored on cheap, on-chain-derivable signals.
The dedup step is the **gate**; the rest is the **ranking**.

| Signal | Source | Reads as novel/real because |
|---|---|---|
| **Bytecode uniqueness** (gate) | sha256 exact + TLSH nearest-neighbor over `fingerprint_corpus` | No relative in corpus = genuinely new code, not a factory clone |
| **Instruction surface** | on-chain Anchor IDL PDA if published, else ELF size / symbol count | a 40-instruction protocol ≠ a one-mint token clone |
| **Deployer funding trail** | `heliusWallet.getWalletFundedBy` on the deploy authority | CEX / bridge / known multisig funding = credible team; fresh-unfunded = bot noise |
| **Authority structure** | loader `set_authority` state | Squads multisig or immutable (`authority = null`) = serious intent |
| **Early usage velocity** | unique signers touching the program in first N hours | real launches get traffic; re-ranks over time (lagging signal) |
| **Verified build** | verifiable-build match | open source = boost |

**Novelty band** (from the gate):
- `clone` — exact sha256 match to a known image → dropped from the radar, counted in the funnel.
- `variant` — TLSH distance below `VARIANT_THRESHOLD` to an existing cluster → low novelty, foldable into a cluster row.
- `novel` — no near neighbor → eligible for the radar.

**Score** = weighted blend of the ranking signals (weights in the `config`
table, operator-tunable). Produces the daily ordering. Lagging signals (usage)
re-rank a program over its first day.

## 3. Data architecture

```
LIVE      Helius webhook / Laserstream ──┐
          transactionAccountInclude:[loader]  │
                                              ├─► parse loader ix ─► fingerprint ─► dedupe ─► score ─► radar
BACKFILL  getProgramAccounts(loader,      ────┘
          type = ProgramData) → decode slot
```

**Live tail — webhook (already wired in `apps/ingest`).** A Helius enhanced
webhook watches the single loader address. Each transaction's loader
instruction is decoded by bincode discriminator: `DeployWithMaxDataLen`,
`Upgrade`, `SetAuthority`/`SetAuthorityChecked`, `Close`. `Write` /
`InitializeBuffer` staging noise is dropped. Idempotent on
`(signature, instructionIndex)`, so redeliveries are free.

**Backfill — ProgramData enumeration (new; v1 deferred this).** The loader's
*signature history is not queryable* — `getSignaturesForAddress` on the native
loader returns `Address is not supported`. So instead of asking "what did the
loader do lately," read chain state directly: every program's `ProgramData`
account is owned by the loader and its bytes encode the **last-deployed slot**
and **upgrade authority**. `getProgramAccounts(loader, filter: ProgramData)` →
decode the slot from each → keep those inside the window → fingerprint. One
enumerable dataset instead of ~216k `getBlock` calls per day. Seeds the radar on
first load; the webhook is the live tail after that.

**Fingerprint (keep as-is).** ProgramData account pulled via `getAccountInfo`
with `base64+zstd`; the metadata header is stripped and zero-padding trimmed
before hashing, so a redeploy with a different `maxDataLen` fingerprints
identically. From the bytes: sha256, TLSH, printable strings, Anchor IDL probe.

## 4. Classification — rule-based, zero LLM

No writer, no prompts, no fact/inference register. Category is a **tag** derived
from on-chain heuristics:

- **IDL instruction names** when an IDL is published (`swap`/`addLiquidity` → DeFi; `mintTo`/`transfer` shape → Token; Metaplex-adjacent → NFT).
- **CPI targets & program-owner interactions** (talks only to the token program → Token; talks to a known AMM → DeFi).
- **Printable strings / known-program neighbors** as a weak fallback.
- `unknown` is a valid, honest tag. Never guess in prose.

Output is a small enum tag (`defi | token | nft | infra | governance | unknown`)
plus the raw facts. That's the whole "editorial" layer.

## 5. Data model

**Keep:** `events` (append-only loader record), `subjects` (programs/entities),
`entities` (identity registry, DeFiLlama seed), `copy_buckets` (clone clusters),
`fingerprint_corpus` (TLSH corpus), `config`, `operator_log` (naming a
program/cluster is still a lever), `watchlist` (devnet → mainnet "now live").

**Drop:** `stories`, `digests` (as story-rollups). Repurpose the daily rollup as
a **funnel snapshot** (`funnel_daily`: date, counts for raw/unique/novel per
band + category breakdown).

**Add to `subjects`:** `noveltyBand` (`clone|variant|novel`), `instructionCount`,
`idlPresent`, `deployerFundingSource`, `earlySigners`, `category`. (`noveltyScore`
already exists.)

## 6. Surfaces (on-chain-first, instrument not blog — Orb design tokens)

1. **Radar (home).** Today's top novel programs, ranked rows. Each row leads with
   the truncated address (mono, copyable), then *deployed 2h ago @ slot N* ·
   novelty score · category tag · the raw facts (size, instruction count,
   authority type, funding source, early signers). At most one plain descriptor
   line. Cluster/variant rows collapse ("34 forks of *launcher X*").
2. **Program dossier.** Full on-chain record for one program: deploy/upgrade
   timeline (`events`), fingerprint + nearest neighbors ("no known relatives" /
   "92% match to *cluster X*"), authority history, usage sparkline, identity if
   known. A block explorer a human can read.
3. **The Funnel.** The live `2000 → Y → Z` counter with the category breakdown.
   The differentiator — the thesis made visible.

## 7. API

```
GET /api/radar?window=today            ranked novel programs (the home feed)
GET /api/programs/:id                   one program: events, fingerprint neighbors, authority, usage
GET /api/funnel?date=                   funnel counts + category breakdown
GET /api/clusters/:id                   a copy-bucket and its members
GET /api/raw/events?cursor=             the underlying loader event record (power users)
```

Self-contained JSON, stable ids + cursors, one gateway layer so auth/metering can
slot in later without route changes.

## 8. Helius integration (the SE writeup)

The whole ingestion path runs on Helius: **enhanced webhooks / Laserstream** on
the loader (live), **RPC `getProgramAccounts`** for backfill, **RPC
`getAccountInfo` with base64+zstd** for bytecode, **`getWalletFundedBy`** for the
deployer trail, and **Orb** deep-links on every receipt. The novelty scoring is
the layer Helius's own agent stops short of — On Record shows the full stack from
raw loader instruction to ranked, deduped, categorized radar.

## 9. Build sequence

- **P0 — Teardown.** Delete `packages/newsroom`, the `stories`/`digests` tables,
  `StoryCard`, `story/[id]`, the writer/verify/rank(story) code, `ANTHROPIC_*`
  and `WRITER_MODEL`. Rewrite README + package description.
- **P1 — Score & schema.** Add novelty band + ranking fields to `subjects`; add
  `funnel_daily`; replace story-rank with novelty-rank.
- **P2 — Backfill.** ProgramData enumeration → seed corpus + radar with real
  recent mainnet deploys.
- **P3 — Live.** Confirm webhook path end-to-end (already stubbed).
- **P4 — Surfaces.** Rebuild web on Orb tokens: Radar, Dossier, Funnel. Update
  the mock API to serve radar shapes, not stories.
- **P5 — Classification.** Rule-based category tags.

## 10. Accepted limitations

TLSH measures binary similarity, not protocol novelty — recompiles drift, and
novel logic on standard scaffolding can look familiar; the radar tolerates false
positives and the operator can rename/reband. `getSignaturesForAddress` is
unavailable on the loader, so backfill depth is bounded by ProgramData
enumeration cost, not arbitrary. Loader-v4 discriminators are logged, not parsed.
