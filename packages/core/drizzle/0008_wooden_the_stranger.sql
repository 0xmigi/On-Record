-- program_references: the edge list — which programs a binary NAMES.
--
-- Trimmed from what drizzle-kit generated. The generator also emitted
-- `saved_lists`, `entities.program_names` and `subjects_upgraded_idx`, all of
-- which are already live — they were applied by `db:push` without the snapshot
-- catching up, so the diff read them as new. The snapshot is correct now; only
-- the genuinely new object is applied here. IF NOT EXISTS throughout, because
-- this file has to be safe to run against a database that already has it.
CREATE TABLE IF NOT EXISTS "program_references" (
	"id" text PRIMARY KEY NOT NULL,
	"network" text NOT NULL,
	"from_program_id" text NOT NULL,
	"to_program_id" text NOT NULL,
	"from_sha256" text,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prog_ref_edge_idx" ON "program_references" USING btree ("network","from_program_id","to_program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prog_ref_from_idx" ON "program_references" USING btree ("network","from_program_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prog_ref_to_idx" ON "program_references" USING btree ("network","to_program_id");
