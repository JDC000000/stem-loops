-- 024 down — restore the 023 one-refund-per-charge UNIQUE index. Run by hand only.
-- WARNING: fails if any charge already has >1 refund row (pro-rata partials);
-- consolidate or remove those rows first.
DROP INDEX IF EXISTS public.credit_adjustments_refund_charge_idx;
CREATE UNIQUE INDEX IF NOT EXISTS credit_adjustments_one_refund_per_charge_idx
  ON public.credit_adjustments (provider, provider_charge_id)
  WHERE reason = 'refund';
