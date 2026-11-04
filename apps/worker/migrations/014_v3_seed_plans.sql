-- 014_v3_seed_plans.sql — seed the locked plan catalog per Jon 2026-11-02T22:45.
--
-- Pricing table (TSD-V3-DELTA.md §1.2 + §1.2a + §1.3; Lens C findings C-01/C-02):
--   free    — 3 songs/day, no account       — $0           — youtube/spotify/soundcloud link-ingest
--   pro     — $4.99/mo — UNLIMITED own-file — stems export — NO link-ingest (§1.2a)
--   studio  — $12/mo   — UNLIMITED own-file — wav24 export — NO link-ingest (§1.2a)
--
-- §1.2a is the structural separation: paid tiers (Credits/Pro/Studio) NEVER
-- touch the link-ingest path. Link ingest lives in the free tier forever. So
-- `services = []` on paid tiers is not "features missing", it is a
-- processor-separation guarantee. Apple/Tidal remain Phase 4 trigger-based.
--
-- Credits 20/60/180 are one-time SKUs not modeled here (ledger in credit_purchases).
--
-- Idempotent on PRIMARY KEY (code): restores canonical plan values. An admin
-- who edits a plan price in prod will see it overwritten on the next run —
-- that is intentional (the migration is the source of truth for pricing).

INSERT INTO public.plans
  (code, display_name, price_usd_cents, monthly_job_quota, services, export_stems, export_wav24, active)
VALUES
  ('free',   'Free',     0,  90,      ARRAY['youtube','spotify','soundcloud']::text[], false, false, true),
  -- Pro/Studio "unlimited" is modeled as a practical sentinel (100000). The
  -- entitlement check-side treats >=1e5 as unlimited; swapping to a NULL-
  -- means-unlimited convention is a Phase 1b consideration (DDL change).
  ('pro',    'Pro',    499,  100000,  ARRAY[]::text[],                                 true,  false, true),
  ('studio', 'Studio', 1200, 100000,  ARRAY[]::text[],                                 true,  true,  true)
ON CONFLICT (code) DO UPDATE SET
  display_name      = EXCLUDED.display_name,
  price_usd_cents   = EXCLUDED.price_usd_cents,
  monthly_job_quota = EXCLUDED.monthly_job_quota,
  services          = EXCLUDED.services,
  export_stems      = EXCLUDED.export_stems,
  export_wav24      = EXCLUDED.export_wav24,
  active            = EXCLUDED.active;
