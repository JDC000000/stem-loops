-- 030_v3_jobs_klangio_job_id.sql — durable per-job record of a Klangio submission.
--
-- Why this exists:
--   Klangio bills $0.20 per request past the 500/month plan and has no idempotency
--   key and no job-list endpoint. Until now the only durable trace of a spend was
--   the global klangio_usage counter, so a rerun of the same job (reaper requeue
--   after a deploy/OOM mid-poll, a failed R2 artifact upload, a zero-segment
--   result) could not tell "already paid" from "never asked" and POSTed again.
--
--   This column is the Klangio analogue of jobs.replicate_prediction_id: the
--   worker records the Klangio job id as soon as the POST returns, BEFORE polling.
--   Klangio's status and result GETs are idempotent and free, so a rerun
--   reattaches to the same job instead of paying again.
--
-- Values (all written by the worker, one job = at most one billed request):
--   NULL          never submitted (or the submit was provably never sent).
--   'submitting'  sentinel written by a compare-and-set BEFORE the POST. If the
--                 process dies between the POST and recording the id, the paid
--                 job id is lost; the sentinel tells the next run "a request may
--                 already have been paid for" so it skips chords rather than
--                 risk a second bill. It also serialises two workers racing on
--                 the same job (deploy overlap).
--   <job id>      the Klangio job id (matches ^[A-Za-z0-9_-]{1,128}$); reattach.
--
-- DEPLOY ORDER: apply this migration BEFORE the worker code that reads/writes the
-- column ships. New code against the old schema fails every chord attempt with
-- "column klangio_job_id does not exist" (swallowed as a provider_failed
-- tombstone, so jobs still complete, but chords are lost and nothing is recorded).
-- Old code against the new schema is unaffected (the column is nullable, unused).
--
-- Existing RLS/grants on public.jobs are table-level, so the new column inherits
-- them; nothing to add. Idempotent: ADD COLUMN IF NOT EXISTS.
-- Down: migrations/down/030_v3_jobs_klangio_job_id_down.sql.

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS klangio_job_id text;

COMMENT ON COLUMN public.jobs.klangio_job_id IS
  'Klangio chord-recognition job id (reattach instead of re-bill); ''submitting'' = POST may have been paid but id not recorded. See migration header.';
