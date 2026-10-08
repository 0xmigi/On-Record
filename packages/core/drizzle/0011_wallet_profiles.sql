-- Backing data for builder profiles (/b/<address>): who sits on the Squads
-- multisigs that control programs on record, and where each deploying wallet's
-- first SOL came from. The loader record (0010) already says what every wallet
-- did to every program; these say who it acts with. Hand-written and
-- IF NOT EXISTS throughout, like 0008–0010. Applied with psql.
CREATE TABLE IF NOT EXISTS "multisig_members" (
	"network" text NOT NULL,
	"multisig" text NOT NULL,
	"member" text NOT NULL,
	"version" text NOT NULL,
	"threshold" integer,
	"member_count" integer,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "multisig_members_pk" PRIMARY KEY ("network","multisig","member")
);
CREATE INDEX IF NOT EXISTS "multisig_members_member_idx" ON "multisig_members" USING btree ("network","member");

-- One row per wallet traced. `funder` is the account whose balance dropped most
-- in the wallet's oldest transaction, when the wallet received SOL in it.
-- `busy` = 1,000+ transactions: an exchange, bridge or service, most likely, and
-- never followed further.
CREATE TABLE IF NOT EXISTS "funding_trails" (
	"network" text NOT NULL,
	"address" text NOT NULL,
	"funder" text,
	"lamports" bigint,
	"funded_at" timestamp with time zone,
	"busy" boolean NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funding_trails_pk" PRIMARY KEY ("network","address")
);
CREATE INDEX IF NOT EXISTS "funding_trails_funder_idx" ON "funding_trails" USING btree ("network","funder");

-- a profile looks a wallet up by every role it plays, and the authority it
-- handed control away from is one of them
CREATE INDEX IF NOT EXISTS "loader_txns_authority_before_idx" ON "loader_txns" USING btree ("authority_before");
