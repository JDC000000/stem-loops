-- 016_v3_rename_price_cad.sql — fix CAD/USD currency inconsistency on plans.
--
-- Audit MAJOR finding: `public.plans.price_usd_cents` was named USD but held
-- CAD values (499 = $4.99 CAD, 1200 = $12 CAD per TSD-V3-DELTA.md §1.2) because
-- the Stripe sandbox is a BC CAD catalog. The column name misled readers of
-- the schema and showed through to the UI (pricing page rendered values with
-- an implied USD look).
--
-- This migration renames `price_usd_cents` → `price_cad_cents` on an
-- already-applied DB. Migrations 013 (CREATE TABLE) and 014 (seed) in this
-- PR use the new name directly, so a fresh DB skips the rename naturally
-- (the IF-check below finds the column already correctly named).
--
-- Idempotent: wrapped in a DO block that inspects information_schema.columns
-- so a re-run or a fresh-DB application is a no-op. Append-only per §11
-- Merge Safety Rule (b).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'plans'
      AND column_name  = 'price_usd_cents'
  ) THEN
    ALTER TABLE public.plans RENAME COLUMN price_usd_cents TO price_cad_cents;
  END IF;
END $$;

COMMENT ON COLUMN public.plans.price_cad_cents IS
  'Price in CAD cents. Sandbox is BC CAD catalog per TSD §1.2.';
