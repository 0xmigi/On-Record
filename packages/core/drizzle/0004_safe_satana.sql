-- funnel_daily: date-only PK let any devnet snapshot clobber mainnet's row for
-- the same day. Composite (date, network) keeps one row per day per cluster.
-- "funnel_daily_pkey" is Postgres's default name for the original PK.
ALTER TABLE "funnel_daily" DROP CONSTRAINT IF EXISTS "funnel_daily_pkey";--> statement-breakpoint
ALTER TABLE "funnel_daily" ADD CONSTRAINT "funnel_daily_date_network_pk" PRIMARY KEY("date","network");
