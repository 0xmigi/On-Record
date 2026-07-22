ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "search_text" text;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_search_text_idx" ON "subjects" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subjects_name_trgm_idx" ON "subjects" USING gin (lower("name") gin_trgm_ops);
