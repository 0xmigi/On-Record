# On Record — deploy (Railway + Vercel)

Goal: a live, always-on radar. One Railway service runs the API + poller + cron
in a single process (pipeline **inline**, no Redis); Railway Postgres is the
store; the Next.js web app runs on Vercel pointed at the Railway API.

```
             ┌─────────────── Railway ───────────────┐
 Solana ◀────┤  live.js:  API + poller(120s) + cron   │
 (Helius RPC)│  Postgres plugin (DATABASE_URL)        │
             └───────────────┬────────────────────────┘
                             │  API_URL
                       ┌─────▼─────┐
                       │  Vercel   │  apps/web (Next.js)
                       └───────────┘
```

## Why poller, not webhook
A Helius webhook on the BPF loader fires on every loader instruction — including
the hundreds of buffer-`Write` staging txns per deploy (100k+/day) that the
parser just discards. The poller reads final ProgramData state instead: one
header-only `getProgramAccounts` call every ~2 min catches every new program
(~157/day) with predictable cost. The webhook receiver (`/webhooks/helius/*`)
still exists if you ever want to add push later.

## 1. Railway — the backend

1. **New project** → **Add Postgres** (plugin). It exposes `DATABASE_URL`.
2. **Add service → Deploy from GitHub repo** (this repo). Railway reads
   [`railway.json`](../railway.json) → builds [`Dockerfile`](../Dockerfile),
   start command `node apps/ingest/dist/live.js`, health check `/health`.
3. **Service variables** (Settings → Variables):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`  (reference the plugin)
   - `HELIUS_API_KEY` = your key
   - `ADMIN_PASSWORD` = something real (guards `/admin/*`)
   - `PUBLIC_API_URL` = the service's public domain (set after step 4)
   - optional: `LIVE_POLL_INTERVAL_MS` (default 120000),
     `LIVE_POLL_BOOTSTRAP_HOURS` (default 1), `LIVE_POLL_MAX` (default 200)
   - `PORT` is injected by Railway automatically — don't set it.
   - `REDIS_URL` is **not needed** (inline pipeline).
4. **Generate a domain** (Settings → Networking → Public Networking). Copy it
   into `PUBLIC_API_URL`.
5. **Create the schema** — run once from your machine against the Railway DB:
   ```sh
   DATABASE_URL='<railway postgres url>' pnpm db:push
   ```
6. **(Optional) Seed history.** The poller only reaches back
   `LIVE_POLL_BOOTSTRAP_HOURS` on first boot (~a dozen programs). To fill the
   radar with a 48h window immediately:
   ```sh
   DATABASE_URL='<railway postgres url>' HELIUS_API_KEY='<key>' \
     pnpm --filter @onrecord/ingest backfill --window-hours=48 --max=500
   ```

Verify: `curl https://<railway-domain>/health` → `{"ok":true}`, then
`curl 'https://<railway-domain>/api/funnel'` and watch `raw` climb as the poller
ticks (logs: `poll: ingested program`).

## 2. Vercel — the web app

1. **Import the repo**, set **Root Directory** = `apps/web`.
2. **Environment variable**: `API_URL` = `https://<railway-domain>`.
3. Deploy. The radar, dossier, and funnel now read live Railway data.

## Cost note ($5 budget)
Postgres plugin + one always-on container is the whole stack — no Redis, no
separate worker. At ~157 deploys/day the poller and inline enrichment are
near-idle, so this sits comfortably inside the Hobby plan.

## Local equivalent
No Postgres locally? `docker compose up` (see
[`docker-compose.yml`](../docker-compose.yml)) brings up Postgres + Redis + the
services, or run `pnpm --filter @onrecord/ingest dev:live` against any Postgres
with `DATABASE_URL` set. One-shot manual poll: `pnpm --filter @onrecord/ingest poll`.
