-- 042_v3_job_allowance_debits_down.sql — drop the link-job allowance debit ledger and its
-- restore function. Run by hand only.
-- Safe for the code: the web route treats a missing table (42P01) and the worker a missing
-- function (42883) as "not migrated yet" and fall back to today's behaviour (no restore).
-- WARNING: dropping the table discards the record of what each in-flight link job spent,
-- so a link job that fails for our reasons after this point is NOT given its song back,
-- and re-applying 042 does not recover those rows.
-- The runner does NOT remove the _migrations row: run
--   DELETE FROM _migrations WHERE filename = '042_v3_job_allowance_debits.sql';
-- or re-applying 042 is skipped.

DROP FUNCTION IF EXISTS public.restore_job_allowance(uuid, text[]);
DROP TABLE IF EXISTS public.job_allowance_debits;
