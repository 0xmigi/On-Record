# On Record — product direction (not yet built)

> Captured 2026-07-09 from a founder brief. This is intent, not a spec — it steers
> UI/design and what we build next. Do not implement from this doc without a
> focused plan. The open problem underneath all of it is the **surfacing
> methodology** (§5).

## 1. Reframe the site as "Solana programs, explained + surfaced"

Beyond a radar, the main page should *teach*: what a Solana program is, how it
gets on-chain, where to find it, and the different kinds that exist. A curious
visitor (a dev, an investor, a builder) should land and go "oh — so *every*
program is deployed through this loader, it can be upgraded, and here's the
objectively most interesting thing deployed this month." Education + a live feed,
not just a leaderboard.

Design implication: the home/explainer should carry the deployment-mechanism map
(§2) and a hero "most interesting program" slot (§4) alongside the radar.

## 2. Map the deployment mechanisms (the "how programs get on-chain")

There are only a handful of ways a program reaches Solana. Surfacing this map is
itself interesting content. The loaders (see also GRADING.md §1):

- **BPF Upgradeable Loader** (`BPFLoaderUpgradeab1e…`) — the dominant path today.
  Program + ProgramData accounts; supports Deploy / Upgrade / SetAuthority /
  Close / ExtendProgram. **This is the only loader On Record watches right now.**
- **Loader v4** (`LoaderV4…`) — the newer unified loader (deploy / upgrade /
  retract / finalize / transfer-authority), more efficient; rolling out. Not yet
  ingested — a known blind spot.
- **BPFLoader2** (`BPFLoader2…`) — legacy, **immutable at deploy** (no upgrade
  authority). Older programs live here; not enumerated today.
- (BPFLoader v1 — deprecated.)

"Upgrade / extend / set-authority" are *maintenance* instructions within the
upgradeable loader, not separate loaders — worth explaining clearly so people
don't conflate them. Goal: a page that lays out these paths so a newcomer
understands the funnel every program passes through.

## 3. Devnet — and the devnet → mainnet conversion rate

Add the exact radar for **devnet**, then surface a signature figure: **what % of
programs deployed to devnet make it to mainnet** (and how long that takes).
Devnet is a much larger, noisier arena and harder to analyze, but the conversion
funnel is a genuinely novel metric — it's the "pipeline of what's coming." Match
programs devnet↔mainnet by bytecode similarity (we already have MinHash/TLSH),
not just authority.

## 4. Surface "the most interesting program" — filterable by time

The payoff of the whole system: "the objectively most interesting program
deployed today / this week / this month." Someone close to the source should be
able to filter by day and see the standout (the brief's example: an Ellipsis-
style perps product). This is a *ranking + editorial* surface on top of the raw
radar — and it lives or dies on §5.

## 5. THE core problem — the surfacing methodology

Everything above depends on a defensible answer to: **how do we rate what's worth
surfacing vs. noise?** This is the real intellectual work and the reason not to
rush implementation. It builds on GRADING.md's three axes — **Novelty**
(structural distance to known programs), **Conviction** (deploy cost, funder,
authority, recovered identity), **Traction** (usage, CPI, TVL — lagging) — but
needs to become a concrete, explainable score (à la the Orb Market Score
methodology that seeded this: weighted components, interpolation, grades, hard
caps). The current radar sort is still a placeholder blend. Until the methodology
is right, "most interesting" is just a vibe.

Open questions to resolve before building §1–4:
- What are the weighted components and thresholds, per stream (new deploy vs
  upgrade — upgrades rank by *impact*, not novelty)?
- How do we keep it explainable ("this scored high because …") rather than a
  black box?
- How much is automatic vs. an editorial/operator lever?
- Devnet needs its own rubric (pre-launch, low-signal by nature).

### 5a. Methodology v0 direction (founder-endorsed, 2026-07-09)

Frame it as a **quality-adjusted signal, not a claim to know what's "best."**
Working definition: *Interesting = unusually strong evidence of novelty,
attention, adoption, or ecosystem impact for a program in its time window — after
discounting spam and inorganic activity.*

- **No single mysterious score at first.** Show a few *visible* signals per
  program instead: **Newness** (deployed/upgraded/newly discovered), **Momentum**
  (growth in unique callers, txns, activity over the window), **Adoption**
  (sustained repeat usage, not a launch spike), **Ecosystem impact** (CPI usage,
  integrations, notable protocol/dev connections), **Transparency** (verified
  source/IDL, docs, known authority, audits — a *confidence* signal, not
  popularity), **Risk/spam adjustment** (exclude clones, deployer spam, wash-like
  or over-concentrated activity).
- **Show Interest and Confidence SEPARATELY.** A weird new program can be genuinely
  interesting while unverified/risky; collapsing them into one rating is less
  honest. (This is why the placeholder "novelty NN" was REMOVED from the UI on
  2026-07-09 — a single opaque number over-claims.)
- **V0 default ranking, mostly on-chain:** ~40% momentum, 25% adoption quality,
  20% novelty, 15% ecosystem/transparency — then a *visible* spam/risk penalty.
  **Log-scale** so a giant program doesn't bury every emerging one; compare within
  the same timeframe/category where possible.
- **Every listing answers "why is this here?" in one line** — e.g. "Breaking out:
  1,240 unique callers in 48h, 3.8× daily growth, used by 4 established programs" /
  "New and notable: deployed 6h ago; verified source; early usage from 86 wallets."
  That sentence is more valuable than a number.
- Treat it as **versioned editorial infrastructure — "On Record Methodology
  v0.1":** publish inputs, weights, exclusions, known blind spots; tune based on
  whether respected Solana builders agree the top results are worth seeing, not on
  clicks.

### 0. Overriding design principle: human readability first

Every surface optimizes for a human skimming it. Concretely (locked
2026-07-09): the human-readable **name is the primary identifier** (title,
top, largest) and the program **id is secondary** (smaller, muted, below) —
assume names get more common as de-opaquing improves. No redundant global
context as per-row chrome (e.g. a "mainnet" tag on every card when the whole
page is one network). No premature/opaque scores. Prefer a plain-English "why"
over a number.
