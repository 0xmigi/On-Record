# ⊙ On Record

**An agentic newsroom for Solana.** It watches program deployments and upgrades directly on chain and publishes tweet-sized stories about what's actually real — because announcements are claims, deployments are facts.

> North star: *when it's real, at the source.* Not an alpha feed. A record of fact whose value compounds with history, not speed.

The feed never shows raw chain events. An agent pipeline turns them into **stories** — one clean sentence or two, every claim backed by a receipt (a transaction, an account, a commit), and anything speculative quarantined in a visually distinct, confidence-labeled *"our read"* block. An LLM can never state a guess in the fact register: that separation is enforced by a programmatic verification stage, not by prompting.

This repo is also a **Helius integration writeup** — the entire ingestion path runs on Helius products (webhooks, RPC with compressed account fetches, the Orb explorer for receipts). See [How the Helius integration works](#how-the-helius-integration-works).

---

## What it publishes

| Story type | Fires when |
|---|---|
| **Update** | A known project shipped an update. If the code is public and verified, the story says what changed — from the actual diff. |
| **Launch** | A known entity launched something new on mainnet. |
| **Radar** | Something novel appeared and we don't recognize it. Framed as a sighting: what we can prove, plus our labeled read. |
| **Now live** ("became real") | A devnet-watchlist fingerprint or controlling key landed on mainnet: "tested in the lab for 3 weeks, now live." |
| **On record** (corroboration/discrepancy) | The flagship. An operator feeds an announcement URL + program id → "X announced v2 — it's live and the code matches" or "— nothing has shipped on chain." |
| **Control** | Who-can-change-it changed: value moved to/from single-key control, or something got frozen. |
| **Copies** | Aggregate only: "34 copies of the same launcher appeared in 6 hours." Individual copies never get stories. |

Cadence is deliberately small: a deterministic ranking pass selects 5–15 stories/day; everything else stays queryable data. A daily digest object rolls up the top stories and counts.

## Architecture

```
Helius webhooks (mainnet + devnet, BPF Upgradeable Loader)
   ▼
Ingest API (Fastify) ──► events table (append-only record)
   ▼ enqueue (BullMQ + Redis)
   1. fingerprint   sha256 + TLSH + size of the stripped bytecode, IDL probe, strings
   2. identify      entity registry (labels.yaml + DeFiLlama), OtterSec verified builds,
                    authority classification (frozen / team key / governance / single key)
   3. classify      copy-bucketing, novelty scoring, devnet watchlist matching
   4. rank          deterministic score + daily budget → does this deserve a story?
   5. write         one LLM call → structured story JSON (facts / inference separated)
   6. verify        programmatic fact-check: receipts resolve, numbers match,
                    no jargon, lengths — fail → one rewrite → fail → dead-letter
   ▼
stories table ──► API ──► web (Next.js) / RSS / future agents
```

**Stack:** TypeScript monorepo (pnpm workspaces). Fastify ingest + API, BullMQ + Redis pipeline, Postgres 16 + Drizzle, Next.js App Router web, Anthropic API for the writer. Docker Compose locally; a single VPS runs the whole thing. Boring on purpose.

```
apps/ingest       webhook receivers, public API, RSS, admin levers, pipeline workers, cron
apps/web          the reader-facing site + operator desk (/admin)
packages/core     types, Drizzle schema, queues, Helius client, fingerprint math, vocabulary rules
packages/enrich   entity registry, verification, authority class, clone/novelty classification
packages/newsroom rank scoring, the writer, the verifier, diffs, digests
```

## The two-register rule

The product's entire asset is trust, so fact and inference are separated **structurally**:

- The writer must output structured JSON (`headline`, `body`, `facts[]` each with exactly one receipt, `inference` with a confidence level). It may only cite receipts from a candidate list the pipeline built — it cannot invent one.
- The verify stage then checks every receipt actually resolves (the transaction exists, the account exists, the commit URL is live), that every number in the body is supported by event data within tolerance, that no chain jargon or raw base58 leaked into the copy, and that lengths hold (body ≤ 280 target / 320 hard).
- A draft that fails gets one rewrite attempt with the errors fed back. A second failure dead-letters it for the operator. Nothing publishes unchecked.

Chain vocabulary never reaches the page: readers see "launched", "shipped an update", "who can change it", "frozen — no one can change it", "$12M held in it", "the lab". Program ids, slots and signatures live one tap deeper, on the receipts layer, framed as the technical record.

## How the Helius integration works

**1. Webhooks on the loader program.** Two Helius webhooks (mainnet + devnet) watch a single address — the BPF Upgradeable Loader, `BPFLoaderUpgradeab1e11111111111111111111111` — which executes every program deploy, upgrade, authority change and close on Solana. The ingest API receives enhanced transactions at `/webhooks/helius/{network}`, authenticates the shared secret from the `Authorization` header, and decodes each loader instruction's bincode discriminator (`DeployWithMaxDataLen`, `Upgrade`, `SetAuthority`/`SetAuthorityChecked`, `Close`; `Write`/`InitializeBuffer` staging noise is dropped, unknown discriminators are logged). Ingestion is idempotent — `(signature, instructionIndex)` is unique — so Helius redeliveries are free.

**2. Compressed bytecode fetches over Helius RPC.** The fingerprint stage pulls the ProgramData account with `getAccountInfo` using `base64+zstd` encoding — program binaries run to megabytes, and zstd keeps the transfer cheap (max 8 concurrent fetches). The 45-byte ProgramData metadata header is stripped and zero-padding trimmed before hashing, so a redeploy with a different `maxDataLen` fingerprints identically. From the bytes: sha256 (exact identity), TLSH (fuzzy similarity for clone detection), printable strings, and an Anchor IDL probe (the IDL account address is derived in-repo with no web3.js dependency — the ed25519 on-curve check is ~40 lines of bigint math, cross-validated against `@solana/web3.js`).

**3. Receipt verification over the same RPC.** Before a story publishes, every transaction receipt is checked with `getTransaction` and every account receipt with `getAccountInfo`. The chain is the fact-checker.

**4. Receipts link to Orb.** Story proofs deep-link to `orb.helius.dev` so a reader can verify any claim in one tap.

Volume: ~2k mainnet deploy/upgrade events/day. Devnet is noisier but is heavily pre-filtered (per-authority redeploy caps) before anything is enriched.

## Consumers: humans and agents

The website is one consumer of the API; nothing is website-only.

```
GET /api/stories?type=&cursor=      published stories, newest first
GET /api/stories/:id                story + underlying events + receipts
GET /api/digest/:date               daily digest (top stories + counts)
GET /api/subjects/:id               a project: story history, current facts
GET /api/raw/events?cursor=         the underlying event record (power users)
GET /api/lab                        active devnet watchlist ("in the lab")
GET /api/stats                      launches/updates today, % copies, radar count
GET /rss.xml                        the feed as RSS
```

No auth or payments in v1, but every response is self-contained JSON with stable ids and cursors, and the read API sits behind one gateway layer — auth/metering/x402-style payments can be inserted later without changing routes.

## The operator levers

Fully agent-driven — no human is needed for a story to publish — but `/admin` (basic auth) exposes a small set of levers, every pull logged to `operator_log` (edits are part of the record):

- **Kill / pin / restore** stories; review and retry the dead-letter pile.
- **Name things**: attach a name to an unknown program or a copy-bucket; it propagates to future stories.
- **Feed an announcement**: URL + program id → corroboration/discrepancy story job.
- **Tune**: clone/novelty thresholds, rank weights, value floor, daily story budget, and freeform **tone notes** injected into every writer prompt.
- **Watch**: manually add a program or authority to the watchlist.

## Running it

```bash
cp .env.example .env      # fill in HELIUS_API_KEY, ANTHROPIC_API_KEY, secrets

# infra
docker compose up -d postgres redis

pnpm install
pnpm db:migrate           # apply SQL migrations (packages/core/drizzle)
pnpm seed                 # entity registry: labels.yaml + DeFiLlama

pnpm dev:ingest           # API on :3001 (webhooks, /api, /rss.xml, /admin)
pnpm dev:worker           # pipeline workers + cron
pnpm dev:web              # site on :3000
```

Full-stack containers: `docker compose up --build` (the worker image includes git for update diffs and the reference TLSH CLI).

Point two Helius webhooks (enhanced transactions, watching the loader program id) at:

```
https://<your-host>/webhooks/helius/mainnet   Authorization: $HELIUS_WEBHOOK_SECRET_MAINNET
https://<your-host>/webhooks/helius/devnet    Authorization: $HELIUS_WEBHOOK_SECRET_DEVNET
```

Config that matters at runtime lives in the `config` table (editable from `/admin`): `CLONE_THRESHOLD=50`, `NOVEL_THRESHOLD=150`, `MAJOR_VALUE_MIN=10M`, `DAILY_STORY_BUDGET=15`, rank weights, tone notes, monthly LLM token cap.

## Ops notes

- pino structured logs; each pipeline stage logs duration + outcome per event.
- Dead-letter review in `/admin` with one-click retry.
- Daily cron (9am ET): digest generation, watchlist expiry (60 days without mainnet contact), corpus stats, and a threshold-drift report (nearest-neighbor distance distribution) so the operator can tell when the clone/novelty thresholds stop cutting the data where they should. TVL refreshes every 6 hours.
- Spam defense: under fingerprint backlog (>200), deploys from authorities doing >10 deploys/hour are bucketed by authority without fetching bytes.
- LLM backpressure: the write stage respects the daily story budget and a hard monthly token cap.

## Accepted limitations

TLSH measures binary similarity, not protocol novelty — recompiles drift, and novel logic on standard scaffolding can look familiar. Radar tolerates false positives by design; the labeled inference register and the operator levers absorb them. Devnet never publishes on its own. Loader-v4 is out of scope (unknown discriminators are logged). Automated announcement-watching, notifications, agent payments and historical backfill are explicitly deferred, not foreclosed.
