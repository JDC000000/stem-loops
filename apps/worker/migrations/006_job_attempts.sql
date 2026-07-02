-- Migration 006: per-job retry-attempt counter for the reaper re-drive path.
-- Security re-verification BLOCKER #4: the operator requirement "max 3 attempts,
-- exponential backoff" was set as pg-boss options (queue.ts) but is dead config —
-- the Python worker consumes the `jobs` table via FOR UPDATE SKIP LOCKED and never
-- touches pg-boss's retry engine. The real re-drive is reaper.py, which had no
-- attempt cap and no backoff. This column lets the reaper bound retries and space
-- them out (see reaper.reap_stale_jobs).

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
