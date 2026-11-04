-- 024_v3_credit_adjustments_partial_refund_index.sql — M4 follow-up: pro-rata
-- partial-refund clawback. A charge can now have SEVERAL refund adjustment
-- rows (one per partial-refund event), so the one-refund-per-charge UNIQUE
-- index from 023 must go. Per-event idempotency is still enforced by
-- UNIQUE (provider, provider_event_id); the webhook bounds the per-charge total
-- by SUM(-credits_delta) <= credits_granted.
--
-- Replaced by a NON-unique partial index that also serves the webhook's
-- "sum of previous clawbacks" lookup. 023's other index (user_id, created_at)
-- does not cover that query.
--
-- Down: migrations/down/024_v3_credit_adjustments_partial_refund_index_down.sql.

DROP INDEX IF EXISTS public.credit_adjustments_one_refund_per_charge_idx;
CREATE INDEX IF NOT EXISTS credit_adjustments_refund_charge_idx
  ON public.credit_adjustments (provider, provider_charge_id)
  WHERE reason = 'refund';
