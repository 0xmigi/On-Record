# ⊙ On Record

**An on-chain-first radar for novel Solana programs.** Every program that reaches
mainnet flows through one native program — the BPF Upgradeable Loader. On Record
watches that single chokepoint, strips out the copy-paste, and ranks what's left
by how *novel* it actually is. On-chain-first: every surface leads with an
address, a slot, a signature. No stories, no LLM prose — facts, deduped and
scored.

> It answers the question no explorer and no crypto AI agent can today —
> *"show me the top novel programs deployed to Solana today"* — because that's a
> **novelty-definition problem, not a data-fetch problem**, and the definition is
> the product.

This repo is also a **Helius integration writeup**: the entire ingestion path
runs on Helius (webhooks / Laserstream + RPC), with Orb deep-links on every
receipt. See [the full spec](docs/SPEC.md).

---

## The funnel

```
~2,000 deploy + upgrade events / day     all loader instructions (the raw feed)
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

`2000 → Y → Z` is itself a surface (**the Funnel**) — the thesis in three live
numbers no explorer shows.

## The novelty score (the IP)

Every deploy that survives the dedup **gate** is ranked on cheap, on-chain
signals:

| Signal | Source | Reads as novel/real because |
|---|---|---|
| **Bytecode uniqueness** (gate) | sha256 + TLSH nearest-neighbor over the corpus | no relative = new code, not a factory clone |
| **Instruction surface** | on-chain Anchor IDL, else ELF size/symbols | a 40-instruction protocol ≠ a one-mint token clone |
| **Deployer funding trail** | trace the deploy authority's first funding | CEX / bridge / multisig = credible; fresh-unfunded = bot noise |
| **Authority structure** | loader `set_authority` state | Squads multisig or immutable = serious intent |
| **Early usage** | transactions in the first N hours | real launches get traffic (re-ranks over time) |
| **Verified build** | verifiable-build match | open source = boost |

Weights live in the `config` table (operator-tunable). Category is a **rule-based
tag** (`defi / token / nft / infra / governance / unknown`) from IDL instruction
names — no LLM.

## Architecture

```
LIVE      Helius webhook / Laserstream ──┐
          transactionAccountInclude:[loader]  │
                                              ├─► fingerprint ─► identify ─► classify ─► score ─► Radar
BACKFILL  getProgramAccounts(loader,      ────┘
          ProgramData) → decode slot
```

- **Live tail** — a Helius enhanced webhook on the single loader address. Each
  loader instruction is decoded by bincode discriminator (`DeployWithMaxDataLen`,
  `Upgrade`, `SetAuthority`, `Close`). Idempotent on `(signature, instructionIndex)`.
- **Backfill** — the loader's *signature* history isn't queryable
  (`getSignaturesForAddress` rejects the native loader), so we read chain state
  instead: every `ProgramData` account is loader-owned and encodes its
  deploy slot + authority. `getProgramAccounts(loader, ProgramData)` → decode
  slot → keep the window → fingerprint. One enumerable dataset, not 216k blocks.
- **Pipeline** — `fingerprint` (sha256 + TLSH + IDL probe over zstd-compressed
  bytes) → `identify` (entity registry, verified builds, authority class) →
  `classify` (dedup gate → band + clone cluster) → `score` (composite novelty +
  category + funding trail + early usage).

**Stack:** TypeScript monorepo (pnpm). Fastify ingest + API, BullMQ + Redis
pipeline, Postgres 16 + Drizzle, Next.js App Router web (Orb design system).
Docker Compose locally.

```
apps/ingest       webhook receiver, backfill, public API, admin levers, workers, cron
apps/web          the radar site + operator desk (/admin)
packages/core     types, Drizzle schema, queues, Helius client, fingerprint math
packages/enrich   entity registry, verified builds, authority + category classification
```

## API

```
GET /api/radar?window=today|week|all&band=novel   ranked novel programs (the home feed)
GET /api/programs/:id                              one program: events, fingerprint neighbors, authority, usage
GET /api/funnel?date=                              the 2000 → unique → novel counts + category breakdown
GET /api/clusters/:id                              a clone cluster and its members
GET /api/raw/events?cursor=                        the underlying loader event record (power users)
GET /rss.xml                                       the novel-program feed as RSS
```

## How the Helius integration works

1. **Webhook / Laserstream on the loader.** One address —
   `BPFLoaderUpgradeab1e11111111111111111111111` — executes every deploy,
   upgrade, authority change and close on Solana. `transactionAccountInclude`
   on it is the entire live feed.
2. **`getProgramAccounts` for backfill.** Enumerate ProgramData headers (deploy
   slot + authority) with a memcmp tag filter and a header-only `dataSlice`.
3. **`getAccountInfo` with `base64+zstd` for bytecode.** Program binaries run to
   megabytes; zstd keeps the transfer cheap. The 45-byte metadata header is
   stripped before hashing so a redeploy with a different `maxDataLen`
   fingerprints identically.
4. **Funding + usage reads** (`getSignaturesForAddress`, funding-trail walk) feed
   the score. **Orb** deep-links on every address/tx.

The novelty scoring is the layer Helius's own agent stops short of — On Record
shows the full stack from raw loader instruction to ranked, deduped radar.

## Running it

```bash
cp .env.example .env      # fill in HELIUS_API_KEY + secrets

docker compose up -d postgres redis
pnpm install
pnpm db:migrate           # apply the schema
pnpm seed                 # entity registry: labels.yaml + DeFiLlama

# populate the radar with real recent mainnet deploys (no webhook needed):
pnpm --filter @onrecord/ingest backfill -- --window-hours=48 --max=500

pnpm dev:ingest           # API on :3001 (webhook, /api, /rss.xml, /admin)
pnpm dev:worker           # pipeline workers + cron (live tail)
pnpm dev:web              # radar on :3000
```

Point a Helius enhanced webhook (watching the loader program id) at
`https://<host>/webhooks/helius/mainnet` with the `HELIUS_WEBHOOK_SECRET_MAINNET`
in the `Authorization` header.

### Iterating on the UI (no database)

```bash
pnpm dev:mock             # zero-dependency mock API on :3001 (scripts/mock-api.mjs)
pnpm dev:web              # radar on :3000
```

## Accepted limitations

TLSH measures binary similarity, not protocol novelty — recompiles drift, and
novel logic on standard scaffolding can look familiar; the radar tolerates false
positives and the operator can rename/reband. `getSignaturesForAddress` is
unavailable on the loader, so backfill depth is bounded by ProgramData
enumeration cost. Loader-v4 discriminators are logged, not parsed. Devnet is
input only (a devnet→mainnet fingerprint match flags a program that "became
real"); it never surfaces on the mainnet radar on its own.
