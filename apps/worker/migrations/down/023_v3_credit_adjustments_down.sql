-- 023_v3_credit_adjustments_down.sql — restore the 013 v_credit_balance
-- definition, then drop the adjustments ledger. Run by hand only.
-- WARNING: dropping the table discards recorded clawbacks.

CREATE OR REPLACE VIEW public.v_credit_balance
  WITH (security_invoker = true)
AS
  SELECT u.id AS user_id,
    COALESCE((SELECT SUM(credits_granted)::bigint FROM public.credit_purchases WHERE user_id = u.id), 0)
    - (SELECT COUNT(*) FROM public.credit_consumption WHERE user_id = u.id)
    AS credits_remaining
  FROM public.users u;
GRANT SELECT ON public.v_credit_balance TO authenticated, stemloops_app;

DROP TABLE IF EXISTS public.credit_adjustments;
