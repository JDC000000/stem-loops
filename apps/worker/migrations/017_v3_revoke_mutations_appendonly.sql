-- Migration 017 (PR #33 review fix): revoke UPDATE/DELETE on append-only tables.
--
-- Context: 011_role_catchup.sql ran
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stemloops_app
-- which attached CRUD-for-stemloops_app to every table created afterwards.
-- 013_v3_commercial.sql later declared four tables append-only — usage_events,
-- credit_purchases, credit_consumption, promo_redemptions — by giving
-- stemloops_app only INSERT/SELECT policies and only INSERT/SELECT grants.
-- But a `GRANT SELECT, INSERT ... TO stemloops_app` is additive: it does not
-- REVOKE the UPDATE/DELETE that default privileges already attached at CREATE
-- TABLE time. Result: the append-only invariant that
-- apps/web/src/lib/billing/rate-limit.ts and the Round-2 adversarial review
-- test (apps/worker/tests/test_rate_limits.py::test_job_start_attempt_is_
-- append_only) depend on was silently violated — the app role could DELETE or
-- UPDATE usage_events and erase burst-limit evidence. This migration closes
-- that: a plain REVOKE UPDATE, DELETE that runs AFTER 013 created the tables.
--
-- Idempotent: REVOKE on a privilege that's already absent is a no-op.
-- Down: migrations/down/017_v3_revoke_mutations_appendonly_down.sql.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'usage_events',
    'credit_purchases',
    'credit_consumption',
    'promo_redemptions'
  ] LOOP
    EXECUTE format(
      'REVOKE UPDATE, DELETE ON public.%I FROM stemloops_app',
      t);
  END LOOP;
END $$;
