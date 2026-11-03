-- 014_v3_seed_plans.sql — seed the locked plan catalog per Jon 2026-11-02T22:45.
--
-- Pricing table (TSD-V3-DELTA.md §1.3):
--   free    — 3 songs/day, no account                 — $0        — youtube only
--   pro     — $4.99/mo — 100 songs/mo + stems export  — all services
--   studio  — $12/mo   — unlimited + wav24 export     — all services
--
-- Credits 20/60/180 are one-time SKUs not modeled here (ledger in credit_purchases).
-- Idempotent on PRIMARY KEY (code); re-running the migration is a no-op.
--
-- Rate rationale: monthly_job_quota is a MONTHLY cap. The 'free' row's
-- "3 songs/day" is enforced in the API layer against usage_events, not here
-- (we store 90 = 3/day * 30d as a defensible upper bound for a full month).

INSERT INTO public.plans
  (code, display_name, price_usd_cents, monthly_job_quota, services, export_stems, export_wav24, active)
VALUES
  ('free',   'Free',   0,    90,  ARRAY['youtube'],                             false, false, true),
  ('pro',    'Pro',    499,  100, ARRAY['youtube','spotify','apple','soundcloud'], true,  false, true),
  ('studio', 'Studio', 1200, 100000, ARRAY['youtube','spotify','apple','soundcloud'], true,  true,  true)
ON CONFLICT (code) DO UPDATE SET
  display_name      = EXCLUDED.display_name,
  price_usd_cents   = EXCLUDED.price_usd_cents,
  monthly_job_quota = EXCLUDED.monthly_job_quota,
  services          = EXCLUDED.services,
  export_stems      = EXCLUDED.export_stems,
  export_wav24      = EXCLUDED.export_wav24,
  active            = EXCLUDED.active;
