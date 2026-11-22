-- 045_v3_jobs_retry_of.sql — "Try again" on a failed link song (#321; Phase B, B3). A retry is
-- a NEW job that points at the job it retries; the failed original stays failed, as a record.
--
-- WHAT THIS ADDS (three columns on public.jobs; no new table, no new function)
--   1. retry_of uuid NULL REFERENCES public.jobs(id) ON DELETE SET NULL
--      The job this one retries (#321 constraint 1: §6.3's state machine is fixed and `failed`
--      is terminal, so a failed row is never resurrected). ON DELETE SET NULL: the retention
--      sweep deleting the original must not take the retry with it, and must not be blocked
--      by it either. The job page links "Retry of <original>" while the original exists.
--      Indexed (partial, retry_of IS NOT NULL) for the "which job retried this one" lookup.
--
--   2. retry_depth smallint NOT NULL DEFAULT 0, CHECK (retry_depth BETWEEN 0 AND 2)
--      0 = an original, 1 = a first retry, 2 = a second retry. The cap (Jon, D7: "2 user
--      retries per original") is read from THIS column, never by walking the retry_of chain:
--      the chain is broken by the sweep (SET NULL above), the depth is not. A retry is written
--      with retry_depth = parent.retry_depth + 1 by POST /api/jobs/:id/retry, under a
--      FOR UPDATE lock on the parent row (lib/jobs/create-link-job.ts, mirror_restore). The
--      CHECK is the database's own backstop: no code path can write a third retry.
--
--   3. retried_at timestamptz NULL
--      Set on the parent, in the same transaction, when (and only when) its retry row was
--      inserted. A job is retried at most once: a second "Try again" on the same parent finds
--      retried_at set and gets the existing retry (or, if that was swept, a refusal). It is
--      never set when the per-IP limit refused the INSERT (C-1), so a 429 leaves the button.
--
--   `jobs.attempts` is NOT reused (#321 constraint 2): it is the reaper's poison counter.
--
-- RLS: unchanged. public.jobs already has RLS and its policies (backend-only); new columns
--   inherit the table's grants. No new table, so no rls-backend-only marker and no D-b
--   backstop trigger: nothing here holds a user_id. No auth.* reference, so no M-3 stub.
--
-- DEPLOY ORDER: Jon applies 045 -> merge -> web deploys. Web before 045 would 500 the new
--   /api/jobs/:id/retry route (column does not exist); nothing else reads these columns. The
--   worker does not read them and needs no deploy.
--
-- APPLYING IT to staging or production needs Jon (migration on a deployed database):
--   `make migrate` with that DATABASE_URL, or paste this file into the SQL editor and then
--       INSERT INTO public._migrations(filename) VALUES ('045_v3_jobs_retry_of.sql');
--   Verify afterwards:
--       SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
--        WHERE table_schema = 'public' AND table_name = 'jobs'
--          AND column_name IN ('retry_of', 'retry_depth', 'retried_at') ORDER BY 1;  -- 3 rows
--       SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--        WHERE conname IN ('jobs_retry_of_fkey', 'jobs_retry_depth_range');           -- 2 rows
--       SELECT confdeltype FROM pg_constraint WHERE conname = 'jobs_retry_of_fkey';     -- n (SET NULL)
--       SELECT indexname FROM pg_indexes WHERE indexname = 'jobs_retry_of_idx';         -- 1 row
--       SELECT count(*) FROM public.jobs WHERE retry_depth <> 0 OR retry_of IS NOT NULL
--          OR retried_at IS NOT NULL;                                                    -- 0
--
-- Idempotent: ADD COLUMN IF NOT EXISTS (the column's constraint is skipped with it when the
-- column already exists) / CREATE INDEX IF NOT EXISTS.
-- Down: migrations/down/045_v3_jobs_retry_of_down.sql.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS retry_of uuid NULL
    CONSTRAINT jobs_retry_of_fkey REFERENCES public.jobs(id) ON DELETE SET NULL;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS retry_depth smallint NOT NULL DEFAULT 0
    CONSTRAINT jobs_retry_depth_range CHECK (retry_depth BETWEEN 0 AND 2);

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS retried_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS jobs_retry_of_idx
  ON public.jobs (retry_of) WHERE retry_of IS NOT NULL;

COMMENT ON COLUMN public.jobs.retry_of IS
  'The job this one retries ("Try again", #321). SET NULL when that job is swept. See migration 045.';
COMMENT ON COLUMN public.jobs.retry_depth IS
  '0 = original, 1 or 2 = user retry number. The retry cap reads this, not the retry_of chain. See migration 045.';
COMMENT ON COLUMN public.jobs.retried_at IS
  'When this job''s one retry was created (set only when the retry row was inserted). See migration 045.';
