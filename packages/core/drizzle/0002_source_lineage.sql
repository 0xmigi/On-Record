ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "crate" text;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "source_paths" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_crate_idx" ON "subjects" USING btree ("network","crate");
