-- 034_v3_pricing_model_truth_down.sql — restore the plan values 014 seeded.
--
-- 034 is pure DML on three existing rows, so the reverse is the same UPSERT
-- carrying 014's values: free 90/month with all three link services, pro and
-- studio on the 100000 "unlimited" sentinel with export_stems true and
-- studio's export_wav24 true.
--
-- Deliberately an UPSERT, not a DELETE: 014's down file deletes the rows,
-- which is correct for un-seeding the catalog, but 034 only CHANGED values.
-- Reversing a value change by deleting the row would take entitlements and
-- subscriptions' FKs on plans(code) with it and leave signup FK-failing.
--
-- Also restores the three column COMMENTs to what they were before 034:
-- monthly_job_quota and export_stems had NO comment (013 documented them with
-- inline SQL comments only, which are not stored), and export_wav24 likewise.
-- COMMENT ... IS NULL removes a comment, which is the true inverse.
--
-- Not applied by the runner — `make migrate` globs only migrations/*.sql.
-- Run by hand against a throwaway DB.

INSERT INTO public.plans
  (code, display_name, price_cad_cents, monthly_job_quota, services, export_stems, export_wav24, active)
VALUES
  ('free',   'Free',      0,     90, ARRAY['youtube','spotify','soundcloud']::text[], false, false, true),
  ('pro',    'Pro',     499, 100000, ARRAY[]::text[],                                 true,  false, true),
  ('studio', 'Studio', 1200, 100000, ARRAY[]::text[],                                 true,  true,  true)
ON CONFLICT (code) DO UPDATE SET
  display_name      = EXCLUDED.display_name,
  price_cad_cents   = EXCLUDED.price_cad_cents,
  monthly_job_quota = EXCLUDED.monthly_job_quota,
  services          = EXCLUDED.services,
  export_stems      = EXCLUDED.export_stems,
  export_wav24      = EXCLUDED.export_wav24,
  active            = EXCLUDED.active;

COMMENT ON COLUMN public.plans.monthly_job_quota IS NULL;
COMMENT ON COLUMN public.plans.export_stems      IS NULL;
COMMENT ON COLUMN public.plans.export_wav24      IS NULL;
