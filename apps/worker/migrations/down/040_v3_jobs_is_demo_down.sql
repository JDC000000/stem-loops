-- 040_v3_jobs_is_demo_down.sql — drop jobs.is_demo. Run by hand only.
--
-- WARNING: once this runs, the demo songs are ordinary jobs again. Their expires_at is
-- long past, so the NEXT retention sweep deletes their R2 objects (stems, chords, source)
-- and their rows. Export or re-flag them first if they must survive.
--
-- Deploy the web and worker code that does NOT read the column FIRST: the retention SQL in
-- that code (lib/retention.ts, cleanup.py) names jobs.is_demo, so every job route and
-- every sweep fails with "column jobs.is_demo does not exist" until it is rolled back.
--
-- Not applied by the runner — `make migrate` globs only migrations/*.sql. The runner's
-- ledger row for 040 must be removed by hand as well, or `make migrate` will not re-apply:
--     DELETE FROM public._migrations WHERE filename = '040_v3_jobs_is_demo.sql';

ALTER TABLE public.jobs DROP COLUMN IF EXISTS is_demo;
