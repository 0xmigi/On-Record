CREATE TABLE IF NOT EXISTS "saved_lists" (
	"id" text PRIMARY KEY NOT NULL,
	"program_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
