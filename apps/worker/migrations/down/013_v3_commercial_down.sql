-- 013_v3_commercial_down.sql — reverse of 013_v3_commercial.sql.
-- Drop order is dependency-aware: triggers → functions → view → children → parents.
-- IF EXISTS everywhere so it is safe to run partially-applied.

-- auth.users trigger first so a new signup during rollback does not try to
-- insert into tables being dropped.
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

-- subscriptions updated_at trigger (Lens A finding #8)
DROP TRIGGER IF EXISTS subscriptions_touch_updated_at ON public.subscriptions;
DROP FUNCTION IF EXISTS public.touch_subscription_updated_at();

-- credits trigger + function
DROP TRIGGER IF EXISTS credit_decrement_check ON public.credit_consumption;
DROP FUNCTION IF EXISTS public.check_credit_decrement();

-- derived view (before the tables it reads)
DROP VIEW IF EXISTS public.v_credit_balance;

-- tables, children first so FKs do not block (Lens A finding #13 wording fix:
-- any incoming FK blocks DROP TABLE regardless of ON DELETE clause; dropping
-- the column before the parent table is what keeps order correct here).
DROP TABLE IF EXISTS public.trial_grants;
DROP TABLE IF EXISTS public.promo_redemptions;
DROP TABLE IF EXISTS public.credit_consumption;
DROP TABLE IF EXISTS public.credit_purchases;

-- remove the jobs.user_id FK column before dropping public.users (any
-- incoming FK blocks the parent drop whatever its ON DELETE says).
ALTER TABLE public.jobs DROP COLUMN IF EXISTS user_id;

DROP TABLE IF EXISTS public.entitlements;
DROP TABLE IF EXISTS public.subscriptions;
DROP TABLE IF EXISTS public.customers_billing;
DROP TABLE IF EXISTS public.usage_events;
DROP TABLE IF EXISTS public.plans;
DROP TABLE IF EXISTS public.users;

-- citext extension is left in place; other migrations may depend on it.
