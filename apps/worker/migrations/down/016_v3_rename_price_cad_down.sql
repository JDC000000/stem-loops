-- 016_v3_rename_price_cad_down.sql — reverse the CAD rename.
-- Idempotent: only renames back when the CAD-named column is present.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'plans'
      AND column_name  = 'price_cad_cents'
  ) THEN
    ALTER TABLE public.plans RENAME COLUMN price_cad_cents TO price_usd_cents;
  END IF;
END $$;
