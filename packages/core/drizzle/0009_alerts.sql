-- Verification alerts: sign-ups by wallet, and every verdict the alert sweep
-- reached. Hand-written and IF NOT EXISTS throughout, like 0008, so it is safe
-- to run against a database that already has it. Applied with psql.
CREATE TABLE IF NOT EXISTS "alert_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"channel" text NOT NULL,
	"target" text NOT NULL,
	"confirm_token" text,
	"confirmed_at" timestamp with time zone,
	"manage_token" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "alert_subs_address_idx" ON "alert_subscriptions" USING btree ("address");
CREATE UNIQUE INDEX IF NOT EXISTS "alert_subs_manage_idx" ON "alert_subscriptions" USING btree ("manage_token");

CREATE TABLE IF NOT EXISTS "alert_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"program_id" text NOT NULL,
	"slot" bigint NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"detail" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "alert_deliveries_once_idx" ON "alert_deliveries" USING btree ("subscription_id","program_id","slot","kind");
CREATE INDEX IF NOT EXISTS "alert_deliveries_program_idx" ON "alert_deliveries" USING btree ("program_id","slot");
