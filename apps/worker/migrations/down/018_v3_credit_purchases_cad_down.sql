-- 018_v3_credit_purchases_cad_down.sql — reverse the CAD rename on
-- credit_purchases. Idempotent: only renames back when the CAD-named column
-- is present.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'credit_purchases'
      AND column_name  = 'amount_cad_cents'
  ) THEN
    ALTER TABLE public.credit_purchases RENAME COLUMN amount_cad_cents TO amount_usd_cents;
  END IF;
END $$;
