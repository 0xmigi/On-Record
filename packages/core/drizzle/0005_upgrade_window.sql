-- The upgrade stream is dated by when a program's code last changed, not by
-- when On Record first met the program. deployType is a lifetime flag, so the
-- old firstSeenAt window asked "first seen in this window AND ever upgraded" —
-- which hid every upgrade of an established program. The radar and the funnel
-- now range-scan coalesce(last_event_at, first_seen_at); index that expression
-- so the 24h/7d/30d windows stay index-only instead of seq-scanning subjects.
CREATE INDEX IF NOT EXISTS "subjects_upgraded_idx"
  ON "subjects" ("network", "deploy_type", (coalesce("last_event_at", "first_seen_at")) DESC);
