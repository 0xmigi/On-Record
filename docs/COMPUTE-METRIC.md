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
- `isStale(sample)` — older than `COMPUTE_MAX_AGE_H` (default 24h), **or**
  missing `max`/`noLimit`, i.e. written before those fields existed.
- `computeCensus(network)` / `rankUtilisation(network, u)` — the corpus
  distribution, and where one reading sits in it.
- `requestedFrom(instructions)` — decodes the ComputeBudget
  `SetComputeUnitLimit` instruction: program
  `ComputeBudget111111111111111111111111111111`, tag byte `0x02`, then a u32
  little-endian. Base58 `data`, so it needs `bs58.decode`.

Stored shape (`facts.compute`):

```ts
{
  median, p10, p90, max,        // consumed — WHOLE TRANSACTION
  selfMedian, selfShare, selfN, // consumed — THIS PROGRAM, from the logs
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
2. **`card.ts` → `renderCardFor`** — if a card is about to be drawn and the
   reading is stale or unusable, it takes one. Budgeted, because `/card.png` is
   public.
3. **`POST /api/programs/:id/compute`** — the page filler, hit by a client
   effect after a real navigation (never on a prefetch, which is a GET; that is
   how 6,000 programs once got enrolled in a paid refresh loop). One-flight per
   program, and it spends from the same `COMPUTE_ON_DEMAND_PER_HOUR` ceiling as
   the card, so the two surfaces cannot double-spend.
4. **`?sample=live` on the dossier** — forces a reading before a claim gets
   published.

### Where it surfaces

- `GET /api/programs/:id` → `compute` on the detail payload
  (`ApiProgramDetail.compute` in `packages/core/src/types.ts`), and
  `computeRank` beside it — where that reading sits in the corpus.
- `GET /api/programs/:id/card.png` → the bot's share card draws it as a bar:
  p10–p90 band, median line, tick at the heaviest call, log scale, with
  `ASKS FOR 340k · USES 78% OF IT` underneath.
- `GET /api/programs/:id/dossier.md` → a **Compute per transaction** section:
  consumed spread, requested, utilisation and the over-request stated plainly,
  the corpus rank, `noLimit`, cheap share, failure rate — every line with its
  method, and the transaction-level caveat above all of it. Honours
  `?sample=live` (re-measures, writes through) and `?sample=0` (omits it and
  says so).
- The program page → **Composition → Compute per transaction**, directly under
  Footprint: footprint is what the build put on-chain, this is what a call costs
  to run. Same bar as the card, plus the rows it has no room for.
  `apps/web/components/ComputeBar.tsx` renders, `ComputeSection.tsx` fills on a
  real open. Copy is figures and units only — the caveat lives in the section
  title, which always says "per transaction".

  The section is **four rows**: bar, legend, one sentence on what a call burns,
  one on what it reserved. Every figure is a median, said so in the copy — a
  mean would report a number no transaction ever cost.

  **The empty state is three different sentences, not one.** The sampler returns
  a `ComputeMissReason`, and it is carried all the way to the page:
  `too-quiet` → "Too few transactions to measure" (a fact about the program),
  `budget` → "Not measured yet — check back shortly" (a fact about us),
  `failed` → "Not sampled yet". "Measuring…" is only ever shown while a request
  is genuinely in flight; leaving it up as a terminal state tells a reader to
  wait for something that will never arrive.

### The rank (`compute.ts`, `computeCensus` / `rankUtilisation`)

The single most useful thing about a utilisation figure is where it sits, so
every surface that shows one shows the rank next to it: *"uses less of its
reservation than 86% of 412 programs on record · corpus median 61%"*.

Cached per network for 5 minutes — a full-table aggregate over a corpus growing
by ~157 rows a day, so stale-by-minutes is exact enough to rank one program and
it saves a scan per program in a batch. **Below 30 readings it returns `below:
null`** and every surface says "too few to rank against" rather than printing a
percentile over a handful. That floor is the reason the backfill below matters:
until it runs, the rank line renders as its own disclaimer.

### What it costs

One reading = **~101 Helius credits** (100 `getTransaction` at 1 credit each,
plus one `getSignaturesForAddress`; the momentum path reuses a page it already
fetched, so it pays 100).

| path | ceiling | worst case |
|---|---|---|
| momentum tick | `MOMENTUM_MAX_PROGRAMS` (100) per hourly tick, and only for programs with fresh signatures *and* a reading over `COMPUTE_MAX_AGE_H` old | 10,000 credits/h → ~7.2M/month |
| card + page fill | `COMPUTE_ON_DEMAND_PER_HOUR` (8), **shared** — one process-wide counter in `compute.ts`, so `/card.png` and `POST /compute` cannot double-spend | ~808 credits/h → ~580k/month |
| `?sample=live` | none — deliberate, it is a manual act | ~101 credits per invocation |

The momentum ceiling is the one that matters and it is nearly never approached:
most of the rotation is dead code with no fresh signatures in the hour, and a
program that already has a reading under 24h old costs nothing. The on-demand
ceiling is absolute and holds whatever the traffic.

**Watch the shape-staleness catch-up.** Ageing pre-upgrade readings out on shape
makes every one of them due at once. It is bounded by the same 100/tick, so the
cost is a few hours of full ticks, once.

### Partial readings

Rows written before the spread and the requested figure existed carry a median
and a band and nothing else. `isStale` now ages them out **on shape as well as
on the clock**, so one tick replaces them — and until it does, every surface
says "not measured, this reading predates the requested figure" rather than
"no sampled transaction set a compute limit". Absent is not none. The card's
fill went from a null check to `isStale` for the same reason: a reading with no
`max` has nothing to draw a bar with.

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

## What to build next

Items 1 and 2 of the original list shipped — see "Where it surfaces" and "The
rank" above. What is left:

### 3. Decide whether it belongs on the radar row / in scoring

`interest.ts` already scores newness, novelty, adoption, momentum, conviction.
A program reserving 100× what it uses is arguably interesting. **Careful:** the
existing note about not ranking by interest score applies — this would be a
signal, not a verdict. Not started; it is a judgement call, not a build.

### 4. Backfill

Still the blocker on everything comparative. Only a handful of programs have a
reading, so `rankUtilisation` returns `below: null` and the rank line renders as
a disclaimer. A backfill script over the corpus (pattern:
`apps/ingest/src/backfill-*.ts`) would populate it, at `SAMPLE_N` × programs
`getTransaction` calls — **needs a budget decision before running.** Thirty
programs is the floor that turns the rank on; the whole corpus is what makes it
worth reading.

## Caveats that must survive into any UI copy

**Two numbers, and they must never be swapped.** `computeUnitsConsumed` is the
whole transaction: a swap pays for Jupiter plus every token program it routes
through. `selfMedian` is this program's own burn.

This note previously said per-program attribution was unavailable. **That was
wrong.** The runtime writes `Program <id> consumed <n> of <m> compute units`
into `meta.logMessages` for every invocation, CPI passes included — in the same
`getTransaction` response the sample already pays for. The mistake was checking
the enhanced-transactions API, finding no compute there, and concluding the raw
logs had none either. Attribution costs nothing extra and has been on since
2026-08-28.

`selfMedian` is `undefined` on readings taken before that, and `null` when no
sampled transaction actually executed the program — it was named in them, not
called. Neither is zero, and no surface may render them as "this program".

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
- `apps/ingest/src/card.ts` for the card's bar: log scale from a 100 CU floor to
  the 1,400,000 ceiling, because a card has one line to say how big this is in
  absolute terms.
- `apps/web/components/ComputeBar.tsx` for the page's, which is a **different**
  drawing on purpose: linear, full width = the reservation, segmented into this
  program / rest of the transaction / held-and-unused, with every value on its
  own legend swatch. The log-against-1.4M version made the reader decode a scale
  before reading a number, and put four unlabelled vertical lines behind one
  legend. Orb's compute-unit profiling is the reference.
