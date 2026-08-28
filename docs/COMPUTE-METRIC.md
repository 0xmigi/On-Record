# Compute per transaction — what exists, and what to build next

Working note, 2026-08-28. Written to hand this to a fresh session.

The goal: **surface compute (requested vs consumed) as a first-class figure in
On Record itself**, not only on the bot's share card.

---

## Why this metric is worth having

SGP-0003 ("Resource and Inclusion Fee") proposed replacing Solana's flat
5,000-lamport base fee with a fixed 2,500-lamport inclusion fee plus a variable
**resource fee charged per compute unit REQUESTED**, burned in full. Voting ran
epochs 1021–1023 and closed at the end of 1023. It did not pass (For 54.66%,
Against 18.79%, Abstain 26.55%, quorum met at 59.68% participation). It is
expected to return in some form.

The argument around it settled on a claim that is measurable:
**requested compute is what the scheduler reserves, so the gap between
requested and consumed is capacity nobody else could use.** One widely-shared
thread asserted "the network over-requests ~20% on average".

We measured it. **It is not 20%.**

15 major programs, 60 sampled transactions each, 2026-08-28:

```
program            requested   consumed   uses   over-request   no-limit
Marinade              48,636     48,481    99%            0%         55
Phoenix V1           124,499    112,160    90%           11%          0
Kamino               536,553    479,530    90%           12%          0
Phoenix: Eternal       1,200        894    75%           34%         19
Jupiter              215,649    137,191    74%           57%          0
Kamino Lending       336,282    232,185    69%           45%          1
Raydium CLMM         137,199     62,314    61%          120%          1
Jupiter Perps        278,446    189,341    81%           47%          0
Marginfi V2          400,000    208,971    44%           91%          0
Meteora DLMM         322,184     97,449    26%          231%          0
Meteora DAMM V2      357,907    101,252    25%          253%          7
Squads v4            150,000     55,988    21%          168%         53
Orca Whirlpool       301,369     18,802    20%         >999%          0
Raydium CP Swap      329,397     22,724     9%         >999%          3
Drift V2           1,200,000      8,586     1%         >999%          0
```

**Median utilisation 61% → median over-request 64%.** 7 of 15 use under half of
what they reserve. Drift V2 asks for 1,200,000 and burns 8,586, identically on
almost every call sampled (its p10 and p90 are both 8,586).

The `no-limit` column is a wrinkle nobody has written about: Marinade 55/60,
Squads 53/60, Phoenix Eternal 19/60 transactions set **no** compute limit at
all. Those run on the per-instruction default, so a fee on requested compute
lands on them differently again.

---

## What already ships

### `apps/ingest/src/compute.ts`

One implementation, used by every caller — deliberately, so the card, the
dossier and the API cannot disagree.

- `computeFromSignatures(network, signatures)` — the reading itself.
- `sampleComputeOnDemand(network, programId)` — takes a reading for a program
  nothing has sampled, writes it through to `subjects.facts.compute`.
- `isStale(sample)` — older than `COMPUTE_MAX_AGE_H` (default 24h).
- `requestedFrom(instructions)` — decodes the ComputeBudget
  `SetComputeUnitLimit` instruction: program
  `ComputeBudget111111111111111111111111111111`, tag byte `0x02`, then a u32
  little-endian. Base58 `data`, so it needs `bs58.decode`.

Stored shape (`facts.compute`):

```ts
{
  median, p10, p90, max,        // consumed
  cheapShare,                   // share of calls under 2,000 CU
  requestedMedian,              // null when no transaction set a limit
  utilisation,                  // median consumed ÷ requested, 0–1
  noLimit,                      // sampled txns that set no limit
  n, failed, sampledAt
}
```

Env knobs: `COMPUTE_SAMPLE_N` (100), `COMPUTE_MAX_AGE_H` (24),
`COMPUTE_ON_DEMAND_PER_HOUR` (8).

### Who fills it

1. **`momentum.ts`** — on its hourly tick, from the signature page it already
   fetched, so the marginal cost is only the `getTransaction` calls.
2. **`card.ts` → `renderCardFor`** — if a card is about to be drawn and there is
   no reading, it takes one. Budgeted, because `/card.png` is public.

### Where it surfaces

- `GET /api/programs/:id` → `compute` on the detail payload
  (`ApiProgramDetail.compute` in `packages/core/src/types.ts`).
- `GET /api/programs/:id/card.png` → the bot's share card draws it as a bar:
  p10–p90 band, median line, tick at the heaviest call, log scale, with
  `ASKS FOR 340k · USES 78% OF IT` underneath.

---

## Sampling lessons already paid for

**12 samples is not a sample.** Phoenix Eternal spans 556 to 884,264 CU.
Twelve consecutive signatures reported medians of 112,477 / 22,912 / 8,743 /
894 depending purely on where the window fell — a 126× swing on one program,
and the card published 22,912 before this was caught. `SAMPLE_N` is 100 now and
stable across the same windows.

**A single median lies about a bimodal program.** "894" makes a perps engine
look trivial when 52% of its calls are cranks and the working end reaches 173k.
Always show the spread.

**The axis must be logarithmic.** Against a 1.4M ceiling, everything under 20k
collapses into the first pixel.

---

## What to build next — the actual task

### 1. Show it on the program page

The dossier page has no compute section. It should carry the same figure the
card does, plus what the card has no room for:

- requested vs consumed, and the gap stated plainly
- `noLimit` — how many sampled transactions set no limit at all
- the failure rate (already stored as `failed`/`n`)
- when it was sampled, and a way to re-measure (the `?sample=live` convention
  already exists elsewhere in the dossier)

### 2. Make it comparable

The single most useful thing is **rank**, not the raw number. A program using
20% of what it reserves means nothing until you know the median is 61%.

Needs a corpus-wide aggregate — the same shape as the existing "closest code of
N on record" comparison. Probably a periodic job writing a distribution to a
table, so a page can say "uses less of its reservation than 80% of programs on
record" without recomputing.

### 3. Decide whether it belongs on the radar row / in scoring

`interest.ts` already scores newness, novelty, adoption, momentum, conviction.
A program reserving 100× what it uses is arguably interesting. **Careful:** the
existing note about not ranking by interest score applies — this would be a
signal, not a verdict.

### 4. Backfill

Only a handful of programs have a reading. A backfill script over the corpus
(pattern: `apps/ingest/src/backfill-*.ts`) would populate it, but at
`SAMPLE_N` × programs `getTransaction` calls — needs a budget decision before
running.

---

## Caveats that must survive into any UI copy

**It is transaction-level, never per-program.** `computeUnitsConsumed` is the
whole transaction: a swap pays for Jupiter plus every token program it routes
through. Orca reading 20% means transactions *touching* Orca reserve 5× what
they burn, including whatever else rides along. There is no cheaper
per-program attribution — Helius's enhanced-transactions API does not return
compute at all. The label must always say "per transaction".

**Requested ≠ consumed, and SGP-0003 priced the request.** Any copy tying this
to the fee proposal has to use the requested figure, not the consumed one.

**A sample is a sample.** 100 transactions from one recent window. Good enough
for "on almost every call I sampled", not for "always".

**High failure rates are usually normal.** Kamino 7/12, Marginfi 12/12 sampled
transactions failed — that is bots losing races on a busy lending program, not
a defect. Do not lead with it.

---

## Related

- `docs/SPEC.md` §10 for the cron layout the sampler hangs off
- `apps/ingest/src/momentum.ts` for the activity series and the `rate` series
  (transactions/minute, added because hourly *counts* saturate at the
  sampler's page cap on busy programs — Jupiter, Raydium and Meteora all
  flatlined at exactly 3,000)
- `apps/ingest/src/card.ts` for how the bar is drawn
