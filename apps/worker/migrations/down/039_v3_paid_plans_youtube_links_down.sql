-- 039_v3_paid_plans_youtube_links_down.sql — restore the state 034 left.
--
-- 039 is pure DML on two existing rows, so the reverse is the same UPDATE with
-- 034's value (pro/studio services empty). Free is not touched by 039 and is
-- not touched here.
--
-- Deliberately an UPDATE, not a DELETE: entitlements and subscriptions hold FKs
-- on plans(code).
--
-- Effect with this applied: enforceEntitlement('start_job_youtube') refuses
-- link jobs for Pro and Studio again ('service not in plan', 402) and /pricing
-- drops "Link import: YouTube" from both cards. No deploy needed — the gate is
-- data-driven. Existing paid link jobs are untouched.
--
-- Not applied by the runner — `make migrate` globs only migrations/*.sql.
-- Run by hand against a throwaway DB.

UPDATE public.plans
   SET services = ARRAY[]::text[]
 WHERE code IN ('pro', 'studio');
