-- 022_v3_credit_balance_clamp.sql — clamp v_credit_balance at zero (review M6).
--
-- Without a floor, a consumption row back-filled before its purchase (or any
-- adjustment flow that subtracts incorrectly) makes the view return a negative
-- balance and the UI shows "-1 credits". Wrap the expression in GREATEST(0, ...).
--
-- Same definition as migration 013 §11 (purchases minus consumption) plus the
-- clamp. security_invoker = true is preserved so RLS on the underlying tables
-- still applies (self-read only). The credit_adjustments term is NOT added here.
--
-- Idempotent: CREATE OR REPLACE VIEW (same column name/type: bigint).
-- Append-only per §11 Merge Safety Rule (b). Dashboard paste required.

CREATE OR REPLACE VIEW public.v_credit_balance
  WITH (security_invoker = true)
AS
  SELECT u.id AS user_id,
    GREATEST(
      0::bigint,
      COALESCE((SELECT SUM(credits_granted)::bigint FROM public.credit_purchases WHERE user_id = u.id), 0)
      - (SELECT COUNT(*) FROM public.credit_consumption WHERE user_id = u.id)
    ) AS credits_remaining
  FROM public.users u;
GRANT SELECT ON public.v_credit_balance TO authenticated, stemloops_app;
