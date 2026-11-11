-- 033_v3_loop_requests_down.sql — reverse of 033. Run by hand only; the runner
-- globs migrations/*.sql and never descends into down/.
--
-- WHAT COMING BACK DOWN MEANS, PLAINLY.
--   Applying this restores the pre-033 SCHEMA, not the pre-033 DATA. Any loop
--   row the eager pass described but the cutter never cut has a `r2_key`
--   pointing at an object that does not exist, and dropping `cut_at` removes
--   the only column that said so. After this runs, `GET /api/jobs/:id` would
--   mint a signed URL for every row again, and an uncut row's URL is a 404.
--
--   So the ORDER here is load-bearing: delete the uncut rows FIRST, while
--   `cut_at` still exists to identify them, and only then drop the column. The
--   player loses those sections (it derives them from these rows) but a job
--   whose loops were cut keeps everything, and nothing is left pointing at
--   absent bytes. A down migration that left a 404 behind would be its own
--   defect.
--
--   The objects themselves are not touched: retention sweeps a job's whole
--   `{job_id}/` prefix (cleanup.py `delete_prefix`), which still covers both
--   the old `{job_id}/{stem}/{section}_{idx}.wav` keys and the new
--   `{job_id}/{stem}/{bars}bar_{section}_{idx}.wav` ones.

-- 1. Uncut rows cannot survive the loss of `cut_at`.
DELETE FROM public.loops WHERE cut_at IS NULL;

-- 2. Now the column and its partial index can go.
DROP INDEX IF EXISTS public.loops_uncut_idx;
ALTER TABLE public.loops DROP COLUMN IF EXISTS cut_at;

-- 3. The request queue. Dropping the table drops its indexes and policies with
--    it; the grants go with the table too.
DROP TABLE IF EXISTS public.loop_requests;
