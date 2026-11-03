-- 013_v3_commercial_down.sql — reverse of 013_v3_commercial.sql.
-- Drop order is dependency-aware: trigger → view → children → parents.
-- IF EXISTS everywhere so it's safe to run partially-applied.

-- auth.users trigger first so a new signup during rollback doesn't try to
-- insert into tables being dropped.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

-- credits trigger + function
DROP TRIGGER IF EXISTS credit_decrement_check ON public.credit_consumption;
DROP FUNCTION IF EXISTS public.check_credit_decrement();

-- derived view (before the tables it reads)
DROP VIEW IF EXISTS public.v_credit_balance;

-- tables, children first so FKs don't block
DROP TABLE IF EXISTS public.trial_grants;
DROP TABLE IF EXISTS public.promo_redemptions;
DROP TABLE IF EXISTS public.credit_consumption;
DROP TABLE IF EXISTS public.credit_purchases;

-- remove the FK column we added to jobs (RESTRICT on the FK means we must drop
-- the column before dropping public.users)
ALTER TABLE public.jobs DROP COLUMN IF EXISTS user_id;

DROP TABLE IF EXISTS public.entitlements;
DROP TABLE IF EXISTS public.subscriptions;
DROP TABLE IF EXISTS public.customers_billing;
DROP TABLE IF EXISTS public.usage_events;
DROP TABLE IF EXISTS public.plans;
DROP TABLE IF EXISTS public.users;

-- citext extension is left in place; other migrations may depend on it.
