-- 013_v3_commercial.sql — V3 Phase 1a commercial layer.
--
-- Creates the account + billing + credits + usage + promo + trial schema per
-- TSD-V3-DELTA.md §1.9 (credits ledger) + §2.3 (DDL) + §2.4 (auth trigger).
-- Locked schema per Jon 2026-11-02T22:45; §1.6a Chordify-aligned legal 2026-11-03.
--
-- Supersedes closed PRs #10 and #17 (both merged schemas that diverged from the TSD:
-- wrong column names, wrong role (service_role), missing processor-separation trigger,
-- v_credit_balance exposing extra columns the free tier must not see). Full audit:
-- 03-adversarial-review/full-audit-session-3/AUDIT-1.md.
--
-- Precondition: migrations 001-008 applied, SL-B26 role catchup (009+011) applied
-- so `stemloops_app` + `cowork_ro` roles follow the handoff 10-db-rls-and-roles.sql
-- §A1/A2/A3 pattern. This migration adds 10 NEW tables + 2 views/functions + 1 trigger
-- and uses the same template — every new table gets:
--   (a) ENABLE ROW LEVEL SECURITY
--   (b) an auth.uid() self-read policy (or a public-read policy for `plans`)
--   (c) stemloops_app_all FOR ALL policy (worker write path, per §A2)
--   (d) cowork_ro_read policy applied via the §A3 DO loop at the end
--
-- Down migration: 013_v3_commercial_down.sql (same folder, drops in reverse order).

-- rls-backend-only: plans
-- plans is a PUBLIC catalog table (public-read policy for anon+authenticated,
-- plus the stemloops_app_all write policy). Not per-user data, so the CI
-- gate auth.uid() requirement does not apply. Marker keeps check_rls happy
-- until that gate grows a dedicated public-read category (separate PR).
-- No apostrophes in this block on purpose: the gate string-literal masker
-- currently mistakes apostrophes in line comments for string delimiters.

-- A1. role must exist (NOLOGIN on a fresh DB; prod already has LOGIN).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stemloops_app') THEN
    CREATE ROLE stemloops_app NOLOGIN;
  END IF;
END $$;

-- citext for case-insensitive email uniqueness.
CREATE EXTENSION IF NOT EXISTS citext;

------------------------------------------------------------------------------
-- 1. users (shadow of auth.users for FKs + extra app fields)
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         citext UNIQUE NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  display_name  text,
  marketing_opt_in boolean NOT NULL DEFAULT false
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
-- self-read only (no self-write: Supabase trigger seeds rows)
DROP POLICY IF EXISTS users_self_read ON public.users;
CREATE POLICY users_self_read ON public.users FOR SELECT TO authenticated USING (auth.uid() = id);
-- worker write path per §A2
DROP POLICY IF EXISTS stemloops_app_all ON public.users;
CREATE POLICY stemloops_app_all ON public.users FOR ALL TO stemloops_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO stemloops_app;

------------------------------------------------------------------------------
-- 2. plans (DB-driven feature flags; seeded in 014_v3_seed_plans.sql)
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.plans (
  code              text PRIMARY KEY,                  -- 'free' | 'pro' | 'studio'
  display_name      text NOT NULL,
  -- CAD cents per TSD §1.2. The Stripe sandbox is a BC CAD catalog, so
  -- storing values here as USD would misrepresent what customers are billed.
  -- Renamed from price_usd_cents in 016_v3_rename_price_cad.sql for the
  -- already-applied case; this column spelling is what fresh DBs get.
  price_cad_cents   integer NOT NULL DEFAULT 0,
  monthly_job_quota integer NOT NULL,
  services          text[] NOT NULL,                   -- {'youtube','spotify',...}
  export_stems      boolean NOT NULL DEFAULT false,
  export_wav24      boolean NOT NULL DEFAULT false,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
-- public catalog: anyone can read active plans
DROP POLICY IF EXISTS plans_public_read ON public.plans;
CREATE POLICY plans_public_read ON public.plans FOR SELECT TO anon, authenticated USING (active);
DROP POLICY IF EXISTS stemloops_app_all ON public.plans;
CREATE POLICY stemloops_app_all ON public.plans FOR ALL TO stemloops_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plans TO stemloops_app;

------------------------------------------------------------------------------
-- 3. customers_billing (one row per user per provider)
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customers_billing (
  user_id              uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider             text NOT NULL CHECK (provider IN ('stripe','paddle')),
  provider_customer_id text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider),
  UNIQUE (provider, provider_customer_id)
);
ALTER TABLE public.customers_billing ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customers_billing_self_read ON public.customers_billing;
CREATE POLICY customers_billing_self_read ON public.customers_billing
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS stemloops_app_all ON public.customers_billing;
CREATE POLICY stemloops_app_all ON public.customers_billing FOR ALL TO stemloops_app
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers_billing TO stemloops_app;

------------------------------------------------------------------------------
-- 4. subscriptions
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider                 text NOT NULL CHECK (provider IN ('stripe','paddle')),
  provider_subscription_id text NOT NULL,
  plan_code                text NOT NULL REFERENCES public.plans(code),
  status                   text NOT NULL
    CHECK (status IN ('trialing','active','past_due','canceled','incomplete','paused')),
  current_period_start     timestamptz NOT NULL,
  current_period_end       timestamptz NOT NULL,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id),
  CHECK (current_period_start < current_period_end)
);
CREATE INDEX IF NOT EXISTS subscriptions_user_active_idx
  ON public.subscriptions (user_id)
  WHERE status IN ('trialing','active','past_due');
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscriptions_self_read ON public.subscriptions;
CREATE POLICY subscriptions_self_read ON public.subscriptions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS stemloops_app_all ON public.subscriptions;
CREATE POLICY stemloops_app_all ON public.subscriptions FOR ALL TO stemloops_app
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscriptions TO stemloops_app;

------------------------------------------------------------------------------
-- 5. entitlements (denormalized cache rebuilt by webhook; 30s cache per §1.7)
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entitlements (
  user_id                uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  plan_code              text NOT NULL REFERENCES public.plans(code),
  period_start           timestamptz NOT NULL,
  period_end             timestamptz NOT NULL,
  jobs_used              integer NOT NULL DEFAULT 0 CHECK (jobs_used >= 0),
  computed_at            timestamptz NOT NULL DEFAULT now(),
  source_subscription_id uuid REFERENCES public.subscriptions(id),
  CHECK (period_start < period_end)
);
ALTER TABLE public.entitlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS entitlements_self_read ON public.entitlements;
CREATE POLICY entitlements_self_read ON public.entitlements
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS stemloops_app_all ON public.entitlements;
CREATE POLICY stemloops_app_all ON public.entitlements FOR ALL TO stemloops_app
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.entitlements TO stemloops_app;

------------------------------------------------------------------------------
-- 6. usage_events (append-only facts for metering + analytics, per §1.4)
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.usage_events (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  anon_ip_hash  bytea,
  kind          text NOT NULL,     -- job_created|job_completed|export_minted|play_opened|...
  job_id        uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_user_period_idx
  ON public.usage_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS usage_events_kind_idx
  ON public.usage_events (kind, created_at);
ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS usage_events_self_read ON public.usage_events;
CREATE POLICY usage_events_self_read ON public.usage_events
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
-- APPEND-ONLY per TSD §1.4: split the FOR ALL policy into SELECT + INSERT so
-- the stemloops_app role has no UPDATE/DELETE policy, and revoke the
-- corresponding grants. Belt-and-braces: a compromised worker credential
-- cannot erase metering evidence (Lens B finding #6, rolled up).
DROP POLICY IF EXISTS stemloops_app_all ON public.usage_events;
DROP POLICY IF EXISTS stemloops_app_insert ON public.usage_events;
DROP POLICY IF EXISTS stemloops_app_select ON public.usage_events;
CREATE POLICY stemloops_app_insert ON public.usage_events FOR INSERT TO stemloops_app WITH CHECK (true);
CREATE POLICY stemloops_app_select ON public.usage_events FOR SELECT TO stemloops_app USING (true);
GRANT SELECT, INSERT ON public.usage_events TO stemloops_app;
GRANT USAGE, SELECT ON SEQUENCE public.usage_events_id_seq TO stemloops_app;

------------------------------------------------------------------------------
-- 7. jobs: nullable user_id link (anonymous jobs continue to work on free tier)
--    Existing stemloops_app_all policy on public.jobs already covers writes.
------------------------------------------------------------------------------
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS jobs_user_id_idx ON public.jobs (user_id) WHERE user_id IS NOT NULL;

------------------------------------------------------------------------------
-- 8. credit_purchases (append-only ledger per §1.9; one row per Stripe/Paddle charge)
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.credit_purchases (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider           text NOT NULL CHECK (provider IN ('stripe','paddle')),
  provider_charge_id text NOT NULL,
  pack_code          text NOT NULL CHECK (pack_code IN ('credits_20','credits_60','credits_180')),
  credits_granted    integer NOT NULL CHECK (credits_granted IN (20,60,180)),
  amount_usd_cents   integer NOT NULL CHECK (amount_usd_cents >= 0),
  promo_code         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_charge_id),
  -- cross-column defense: pack_code and credits_granted must agree. A
  -- buggy webhook writing (credits_60, 20) would otherwise sail past the
  -- independent checks (Lens A finding #5).
  CHECK ((pack_code, credits_granted) IN (
    ('credits_20', 20),
    ('credits_60', 60),
    ('credits_180', 180)
  ))
);
CREATE INDEX IF NOT EXISTS credit_purchases_user_created_idx
  ON public.credit_purchases (user_id, created_at);
ALTER TABLE public.credit_purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_purchases_self_read ON public.credit_purchases;
CREATE POLICY credit_purchases_self_read ON public.credit_purchases
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
-- APPEND-ONLY per TSD §1.9: no UPDATE, no DELETE for the worker role.
-- Prevents retroactive refund-fraud shaping / purchase row erasure.
DROP POLICY IF EXISTS stemloops_app_all ON public.credit_purchases;
DROP POLICY IF EXISTS stemloops_app_insert ON public.credit_purchases;
DROP POLICY IF EXISTS stemloops_app_select ON public.credit_purchases;
CREATE POLICY stemloops_app_insert ON public.credit_purchases FOR INSERT TO stemloops_app WITH CHECK (true);
CREATE POLICY stemloops_app_select ON public.credit_purchases FOR SELECT TO stemloops_app USING (true);
GRANT SELECT, INSERT ON public.credit_purchases TO stemloops_app;

------------------------------------------------------------------------------
-- 9. credit_consumption (append-only; one row per job that charged a credit, per §1.9)
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.credit_consumption (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  job_id      uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);
CREATE INDEX IF NOT EXISTS credit_consumption_user_consumed_idx
  ON public.credit_consumption (user_id, consumed_at);
ALTER TABLE public.credit_consumption ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_consumption_self_read ON public.credit_consumption;
CREATE POLICY credit_consumption_self_read ON public.credit_consumption
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
-- APPEND-ONLY per TSD §1.9 AND §1.2a processor separation. The
-- check_credit_decrement trigger enforces input_kind='upload' on INSERT
-- (and UPDATE below, defense-in-depth). Not allowing UPDATE/DELETE closes
-- the Lens B CRITICAL bypass where a worker-role compromise could DELETE
-- consumption rows to retroactively mint free credits.
DROP POLICY IF EXISTS stemloops_app_all ON public.credit_consumption;
DROP POLICY IF EXISTS stemloops_app_insert ON public.credit_consumption;
DROP POLICY IF EXISTS stemloops_app_select ON public.credit_consumption;
CREATE POLICY stemloops_app_insert ON public.credit_consumption FOR INSERT TO stemloops_app WITH CHECK (true);
CREATE POLICY stemloops_app_select ON public.credit_consumption FOR SELECT TO stemloops_app USING (true);
GRANT SELECT, INSERT ON public.credit_consumption TO stemloops_app;

------------------------------------------------------------------------------
-- 10. check_credit_decrement trigger (processor-separation §1.2a):
--     credit_consumption may ONLY be inserted for jobs with input_kind='upload'.
--     This is the DB-level guarantee that paid tiers never touch link-ingest.
--     SECURITY DEFINER so it works even when stemloops_app inserts.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_credit_decrement()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
DECLARE
  _input_kind text;
  _job_user_id uuid;
BEGIN
  -- Pull input_kind AND user_id so we can also assert the consumption row
  -- actually belongs to the job it claims (Lens A finding #11, defense-in-depth
  -- against a worker-side wiring bug debiting the wrong account).
  SELECT input_kind, user_id INTO _input_kind, _job_user_id
    FROM public.jobs WHERE id = NEW.job_id;
  IF _input_kind IS NULL THEN
    RAISE EXCEPTION 'credit_consumption rejected: job % not found', NEW.job_id;
  END IF;
  IF _input_kind != 'upload' THEN
    RAISE EXCEPTION 'credit_consumption rejected: job % is not input_kind=upload (processor separation TSD §1.2a, is=%)',
      NEW.job_id, _input_kind;
  END IF;
  IF _job_user_id IS NOT NULL AND _job_user_id != NEW.user_id THEN
    RAISE EXCEPTION 'credit_consumption rejected: NEW.user_id % does not match jobs.user_id % (billing-account mismatch)',
      NEW.user_id, _job_user_id;
  END IF;
  RETURN NEW;
END;
$$;
-- Locks down EXECUTE: SECURITY DEFINER functions default to EXECUTE TO PUBLIC.
REVOKE EXECUTE ON FUNCTION public.check_credit_decrement() FROM PUBLIC;

DROP TRIGGER IF EXISTS credit_decrement_check ON public.credit_consumption;
-- INSERT OR UPDATE: defense-in-depth. UPDATE is also denied at the grant level,
-- but a trigger covering UPDATE means a future policy-relaxation does not
-- silently drop the processor-separation invariant (Lens B finding #2).
CREATE TRIGGER credit_decrement_check
  BEFORE INSERT OR UPDATE ON public.credit_consumption
  FOR EACH ROW EXECUTE PROCEDURE public.check_credit_decrement();

------------------------------------------------------------------------------
-- 11. v_credit_balance view (derived; never store the integer, per §1.9)
--     Exposes ONLY credits_remaining — no purchase/consumption totals leak.
--     security_invoker so RLS of underlying tables applies (self-read only).
------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_credit_balance
  WITH (security_invoker = true)
AS
  SELECT u.id AS user_id,
    -- SUM returns NULL on empty set so COALESCE stays; COUNT returns 0 so it
    -- does not (Lens A nit #14).
    COALESCE((SELECT SUM(credits_granted)::bigint FROM public.credit_purchases WHERE user_id = u.id), 0)
    - (SELECT COUNT(*) FROM public.credit_consumption WHERE user_id = u.id)
    AS credits_remaining
  FROM public.users u;
GRANT SELECT ON public.v_credit_balance TO authenticated, stemloops_app;

------------------------------------------------------------------------------
-- 12. promo_redemptions (§1.6 V3-C9 — append-only audit of coupon applications)
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.promo_redemptions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  code                        text NOT NULL,
  stripe_promotion_code_id    text,
  stripe_discount_amount_cents integer NOT NULL DEFAULT 0,
  applied_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promo_redemptions_user_idx ON public.promo_redemptions (user_id, applied_at);
ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS promo_redemptions_self_read ON public.promo_redemptions;
CREATE POLICY promo_redemptions_self_read ON public.promo_redemptions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
-- APPEND-ONLY audit per TSD §1.6 V3-C9: no UPDATE/DELETE from the worker.
-- Keeps coupon-abuse evidence immutable.
DROP POLICY IF EXISTS stemloops_app_all ON public.promo_redemptions;
DROP POLICY IF EXISTS stemloops_app_insert ON public.promo_redemptions;
DROP POLICY IF EXISTS stemloops_app_select ON public.promo_redemptions;
CREATE POLICY stemloops_app_insert ON public.promo_redemptions FOR INSERT TO stemloops_app WITH CHECK (true);
CREATE POLICY stemloops_app_select ON public.promo_redemptions FOR SELECT TO stemloops_app USING (true);
GRANT SELECT, INSERT ON public.promo_redemptions TO stemloops_app;

------------------------------------------------------------------------------
-- 13. trial_grants (§1.6 V3-C10 — 3-song free trial, no card required)
--     expires_at defaults to granted_at + 7 days so a grant row has a self-contained
--     lifetime without the worker computing it in code.
------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.trial_grants (
  user_id    uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  songs_used integer NOT NULL DEFAULT 0 CHECK (songs_used >= 0 AND songs_used <= 3),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days')
);
ALTER TABLE public.trial_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trial_grants_self_read ON public.trial_grants;
CREATE POLICY trial_grants_self_read ON public.trial_grants
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS stemloops_app_all ON public.trial_grants;
CREATE POLICY stemloops_app_all ON public.trial_grants FOR ALL TO stemloops_app
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trial_grants TO stemloops_app;

------------------------------------------------------------------------------
-- 14. Minimal 'free' plan row (self-contained, pre-trigger):
--     Fixes the Lens A finding #4 sequencing hazard — the handle_new_user
--     trigger inserts an entitlements row with plan_code='free', which FKs
--     into plans(code). If this migration is applied without 014 yet, every
--     signup would FK-fail. Self-seed a minimal 'free' row here; 014 then
--     UPSERTs the full catalog. Nothing depends on 014's richer values for
--     a signup to succeed.
------------------------------------------------------------------------------
INSERT INTO public.plans
  (code, display_name, price_cad_cents, monthly_job_quota, services, export_stems, export_wav24, active)
VALUES
  ('free', 'Free', 0, 90, ARRAY['youtube','spotify','soundcloud']::text[], false, false, true)
ON CONFLICT (code) DO NOTHING;

------------------------------------------------------------------------------
-- 15. Supabase auth.users → public.users trigger (V3-U4 per TSD §2.4)
--     Seeds public.users AND a 'free' entitlement row on sign-up.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
BEGIN
  -- Supabase auth.users.email is nullable (phone-auth, OAuth providers that
  -- omit email). public.users.email is NOT NULL (TSD §2.3 line 352). A raw
  -- VALUES (NEW.email) would then abort the whole signup transaction (Lens A
  -- finding #3 + Lens B finding #4). Fall back to a derived placeholder so
  -- the row seeds successfully; the API layer can later reconcile a real
  -- email through the Supabase email-add flow if the provider returns one.
  INSERT INTO public.users (id, email)
    VALUES (NEW.id, COALESCE(NEW.email, NEW.id::text || '@noemail.local'))
    ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.entitlements (user_id, plan_code, period_start, period_end)
    VALUES (NEW.id, 'free', date_trunc('month', now()),
            date_trunc('month', now()) + interval '1 month')
    ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

------------------------------------------------------------------------------
-- 16. subscriptions.updated_at auto-update (Lens A finding #8)
--     Any UPDATE on subscriptions bumps updated_at to now(). Downstream
--     freshness checks (webhook replay dedupe) depend on this being live.
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_subscription_updated_at()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS subscriptions_touch_updated_at ON public.subscriptions;
CREATE TRIGGER subscriptions_touch_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE PROCEDURE public.touch_subscription_updated_at();

------------------------------------------------------------------------------
-- A3. cowork_ro read policy applied to every NEW public table in this migration
--     (no-op on CI / fresh DBs where cowork_ro doesn't exist).
------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cowork_ro') THEN
    FOREACH t IN ARRAY ARRAY[
      'users','plans','customers_billing','subscriptions','entitlements',
      'usage_events','credit_purchases','credit_consumption',
      'promo_redemptions','trial_grants'
    ] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname='public' AND tablename=t AND policyname='cowork_ro_read'
      ) THEN
        EXECUTE format('CREATE POLICY cowork_ro_read ON public.%I FOR SELECT TO cowork_ro USING (true)', t);
      END IF;
    END LOOP;
    -- grant SELECT on the new view too (view RLS inherits via security_invoker)
    GRANT SELECT ON public.v_credit_balance TO cowork_ro;
  END IF;
END $$;
