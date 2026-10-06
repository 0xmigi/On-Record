-- The raw loader record for the deployer-behavior research: every
-- upgradeable-loader instruction read back from each program's ProgramData
-- history, and what each walk covered. Hand-written and IF NOT EXISTS
-- throughout, like 0008 and 0009. Applied with psql.
CREATE TABLE IF NOT EXISTS "loader_txns" (
	"network" text NOT NULL,
	"signature" text NOT NULL,
	"program_id" text NOT NULL,
	"outer_index" integer NOT NULL,
	"inner_index" integer NOT NULL,
	"program_data_address" text NOT NULL,
	"kind" text NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone,
	"failed" boolean NOT NULL,
	"fee_payer" text NOT NULL,
	"signers" text[] NOT NULL,
	"authority_before" text,
	"authority_after" text,
	"payer" text,
	"buffer" text,
	"invoked_by" text,
	"tx_version" text NOT NULL,
	"info" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loader_txns_pk" PRIMARY KEY ("signature","program_id","outer_index","inner_index")
);
CREATE INDEX IF NOT EXISTS "loader_txns_program_idx" ON "loader_txns" USING btree ("network","program_id","slot");
CREATE INDEX IF NOT EXISTS "loader_txns_kind_idx" ON "loader_txns" USING btree ("network","kind");
CREATE INDEX IF NOT EXISTS "loader_txns_fee_payer_idx" ON "loader_txns" USING btree ("fee_payer");
CREATE INDEX IF NOT EXISTS "loader_txns_authority_idx" ON "loader_txns" USING btree ("authority_after");

CREATE TABLE IF NOT EXISTS "loader_walks" (
	"network" text NOT NULL,
	"program_id" text NOT NULL,
	"program_data_address" text NOT NULL,
	"status" text NOT NULL,
	"signatures" integer NOT NULL,
	"non_loader" integer NOT NULL,
	"unread" integer NOT NULL,
	"loader_rows" integer NOT NULL,
	"newest_signature" text,
	"newest_slot" bigint,
	"oldest_slot" bigint,
	"error" text,
	"walked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loader_walks_pk" PRIMARY KEY ("network","program_id")
);
