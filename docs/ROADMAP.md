# Roadmap / open work

> Snapshot 2026-07-11. Written so a fresh session can pick any item up cold.
> Prod: Railway runs `apps/ingest/dist/live.js` (API + poller + crons, no
> Redis), Vercel serves `apps/web`; both auto-deploy from `main`.

## 0. One-off ops

**✅ DONE 2026-07-13** — reenrich ran in the Railway container:
655 mainnet subjects scanned, 462 re-enriched (268 named, 358 upgrades,
462 TLSH filled), zero failures. The ~193 skipped are closed programs whose
ProgramData no longer exists (early `continue` — they don't count toward
`done`, so the "complete at 462 of 655" log line is expected, not a bug).

Rerun (idempotent, safe anytime):

```
railway ssh "node apps/ingest/dist/reenrich.js"
```

Gotcha: first `railway ssh` from a new machine fails with "Host key
verification failed" — fix with `ssh-keyscan ssh.railway.com >> ~/.ssh/known_hosts`.

## 1. Devnet radar + devnet→mainnet conversion rate

**ON HOLD by founder decision** — wait until the data volume feels manageable.

The pipeline is ~70% plumbed: `network` columns everywhere, devnet webhook
route registered, classify already stops devnet at the watchlist ("became
real" matching to mainnet works). Missing:
- a devnet poller instance in `apps/ingest/src/live.ts` (currently mainnet-only)
- `network` param on `/api/radar` + `/api/funnel` (both hardcode mainnet)
- UI network toggle + a devnet-specific ranking rubric (everything there is
  pre-launch by definition — Momentum/Adoption mostly meaningless)
- the headline stat: **% of devnet deploys that reach mainnet** (match by
  TLSH, not authority). No public source for this number exists anywhere —
  it's a genuine first and the strongest pitch artifact.

Helius free plan covers devnet RPC; devnet is noisier (expect ≫ mainnet's
~150 deploys/day), so keep `MOMENTUM_MAX_PROGRAMS`-style caps from day one.

## 2. Education / mechanism-map page ("how programs get on-chain")

VISION §1–2. The explainer component patterns already exist
(`SectionExplainer`, `BotExplainer`, `frameworks.ts` knowledge base) — this
is a page, not new infra. Key researched facts to build on (verified
2026-07-09/11, sources in git history of this repo's sessions):
- Loader-v3 (BPFLoaderUpgradeable) is THE loader. **Loader-v4 was abandoned**
  — never activated on any cluster, deleted from Agave Mar–Apr 2026, feature
  key stubbed `LoaderV4WasAbandoned...`. Tell it as history, not a filter.
- BPFLoader2/v1 = legacy immutable programs only; no new deploys possible.
- Upgrade / extend / set-authority / close are maintenance instructions of
  v3, not separate deploy paths.
- Closing a program leaves a 4-byte Uninitialized husk (tag 0, 0 lamports) —
  the code is deallocated, rent refunded, id burned forever.
- Deploy rent = (128 + 36 + 128 + programdata_bytes) × 6,960 lamports
  (`deployRentLamports` in core/helius.ts).

## 3. Funder labels ("Binance" instead of "cex")

Parked: SolanaFM's API (`api.solana.fm/v0/accounts/{addr}`) was 502ing on
2026-07-09/10 — retest before building. Fallbacks: Dune labels export
(offline seed), Solscan Pro (paid). Wire into `getFundingTrail` consumers as
best-effort lookup with timeout + cache → `facts.funderLabel` → replace the
coarse enum in the Conviction row. The static `KNOWN_SOURCES` map in
core/helius.ts has only 5 addresses — don't hand-extend from memory, only
from a verifiable source.

## 4. Interest ranking tuning (v0.1 → v0.2)

Weights + penalties live in ONE file: `apps/ingest/src/interest.ts`
(momentum .30 / adoption .15 / novelty .20 / disclosure .15 / conviction .10
/ newness .10; ×1/(1+log₂ family size), ×0.2 clone, ×0.05 closed|sniper).
Score → `subjects.noveltyScore` (radar's sort column); full component
breakdown → `facts.interest`. Refreshed at score-stage, momentum tick,
reclassify, close-sweep.

Open items:
- **"Why is this here" one-liner on cards** (VISION §5a's real payoff) — the
  components are already stored per program; render the dominant ones as a
  sentence. No new data needed.
- Watch for wrong-feeling rankings; each is explainable from
  `facts.interest.components` — tune, don't guess.
- Interest-ordered pages have no cursor (recency sort keeps it); add
  (score, ts, id) cursor if pagination is ever needed.
- Momentum counts **transactions** (signature count), not unique signers —
  signers need per-tx fetches; revisit with Helius enhanced API if needed.
- **Size as a prior, not a filter** (measured 2026-07-13 on the 669-program
  live corpus): confident bots cluster at exactly 32,377 bytes (the pump.fun
  sniper template; 77% of bots <50KB) while named/verified programs median
  ~457KB (2% <50KB). But small≠bot — real programs exist at 22–71KB and
  Pinocchio is deliberately tiny. Candidate rule: penalty for small+unnamed
  +anchor, with framework=native/pinocchio exempt. NOTE: size ≈ deploy cost
  exactly (rent is linear in bytes) — cost and size are one axis; don't add
  size to the pentagon alongside cost.

## 5. Smaller known gaps

- OtterSec `/verified-programs` bulk list — seed known names/verified flags.
- `categorize.ts` entity-category mapping is a stub returning null.
- TVL exists on entities, never surfaced on program pages.
- Deployer-farm clustering (same funder → many families) — GRADING.md step 3.
- Orphan-event repair: poller inserts the event row before enrichment; a
  crash mid-pipeline leaves `pipelineStage='ingested'` rows that re-runs skip.
- `drizzle-kit push` to Railway fails on a pre-existing `key` PK drift —
  schema changes need manual `ALTER TABLE` until fixed.
- Usage-shape v2 (sequence/co-occurrence of instructions; IDL-less shape via
  hex-labeled discriminators) — see `packages/core/src/usage.ts`.
- Radar `?sort=recent` escape hatch exists in the API but has no UI toggle.

## 6. Local dev gotchas (this machine)

- **nvm default flips to old Node versions between shells.** Pin explicitly:
  `~/.nvm/versions/node/v24.18.0/bin/node`. pnpm crashes under Node 23; use
  per-package `./node_modules/.bin/tsc` for builds (core → enrich → ingest).
- **No `tlsh` CLI locally** → local fingerprints get `tlsh=null`, lineage
  never populates locally (prod Docker image self-tests it at build). Test
  nearest-neighbor logic with synthetic corpus rows instead.
- Verification stack that doesn't collide with other sessions' dev servers:
  API `PORT=3011 LIVE_POLL_ENABLED=0 node apps/ingest/dist/live.js`, web via
  `.claude/launch.json` "web-verify" (port 3010, API_URL=3011).
- Next.js fetch cache is 30s — reloads within that window show stale API data.

## 7. Map of the recent layers (where things live)

| Layer | Files |
|---|---|
| Interest ranking | `apps/ingest/src/interest.ts` |
| Momentum sampler (hourly activity) | `apps/ingest/src/momentum.ts`, cron in `cron.ts` |
| Close detection (husk-aware) | `apps/ingest/src/closed.ts`, `programDataAlive` in `packages/core/src/helius.ts` |
| Reclassify (nearest freshness) | `apps/ingest/src/reclassify.ts` (6h cron + CLI) |
| Re-enrichment backfill | `apps/ingest/src/reenrich.ts` (CLI, run via railway ssh) |
| On-chain metadata probe (PMP + legacy IDL) | `packages/core/src/metadata.ts` |
| Instruction usage decode | `packages/core/src/usage.ts`, `UsageBars.tsx` |
| Signal pentagon | `apps/web/lib/signals.ts`, `components/SignalHex.tsx` |
| Bot/lifecycle labels | `apps/web/lib/lifecycle.ts` |
| Composition / framework KB | `apps/web/lib/composition.ts`, `lib/frameworks.ts` |
| Family stacking + closed pile | `apps/web/app/page.tsx` (`collapseBuckets`, `ClosedSection`) |
