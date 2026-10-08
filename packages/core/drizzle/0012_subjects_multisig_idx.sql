-- Builder profiles look up the programs a Squads multisig holds by
-- facts->'multisig'->>'address'. Without an index that reads every program's
-- facts (7.2s on mainnet, 2026-10-08, past the web's 10s API timeout on a cold
-- start). Partial: only the ~600 programs held by a multisig carry the key.
-- Hand-written like 0008–0011; applied with psql. CONCURRENTLY, so the live
-- pipeline's writes to subjects aren't blocked while it builds (run it outside
-- a transaction).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "subjects_multisig_address_idx"
	ON "subjects" ((facts->'multisig'->>'address'))
	WHERE (facts->'multisig'->>'address') IS NOT NULL;

-- ...and by upgrade authority (the profile, and alerts.ts programsControlledBy,
-- both look programs up by it; it had no index and was read by a full scan)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "subjects_authority_idx"
	ON "subjects" ("authority")
	WHERE "authority" IS NOT NULL;
