-- 040_v3_jobs_is_demo.sql — jobs.is_demo: the three demo songs are never swept.
--
-- Slice 0 of V3 (DESIGN-PROPOSAL v1.4 §1 "Delivery plan", P3.1). Jon's three demo songs
-- (The Royal Sundowners: Lucky Ticket, I'm Asking You, Offline) are processed once
-- through the real pipeline and must survive until Slice 2 ships the demo routes. Without
-- this flag the retention sweep deletes them like any other job (24 h on Free, or 30 days
-- after a subscription ends).
--
-- WHAT THIS COLUMN DOES (and only this, in Slice 0):
--   The retention rule — apps/web/src/lib/retention.ts JOB_RETAINED_UNTIL_SQL and
--   apps/worker/src/worker/cleanup.py RETAINED_UNTIL_SQL, pinned identical by
--   tests/test_paid_retention.py — returns the FINITE date '2099-12-31T00:00:00Z' for an
--   is_demo row. So the sweep never selects it, and every web route serves it with a
--   finite expires_at. Not 'infinity': node-pg turns that into Infinity, `new Date` gives
--   NaN, lib/library.ts drops the row and the stems/download routes fail closed to
--   1-second signed URLs.
--
-- WHAT IT DOES NOT DO: it opens NO read path. Who may read a demo song (mayReadJob, the
-- signed-out player, an explicit is_demo denial on download/loops) is Slice 2. Until then a
-- demo row is an ordinary owned job, readable by its owner only.
--
-- WHO MAY WRITE IT: nobody but an operator. No application code writes is_demo — the
-- INSERT in POST /api/jobs does not name it, so every new job takes the DEFAULT false.
-- The three rows are flagged by a separate, Jon-approved named write:
--     UPDATE public.jobs SET is_demo = true WHERE id IN ('<id1>','<id2>','<id3>');
-- No grant or policy is added. public.jobs is a backend-only table (009's
-- `rls-backend-only` marker): RLS is on and the only policies are for stemloops_app (011)
-- and, where it exists, cowork_ro (SELECT). anon and authenticated have no policy on jobs,
-- so a browser holding the Supabase anon key cannot read or write any column of it,
-- this one included. A column-level REVOKE would be meaningless here: Postgres checks the
-- table-level grant first, and the new column inherits the table's existing ACL and RLS,
-- exactly like 030's klangio_job_id.
--
-- Lock and cost: ADD COLUMN ... NOT NULL DEFAULT <constant> is a catalog-only change on
-- PG 11+ (no table rewrite); it takes a brief ACCESS EXCLUSIVE lock on jobs.
--
-- DEPLOY ORDER: apply this migration BEFORE the web and worker code that reads the column
-- ships. New code against the old schema fails every job read and every sweep with
-- "column jobs.is_demo does not exist". Old code against the new schema is unaffected.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; COMMENT is a plain overwrite.
-- Down: migrations/down/040_v3_jobs_is_demo_down.sql.

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.jobs.is_demo IS
  'Demo song (V3 P3.1): excluded from the retention sweep (retained until 2099-12-31). Set only by an operator-approved named write. See migration 040.';
