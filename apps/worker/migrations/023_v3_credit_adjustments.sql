-- 023_v3_credit_adjustments.sql — append-only ledger for credit clawbacks
-- (Stripe refunds) and manual support grants. Fixes credit-ledger review
-- 2026-11-03 finding M4: charge.refunded was parsed but dropped, so a refunded
-- credit purchase kept its credits forever.
--
-- Shape mirrors credit_purchases / credit_consumption (013):
--   * RLS on; authenticated self-read; stemloops_app INSERT + SELECT only
--   * UPDATE/DELETE explicitly REVOKEd (default privileges from 011 would
--     otherwise re-grant them — see 017 for the same trap)
--   * UNIQUE (provider, provider_event_id): Stripe retries of the same event
--     collapse to one row. NULLs are distinct, so manual rows (no provider)
--     are unaffected.
--   * Partial UNIQUE (provider, provider_charge_id) WHERE reason = 'refund':
--     a charge can only be clawed back once, even across distinct events.
--
-- v_credit_balance is extended with + SUM(credits_delta). NOTE: the
-- GREATEST(0, ...) clamp is intentionally NOT added here (tracked separately
-- as M6). Until M6 lands, a user who spent credits and is then refunded can
-- show a negative balance.
--
-- Down: migrations/down/023_v3_credit_adjustments_down.sql.

-- rls-backend-only: none (self-read policy below)
CREATE TABLE IF NOT EXISTS public.credit_adjustments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Negative = clawback (refund), positive = manual grant (support).
  credits_delta      integer NOT NULL CHECK (credits_delta <> 0),
  reason             text NOT NULL CHECK (reason IN ('refund','manual_grant','adjustment')),
  provider           text,
  provider_event_id  text,   -- idempotency: Stripe event id
  provider_charge_id text,   -- which charge this reversed
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX IF NOT EXISTS credit_adjustments_user_idx
  ON public.credit_adjustments (user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS credit_adjustments_one_refund_per_charge_idx
  ON public.credit_adjustments (provider, provider_charge_id)
  WHERE reason = 'refund';

ALTER TABLE public.credit_adjustments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS credit_adjustments_self_read ON public.credit_adjustments;
CREATE POLICY credit_adjustments_self_read ON public.credit_adjustments
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS stemloops_app_all ON public.credit_adjustments;
DROP POLICY IF EXISTS stemloops_app_insert ON public.credit_adjustments;
DROP POLICY IF EXISTS stemloops_app_select ON public.credit_adjustments;
CREATE POLICY stemloops_app_insert ON public.credit_adjustments FOR INSERT TO stemloops_app WITH CHECK (true);
CREATE POLICY stemloops_app_select ON public.credit_adjustments FOR SELECT TO stemloops_app USING (true);
GRANT SELECT, INSERT ON public.credit_adjustments TO stemloops_app;
REVOKE UPDATE, DELETE ON public.credit_adjustments FROM stemloops_app;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cowork_ro') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname='public' AND tablename='credit_adjustments' AND policyname='cowork_ro_read'
    ) THEN
      CREATE POLICY cowork_ro_read ON public.credit_adjustments FOR SELECT TO cowork_ro USING (true);
    END IF;
  END IF;
END $$;

-- Balance = purchases + adjustments - consumption. Same column list as 013
-- (credits_remaining only) so CREATE OR REPLACE is legal.
CREATE OR REPLACE VIEW public.v_credit_balance
  WITH (security_invoker = true)
AS
  SELECT u.id AS user_id,
    COALESCE((SELECT SUM(credits_granted)::bigint FROM public.credit_purchases WHERE user_id = u.id), 0)
    + COALESCE((SELECT SUM(credits_delta)::bigint FROM public.credit_adjustments WHERE user_id = u.id), 0)
    - (SELECT COUNT(*) FROM public.credit_consumption WHERE user_id = u.id)
    AS credits_remaining
  FROM public.users u;
GRANT SELECT ON public.v_credit_balance TO authenticated, stemloops_app;
