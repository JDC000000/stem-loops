-- 042_v3_job_allowance_debits.sql — give the monthly song (or trial song) back when a link job
-- fails for OUR reasons (QA-64). Approved by Jon, 2026-11-19.
--
-- THE BUG
--   A signed-in YouTube-link job spends, inside the POST /api/jobs insert transaction:
--     * one unit of the monthly allowance (entitlements.jobs_used): Free (capped, 5/month),
--       Pro and Studio (bumpJobsUsed) alike, and
--     * on the free TRIAL path, ALSO one trial song (trial_grants.songs_used).
--   Credits are never spent on a link job (credit_consumption accepts upload jobs only,
--   migrations 013/039), so job_failure.REFUND_SQL (#297) never matches one. When a link
--   job failed because of us (our fetch proxy, our storage, a provider outage, a job we
--   abandoned) nothing gave the unit back.
--
-- WHAT THIS ADDS
--   1. public.job_allowance_debits — one row per link job that spent an allowance unit,
--      written by the web route IN THE SAME TRANSACTION as the jobs INSERT and the debit
--      (lib/billing/rate-limit.ts recordAllowanceDebit). It records exactly what was spent:
--        allowance_period_start  entitlements.period_start the unit was counted in
--                                (NULL = no allowance unit was spent)
--        trial_song              true = a trial song was also spent
--      and, once, what was given back (restored_at + allowance_restored + trial_restored).
--      job_id is the PRIMARY KEY: one debit record per job, so one restore per job.
--
--   2. public.restore_job_allowance(p_job_id uuid, p_our_fault_codes text[])
--        RETURNS TABLE (allowance_restored boolean, trial_restored boolean)
--      Called by the worker (job_failure.restore_allowance_if_owed) inside the same
--      transaction that marks the job failed (fail_job, the reaper). Exactly once per job:
--        * claims the debit row with SELECT ... FOR UPDATE WHERE restored_at IS NULL; a
--          concurrent caller blocks on that row lock and, under READ COMMITTED, re-checks the
--          row after the winner commits, finds restored_at set and does nothing. Worker
--          retries, a reaper requeue, the pipeline + deadline both failing the job, and
--          concurrent sweeps therefore restore at most once.
--        * only when the job's STORED status is 'failed' and its STORED error_code is one
--          of p_our_fault_codes (the worker passes job_failure.OUR_FAULT_CODES, the same
--          single source REFUND_SQL uses). The first failure wins (_FAIL_SQL), so a user-
--          fault failure (DOWNLOAD_BLOCKED, DOWNLOAD_PRIVATE, ...) can never be turned into
--          a restore by a later INTERNAL_ERROR attempt. A user-fault failure leaves the row
--          unclaimed and nothing is given back.
--        * never below zero: each decrement is guarded (> 0), on top of the CHECKs in 013.
--        * only within the period it was spent in (decision, recorded here):
--            - allowance: only if entitlements.period_start still equals the recorded
--              period_start AND that period has not ended. If the month rolled over (or a
--              subscription change moved the period), the unit belonged to a period that is
--              over; crediting the NEW month would hand out a unit nobody spent there. The
--              row is still claimed (restored_at set, allowance_restored = false), so the
--              outcome is on record and nothing retries it.
--            - trial song: only while the trial has not expired. An expired trial has no
--              songs to give back into.
--        * lock order matches the web route (trial_grants row, then entitlements row), so it
--          cannot deadlock against a concurrent trial job by the same user.
--      SECURITY INVOKER (the default): it runs with the caller's own privileges, which for
--      the worker role already include UPDATE on entitlements / trial_grants (013). EXECUTE
--      is revoked from PUBLIC, anon and authenticated (Supabase grants EXECUTE on every new
--      public function to those roles: see 032) and granted to stemloops_app.
--
-- WHAT IT DOES NOT DO
--   * Jobs created before this migration AND the web change have no debit row and are not
--     restored (the unit is gone, as before). Anonymous jobs spend no allowance and have no
--     row. Upload jobs are not recorded here: a credit-funded upload is refunded by
--     REFUND_SQL, and a quota-funded upload failure is unchanged (separate decision).
--   * No backfill: an old failed job's period has, in general, already been used up.
--
-- RLS: backend-only. Read and written only by the app role; never exposed to end users.
--   anon / authenticated get nothing (Supabase grants them ALL on new public tables by
--   default, so the REVOKE is load-bearing). DELETE / TRUNCATE are revoked from the app
--   role: deleting a row would let a later failure path restore the same job twice. Rows go
--   away only by FK cascade, with their job (retention sweep) or user (account deletion).
--
-- DEPLOY ORDER: either order is safe.
--   * web before 042: recordAllowanceDebit() runs in a SAVEPOINT and treats only
--     "relation does not exist" (42P01) as "not migrated yet": the job is created as before
--     with no debit row (so no restore, exactly today's behaviour) and Sentry gets one
--     warning per process. Any other error still fails the request.
--   * worker before 042: restore_allowance_if_owed() runs in a SAVEPOINT and treats only
--     "function does not exist" (42883) as "not migrated yet"; the failure and the credit
--     refund commit as before.
--
-- APPLYING IT to staging or production needs Jon (migration on a deployed database):
--   `make migrate` with that DATABASE_URL, or paste this file into the SQL editor and then
--       INSERT INTO public._migrations(filename) VALUES ('042_v3_job_allowance_debits.sql');
--   Verify afterwards:
--       SELECT to_regclass('public.job_allowance_debits');                      -- not null
--       SELECT relrowsecurity FROM pg_class WHERE oid = 'public.job_allowance_debits'::regclass;  -- t
--       SELECT has_function_privilege('stemloops_app',
--         'public.restore_job_allowance(uuid, text[])', 'EXECUTE');            -- t
--
-- Idempotent: IF NOT EXISTS / DROP POLICY IF EXISTS / CREATE OR REPLACE / guarded DO block.
-- Down: migrations/down/042_v3_job_allowance_debits_down.sql.
--
-- rls-backend-only: job_allowance_debits

CREATE TABLE IF NOT EXISTS public.job_allowance_debits (
  job_id                 uuid        PRIMARY KEY REFERENCES public.jobs(id) ON DELETE CASCADE,
  user_id                uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  allowance_period_start timestamptz,
  trial_song             boolean     NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  restored_at            timestamptz,
  allowance_restored     boolean,
  trial_restored         boolean,

  -- The three restore columns are written together, once, by restore_job_allowance().
  CONSTRAINT job_allowance_debits_restore_shape CHECK (
    (restored_at IS NULL) = (allowance_restored IS NULL)
    AND (restored_at IS NULL) = (trial_restored IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS job_allowance_debits_user_idx
  ON public.job_allowance_debits (user_id);

ALTER TABLE public.job_allowance_debits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stemloops_app_all ON public.job_allowance_debits;
CREATE POLICY stemloops_app_all ON public.job_allowance_debits
  FOR ALL TO stemloops_app USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.job_allowance_debits TO stemloops_app;
REVOKE DELETE, TRUNCATE ON public.job_allowance_debits FROM stemloops_app;
REVOKE ALL ON public.job_allowance_debits FROM anon, authenticated;

-- cowork_ro read path (§A3 pattern). No-op where cowork_ro does not exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cowork_ro') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'job_allowance_debits' AND policyname = 'cowork_ro_read'
    ) THEN
      CREATE POLICY cowork_ro_read ON public.job_allowance_debits
        FOR SELECT TO cowork_ro USING (true);
    END IF;
  END IF;
END $$;

COMMENT ON TABLE public.job_allowance_debits IS
  'What each signed-in link job spent (monthly allowance unit in period allowance_period_start, and/or a trial song) and, once, what was given back on an our-fault failure. See migration 042 header.';

CREATE OR REPLACE FUNCTION public.restore_job_allowance(p_job_id uuid, p_our_fault_codes text[])
  RETURNS TABLE (allowance_restored boolean, trial_restored boolean)
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_user   uuid;
  v_period timestamptz;
  v_trial  boolean;
  v_allow_back boolean := false;
  v_trial_back boolean := false;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'restore_job_allowance: p_job_id must not be null'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Claim the debit row. The row lock + `restored_at IS NULL` is the exactly-once guarantee.
  SELECT d.user_id, d.allowance_period_start, d.trial_song
    INTO v_user, v_period, v_trial
    FROM public.job_allowance_debits d
    JOIN public.jobs j ON j.id = d.job_id
   WHERE d.job_id = p_job_id
     AND d.restored_at IS NULL
     AND j.user_id = d.user_id
     AND j.status = 'failed'
     AND j.error_code = ANY(COALESCE(p_our_fault_codes, ARRAY[]::text[]))
   FOR UPDATE OF d;
  IF NOT FOUND THEN
    RETURN;  -- nothing owed: no row, already restored, not failed, or not our fault
  END IF;

  -- Trial first, then the allowance: the same row-lock order as POST /api/jobs.
  IF v_trial THEN
    UPDATE public.trial_grants t
       SET songs_used = t.songs_used - 1
     WHERE t.user_id = v_user
       AND t.songs_used > 0
       AND t.expires_at > now();
    v_trial_back := FOUND;
  END IF;

  IF v_period IS NOT NULL THEN
    UPDATE public.entitlements e
       SET jobs_used = e.jobs_used - 1
     WHERE e.user_id = v_user
       AND e.period_start = v_period
       AND e.period_end > now()
       AND e.jobs_used > 0;
    v_allow_back := FOUND;
  END IF;

  UPDATE public.job_allowance_debits d
     SET restored_at = now(),
         allowance_restored = v_allow_back,
         trial_restored = v_trial_back
   WHERE d.job_id = p_job_id;

  RETURN QUERY SELECT v_allow_back, v_trial_back;
END;
$$;

COMMENT ON FUNCTION public.restore_job_allowance(uuid, text[]) IS
  'QA-64: give back, once, the monthly allowance unit / trial song a failed link job spent, when the stored error_code is ours. See migration 042 header.';

REVOKE ALL ON FUNCTION public.restore_job_allowance(uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_job_allowance(uuid, text[]) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_job_allowance(uuid, text[]) TO stemloops_app;
