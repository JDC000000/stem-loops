-- Migration 010 (Phase 1a): billing + accounts.
--
-- Introduces the four user-data tables V3 needs to hold money + subscriptions,
-- a derived credit-balance view, and RLS so a signed-in user sees ONLY their
-- own rows. The worker/backend (service_role) bypasses RLS and writes rows
-- in response to Stripe webhooks.
--
-- Design notes
-- ------------
-- * users is a public-schema profile table, 1:1 with auth.users. The FK uses
--   ON DELETE CASCADE so a Supabase auth deletion sweeps the profile with it.
-- * credit_consumption.job_id has NO foreign key (same pattern as
--   fetch_attempts in 008): jobs rows are swept at 24 h and we keep
--   consumption records for billing audit, so the id is kept as a reference
--   only. If the job is reaped, the consumption row survives.
-- * stripe_payment_intent_id and stripe_subscription_id are UNIQUE so webhook
--   replays (and Stripe's at-least-once delivery) are naturally idempotent
--   via INSERT ... ON CONFLICT DO NOTHING in the webhook handler.
-- * The v_credit_balance view uses `security_invoker = true` (PG 15+ /
--   Supabase PG 16) so the invoking user's RLS applies to the underlying
--   tables, not the view owner's.
-- * RLS policies reference `(SELECT auth.uid())` not `auth.uid()` — the
--   SELECT wrapper lets PG cache the result once per query, which measurably
--   speeds up policy evaluation on large result sets (Supabase perf guidance).
-- * No `-- rls-backend-only:` marker — every table here is user-owned and
--   carries an auth.uid()-referencing policy. The CI gate (scripts/check_rls.py
--   rule 3) will verify this.
-- * Idempotent per the migrations/README convention. Down migration:
--   migrations/down/010_billing_down.sql.

-- 0. CI compatibility: provide a stub auth schema + users table when running
--    against vanilla Postgres (local dev + CI). In Supabase both already exist
--    and this is a no-op; without the stub, every FK to auth.users below
--    would fail the migration against CI's postgres:16-alpine service.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (
      id    uuid PRIMARY KEY,
      email text
    );
  END IF;
END$$;

-- 1. users (public profile; 1:1 with auth.users).
CREATE TABLE IF NOT EXISTS users (
  id                     uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                  text        NOT NULL,
  stripe_customer_id     text        UNIQUE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- 2. credit_purchases: one row per Stripe payment intent that granted credits.
CREATE TABLE IF NOT EXISTS credit_purchases (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_payment_intent_id  text        NOT NULL UNIQUE,
  stripe_price_id           text        NOT NULL,
  sku                       text        NOT NULL
                            CHECK (sku IN ('credits_20','credits_60','credits_180')),
  credits_granted           integer     NOT NULL CHECK (credits_granted > 0),
  amount_cents              integer     NOT NULL CHECK (amount_cents >= 0),
  currency                  text        NOT NULL DEFAULT 'cad',
  created_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_purchases_user_time_idx
  ON credit_purchases (user_id, created_at DESC);

-- 3. credit_consumption: one row per credit-spending event (usually one job).
--    No FK to jobs on purpose (jobs rows are swept at 24 h, these are kept).
CREATE TABLE IF NOT EXISTS credit_consumption (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id            uuid,
  credits_consumed  integer     NOT NULL CHECK (credits_consumed > 0),
  consumed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_consumption_user_time_idx
  ON credit_consumption (user_id, consumed_at DESC);
CREATE INDEX IF NOT EXISTS credit_consumption_job_idx
  ON credit_consumption (job_id);

-- 4. subscriptions: one row per Stripe subscription, synced from webhooks.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id    text        NOT NULL UNIQUE,
  stripe_customer_id        text        NOT NULL,
  stripe_price_id           text        NOT NULL,
  sku                       text        NOT NULL
                            CHECK (sku IN ('pro_monthly','studio_monthly')),
  status                    text        NOT NULL
                            CHECK (status IN ('trialing','active','past_due','canceled','incomplete','incomplete_expired','unpaid','paused')),
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  cancel_at_period_end      boolean     NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions (status);

-- 5. entitlements: capability grants (derived cache, written by webhook/sync).
--    Separate from subscriptions so a credit-only user can still have a
--    capability (e.g. 'separate'); subscription changes trigger a rewrite.
CREATE TABLE IF NOT EXISTS entitlements (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability  text        NOT NULL,
  granted_via text        NOT NULL
              CHECK (granted_via IN ('subscription','credit_purchase','trial','admin')),
  source_id   uuid,         -- subscription.id or credit_purchases.id, nullable
  expires_at  timestamptz,  -- null = indefinite (e.g. subscription active)
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, capability, granted_via)
);
CREATE INDEX IF NOT EXISTS entitlements_user_idx ON entitlements (user_id);

-- 6. v_credit_balance view: per-user available credits.
--    Each sub-select is grouped separately BEFORE the JOIN so credit_purchases
--    and credit_consumption rows don't multiply via cartesian product.
--    security_invoker=true: RLS on underlying tables applies to the caller,
--    not the view owner, so a user querying this view sees only their row.
CREATE OR REPLACE VIEW v_credit_balance
  WITH (security_invoker = true) AS
SELECT
  u.id AS user_id,
  COALESCE(p.granted,  0) AS credits_granted,
  COALESCE(c.consumed, 0) AS credits_consumed,
  COALESCE(p.granted,  0) - COALESCE(c.consumed, 0) AS balance
FROM users u
LEFT JOIN (
  SELECT user_id, SUM(credits_granted)::bigint AS granted
  FROM credit_purchases
  GROUP BY user_id
) p ON p.user_id = u.id
LEFT JOIN (
  SELECT user_id, SUM(credits_consumed)::bigint AS consumed
  FROM credit_consumption
  GROUP BY user_id
) c ON c.user_id = u.id;

-- 7. Role grants (noop in Supabase; declarative in vanilla PG).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END$$;

GRANT ALL ON users, credit_purchases, credit_consumption, subscriptions, entitlements TO service_role;
GRANT SELECT, UPDATE ON users TO authenticated;
GRANT SELECT ON credit_purchases, credit_consumption, subscriptions, entitlements TO authenticated;
GRANT SELECT ON v_credit_balance TO authenticated, service_role;

-- 8. Enable RLS on every table (default-deny posture).
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_purchases   ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_consumption ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlements       ENABLE ROW LEVEL SECURITY;

-- 9. Per-user RLS policies (use (SELECT auth.uid()) for init-plan caching).
--    Drop-then-create for idempotency.

-- users: read + update own profile only. Insert/delete via service_role.
DROP POLICY IF EXISTS users_select_own ON users;
CREATE POLICY users_select_own ON users
  FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));
DROP POLICY IF EXISTS users_update_own ON users;
CREATE POLICY users_update_own ON users
  FOR UPDATE TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));
DROP POLICY IF EXISTS users_service_role_all ON users;
CREATE POLICY users_service_role_all ON users
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- credit_purchases: user sees own; only service_role inserts (webhook).
DROP POLICY IF EXISTS credit_purchases_select_own ON credit_purchases;
CREATE POLICY credit_purchases_select_own ON credit_purchases
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS credit_purchases_service_role_all ON credit_purchases;
CREATE POLICY credit_purchases_service_role_all ON credit_purchases
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- credit_consumption: user sees own; only service_role inserts (API).
DROP POLICY IF EXISTS credit_consumption_select_own ON credit_consumption;
CREATE POLICY credit_consumption_select_own ON credit_consumption
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS credit_consumption_service_role_all ON credit_consumption;
CREATE POLICY credit_consumption_service_role_all ON credit_consumption
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- subscriptions: user sees own; webhook writes via service_role.
DROP POLICY IF EXISTS subscriptions_select_own ON subscriptions;
CREATE POLICY subscriptions_select_own ON subscriptions
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS subscriptions_service_role_all ON subscriptions;
CREATE POLICY subscriptions_service_role_all ON subscriptions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- entitlements: user sees own; webhook/sync writes via service_role.
DROP POLICY IF EXISTS entitlements_select_own ON entitlements;
CREATE POLICY entitlements_select_own ON entitlements
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS entitlements_service_role_all ON entitlements;
CREATE POLICY entitlements_service_role_all ON entitlements
  FOR ALL TO service_role USING (true) WITH CHECK (true);
