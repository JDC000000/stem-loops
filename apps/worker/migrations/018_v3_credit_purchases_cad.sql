-- 018_v3_credit_purchases_cad.sql — fix CAD/USD currency inconsistency on
-- credit_purchases.
--
-- PR #34 renamed `plans.price_usd_cents` → `price_cad_cents` after the audit
-- flagged that the Stripe sandbox is a BC CAD catalog and USD-named columns
-- misrepresent what customers are billed. The reviewer on #34 flagged
-- `credit_purchases.amount_usd_cents` as the sibling column with the same
-- defect — it stores `session.amount_total` from the same CAD Stripe
-- catalog. This migration renames it to match.
--
-- Rename `amount_usd_cents` → `amount_cad_cents` on an already-applied DB.
-- Migration 013 (CREATE TABLE) in this PR uses the new name directly, so a
-- fresh DB skips the rename naturally (the IF-check below finds the column
-- already correctly named).
--
-- Idempotent: wrapped in a DO block that inspects information_schema.columns
-- so a re-run or a fresh-DB application is a no-op. Append-only per §11
-- Merge Safety Rule (b).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'credit_purchases'
      AND column_name  = 'amount_usd_cents'
  ) THEN
    ALTER TABLE public.credit_purchases RENAME COLUMN amount_usd_cents TO amount_cad_cents;
  END IF;
END $$;

COMMENT ON COLUMN public.credit_purchases.amount_cad_cents IS
  'Price in CAD cents from Stripe session.amount_total.';
