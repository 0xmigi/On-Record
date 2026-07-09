CREATE TABLE "config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "copy_buckets" (
	"id" text PRIMARY KEY NOT NULL,
	"network" text NOT NULL,
	"canonical_sha256" text NOT NULL,
	"canonical_tlsh" text,
	"label" text,
	"member_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"velocity" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"category" text,
	"website" text,
	"llama_slug" text,
	"program_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"authorities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tvl" double precision,
	"tvl_updated_at" timestamp with time zone,
	"source" text DEFAULT 'labels' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"network" text NOT NULL,
	"type" text NOT NULL,
	"signature" text NOT NULL,
	"instruction_index" integer NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone,
	"program_id" text NOT NULL,
	"program_data_address" text,
	"authority_before" text,
	"authority_after" text,
	"sha256_before" text,
	"sha256_after" text,
	"enrichment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pipeline_stage" text DEFAULT 'ingested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fingerprint_corpus" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"network" text NOT NULL,
	"sha256" text NOT NULL,
	"tlsh" text,
	"size_bytes" integer NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnel_daily" (
	"date" text PRIMARY KEY NOT NULL,
	"network" text DEFAULT 'mainnet' NOT NULL,
	"raw" integer DEFAULT 0 NOT NULL,
	"unique" integer DEFAULT 0 NOT NULL,
	"novel" integer DEFAULT 0 NOT NULL,
	"clones" integer DEFAULT 0 NOT NULL,
	"variants" integer DEFAULT 0 NOT NULL,
	"by_category" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"network" text DEFAULT 'mainnet' NOT NULL,
	"name" text,
	"entity_key" text,
	"verified" boolean DEFAULT false NOT NULL,
	"repo_url" text,
	"repo_commit" text,
	"authority_class" text,
	"authority" text,
	"sha256" text,
	"tlsh" text,
	"size_bytes" integer,
	"bucket_id" text,
	"novelty_band" text,
	"novelty_score" double precision,
	"category" text,
	"instruction_count" integer,
	"idl_present" boolean DEFAULT false NOT NULL,
	"deployer_funding_source" text,
	"early_signers" integer,
	"tvl" double precision,
	"first_seen_slot" bigint,
	"first_seen_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"sha256" text,
	"tlsh" text,
	"size_bytes" integer,
	"authority" text,
	"program_id" text,
	"source" text NOT NULL,
	"note" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deploy_count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"matched_event_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "entities_slug_uq" ON "entities" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "events_sig_ix_uq" ON "events" USING btree ("signature","instruction_index");--> statement-breakpoint
CREATE INDEX "events_program_idx" ON "events" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "events_network_slot_idx" ON "events" USING btree ("network","slot");--> statement-breakpoint
CREATE INDEX "corpus_sha_idx" ON "fingerprint_corpus" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "corpus_network_size_idx" ON "fingerprint_corpus" USING btree ("network","size_bytes");--> statement-breakpoint
CREATE INDEX "subjects_entity_key_idx" ON "subjects" USING btree ("entity_key");--> statement-breakpoint
CREATE INDEX "subjects_bucket_idx" ON "subjects" USING btree ("bucket_id");--> statement-breakpoint
CREATE INDEX "subjects_radar_idx" ON "subjects" USING btree ("network","novelty_band","novelty_score");--> statement-breakpoint
CREATE INDEX "subjects_first_seen_idx" ON "subjects" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "watchlist_status_idx" ON "watchlist" USING btree ("status");--> statement-breakpoint
CREATE INDEX "watchlist_authority_idx" ON "watchlist" USING btree ("authority");