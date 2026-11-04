-- 022_v3_credit_balance_clamp_down.sql — restore the unclamped 013 definition.
-- Idempotent: CREATE OR REPLACE VIEW.

CREATE OR REPLACE VIEW public.v_credit_balance
  WITH (security_invoker = true)
AS
  SELECT u.id AS user_id,
    COALESCE((SELECT SUM(credits_granted)::bigint FROM public.credit_purchases WHERE user_id = u.id), 0)
    - (SELECT COUNT(*) FROM public.credit_consumption WHERE user_id = u.id)
    AS credits_remaining
  FROM public.users u;
GRANT SELECT ON public.v_credit_balance TO authenticated, stemloops_app;
