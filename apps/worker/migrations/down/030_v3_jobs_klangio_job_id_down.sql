-- 030_v3_jobs_klangio_job_id_down.sql — drop the per-job Klangio job id. Run by hand only.
-- WARNING: this discards the record that lets a rerun reattach to an already-paid
-- Klangio job. Deploy the worker code that does NOT use the column first, or
-- every rerun of an in-flight job will POST (and bill) again.

ALTER TABLE public.jobs DROP COLUMN IF EXISTS klangio_job_id;
