-- The archive index: one row per program the Old Faithful backfill holds a
-- loader history for (deployed, upgraded or closed since 2023-07-18), so search
-- can find a program On Record never saw live — most of them closed again.
-- The history itself is not here: it is read per program from R2
-- (packages/core/src/history.ts). This table is only what a search result or a
-- filter needs. ~69k rows, ~15 MB. Hand-written like 0008–0014; applied with psql.
CREATE TABLE IF NOT EXISTS "history_programs" (
	"program_id" text PRIMARY KEY NOT NULL,
	"name" text,
	"framework" text NOT NULL,
	"first_deploy_at" timestamp with time zone,
	"last_change_at" timestamp with time zone,
	"versions" integer NOT NULL,
	"upgrades" integer NOT NULL,
	"closed_at" timestamp with time zone,
	"authority" text,
	"deployer" text
);
CREATE INDEX IF NOT EXISTS "history_programs_name_idx" ON "history_programs" (lower("name")) WHERE "name" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "history_programs_deployer_idx" ON "history_programs" ("deployer");
