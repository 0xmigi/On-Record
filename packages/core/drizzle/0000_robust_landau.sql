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
	"velocity" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_story_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "digests" (
	"date" text PRIMARY KEY NOT NULL,
	"story_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"tvl_at_event" double precision,
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
CREATE TABLE "stories" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"headline" text NOT NULL,
	"body" text NOT NULL,
	"facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inference" jsonb,
	"subjects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rank_score" double precision DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"dead_letter_reason" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"novelty_score" double precision,
	"tvl" double precision,
	"first_seen_slot" bigint,
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
CREATE INDEX "stories_status_published_idx" ON "stories" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "stories_type_idx" ON "stories" USING btree ("type");--> statement-breakpoint
CREATE INDEX "subjects_entity_key_idx" ON "subjects" USING btree ("entity_key");--> statement-breakpoint
CREATE INDEX "subjects_bucket_idx" ON "subjects" USING btree ("bucket_id");--> statement-breakpoint
CREATE INDEX "watchlist_status_idx" ON "watchlist" USING btree ("status");--> statement-breakpoint
CREATE INDEX "watchlist_authority_idx" ON "watchlist" USING btree ("authority");