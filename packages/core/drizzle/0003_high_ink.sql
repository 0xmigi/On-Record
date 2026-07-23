CREATE TABLE "poll_cursors" (
	"network" text PRIMARY KEY NOT NULL,
	"slot" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "profile" jsonb;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "first_deploy_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "deploy_type" text;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "search_text" text;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "crate" text;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "source_paths" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_crate_idx" ON "subjects" USING btree ("network","crate");