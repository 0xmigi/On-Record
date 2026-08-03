-- Per-program display names on the entity registry.
--
-- An entity name answers "who built this"; it does not answer "which of their
-- programs is this". Jupiter owns a dozen mainnet programs and labelling every
-- row "Jupiter" is accurate and useless — the aggregator, the perps engine and
-- the lend vaults are different things. This map carries the specific name for
-- the ids that need one; everything else keeps the entity name.
ALTER TABLE "entities"
  ADD COLUMN IF NOT EXISTS "program_names" jsonb DEFAULT '{}'::jsonb NOT NULL;
