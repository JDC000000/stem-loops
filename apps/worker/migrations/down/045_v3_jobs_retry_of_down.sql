-- 045_v3_jobs_retry_of_down.sql — drop the "Try again" columns (#321). Run by hand only.
-- WARNING: discards which job retried which and how many retries each song has used, so the
-- 2-retry cap starts again from zero for every failed song still in the table. The jobs
-- themselves are untouched.
-- Deploy the web without /api/jobs/:id/retry FIRST: with the columns gone that route
-- answers 500.
-- The runner never removes a _migrations row, so this file deletes 045's ledger row itself
-- (the 008 / 009 / 011 / 044 pattern); without it a re-apply of 045 would be skipped.

DROP INDEX IF EXISTS public.jobs_retry_of_idx;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS retried_at;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS retry_depth;
ALTER TABLE public.jobs DROP COLUMN IF EXISTS retry_of;
DELETE FROM public._migrations WHERE filename = '045_v3_jobs_retry_of.sql';
