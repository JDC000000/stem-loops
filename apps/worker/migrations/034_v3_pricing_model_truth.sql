-- 034_v3_pricing_model_truth.sql — re-price the plan catalog on the metered unit
-- that actually exists, and clear every plan flag that advertised a capability
-- the app cannot deliver.
--
-- Supersedes the pricing values seeded by 014_v3_seed_plans.sql. 014 is NOT
-- edited (append-only, per §11 Merge Safety Rule (b)); it stays in the chain as
-- the historical record and this migration, applying after it, is the new
-- source of truth for plan values.
--
-- ---------------------------------------------------------------------------
-- Jon's approved model (2026-11-11). The metered unit is "a track converted to
-- play-along", which is what plans.monthly_job_quota already counts and what
-- checkMonthlyQuota() enforces, rolled to the calendar month.
--
--   code    | tracks/month | price        | link import
--   --------+--------------+--------------+--------------------------------
--   free    |      5       | $0           | YouTube   (see NOTE below)
--   pro     |     50       | $4.99 CAD    | none      (see NOTE below)
--   studio  |    150       | $12 CAD      | none      (see NOTE below)
--
-- Credits (20 for $5) are one-time SKUs in public.credit_packs (migration 020)
-- and are not re-priced here.
--
-- ---------------------------------------------------------------------------
-- What changed from 014, and why each change is a statement of fact rather
-- than a product decision:
--
--  1. monthly_job_quota: free 90 -> 5, pro 100000 -> 50, studio 100000 -> 150.
--
--     The 100000 values were a sentinel meaning "unlimited"
--     (rate-limit.ts UNLIMITED_QUOTA_SENTINEL short-circuits at >= 100000).
--     An unmetered paid tier is an open-ended cost liability against a
--     measured Replicate spend of ~$0.029 USD per job, so the sentinel is
--     retired by giving every plan a real number. No plan is unlimited now,
--     and because 50 and 150 are both below the sentinel, checkMonthlyQuota()
--     begins gating Pro and Studio with no code change.
--
--     free was 90/month while every surface said "3 songs per day". 5/month is
--     the approved figure and the copy is now derived from this column.
--
--  2. services: free {youtube,spotify,soundcloud} -> {youtube}.
--
--     Spotify and SoundCloud have ZERO implementation anywhere in the repo —
--     no downloader, no route, no error code. They were advertised on the
--     pricing page purely because this column listed them. Removing them from
--     the data is the fix: a service that cannot run cannot be listed.
--     YouTube stays because YouTube link ingest is real and shipping.
--
--  3. export_stems: pro true -> false, studio true -> false.
--
--     There is no stem-export route. /api/jobs/[id]/stems serves Opus
--     PLAYBACK urls for the mixer and says so in its own header comment;
--     mintStemDownloadUrl() in src/lib/stem-urls.ts has no production caller
--     at all. Both paid tiers were selling a .zip that nothing can produce.
--
--  4. export_wav24: studio true -> false.
--
--     Loops ARE 24-bit WAV (worker/encoder/wav_encoder.py writes PCM_24) and
--     they are downloadable — but by everyone, on the free tier, with no
--     account. The landing page has advertised exactly that for months
--     ("Free, 24-bit WAV, no account"). So 24-bit WAV is a real feature and a
--     false DIFFERENTIATOR: flagging it studio-only would gate something the
--     free tier already gets. The pricing copy now names 24-bit WAV loop
--     download on all three tiers, which is what actually happens.
--
-- ---------------------------------------------------------------------------
-- NOTE — the `services` column on pro/studio is left EMPTY, which does NOT
-- match the "link import: YouTube" column of the approved table above. This is
-- deliberate and is the one item in this change that needs Jon's decision
-- rather than a migration.
--
-- `services` does not gate link ingest on its own. enforceEntitlement() in
-- src/lib/billing/entitlements.ts refuses link ingest for pro/studio by
-- PLAN CODE, before it ever reads `services`:
--
--     if (snap.plan_code === 'pro' || snap.plan_code === 'studio') {
--       throw new EntitlementError('PAID_LINK_INGEST_DISALLOWED');
--     }
--
-- That is the §1.2a "processor separation" guarantee — paid tiers never touch
-- the link-ingest path — documented in 014's header and in TSD-V3-DELTA §1.2a,
-- and guarded by two dedicated test files. Writing ARRAY['youtube'] here would
-- therefore NOT enable the feature; it would only make the pricing page
-- advertise an import that the API answers with a 400. Enabling it for real
-- means reversing a documented processor/licensing posture, which is a product
-- and legal decision, not a data fix. Left as-is, and raised in the PR.
--
-- ---------------------------------------------------------------------------
-- Conventions:
--   Idempotent — a pure UPSERT keyed on the primary key (code). Re-running
--   restores the same three rows, so the CI "Migrations" job's second pass is
--   a no-op. As in 014, an admin who hand-edits a plan price in prod will see
--   it overwritten on the next run; the migration chain is the source of truth.
--
--   Inserts as well as updates, so a FRESH database that somehow reached this
--   point without 014 still lands all three rows (ON CONFLICT DO UPDATE).
--
--   No RLS or GRANT statements. 013 created public.plans, enabled RLS and
--   installed both policies (plans_public_read for anon/authenticated on
--   active rows; stemloops_app_all FOR ALL), and 017's append-only REVOKE list
--   does not include plans. This migration adds no object, so per 017/032 there
--   is no new privilege surface to grant or revoke — stating that explicitly so
--   a reader does not have to re-derive it.
--
--   Runs as the migration role (NOSUPERUSER, database owner, BYPASSRLS) that
--   the CI "Migrations on a Supabase-like Postgres" job pins, so the RLS on
--   public.plans does not obstruct this DML.
--
-- Down: migrations/down/034_v3_pricing_model_truth_down.sql restores 014's
-- exact values.

INSERT INTO public.plans
  (code, display_name, price_cad_cents, monthly_job_quota, services, export_stems, export_wav24, active)
VALUES
  ('free',   'Free',      0,   5,  ARRAY['youtube']::text[], false, false, true),
  ('pro',    'Pro',     499,  50,  ARRAY[]::text[],          false, false, true),
  ('studio', 'Studio', 1200, 150,  ARRAY[]::text[],          false, false, true)
ON CONFLICT (code) DO UPDATE SET
  display_name      = EXCLUDED.display_name,
  price_cad_cents   = EXCLUDED.price_cad_cents,
  monthly_job_quota = EXCLUDED.monthly_job_quota,
  services          = EXCLUDED.services,
  export_stems      = EXCLUDED.export_stems,
  export_wav24      = EXCLUDED.export_wav24,
  active            = EXCLUDED.active;

COMMENT ON COLUMN public.plans.monthly_job_quota IS
  'Tracks converted to play-along, per calendar month. Enforced by '
  'checkMonthlyQuota() against entitlements.jobs_used. Set by migration 034; '
  'no plan is unlimited.';

COMMENT ON COLUMN public.plans.export_stems IS
  'Entitles a full-stems export. FALSE on every plan as of migration 034: no '
  'stem-export route exists (the /stems route serves Opus playback only).';

COMMENT ON COLUMN public.plans.export_wav24 IS
  'Entitles 24-bit WAV export as a PAID differentiator. FALSE on every plan as '
  'of migration 034: loops are already 24-bit WAV for every tier including '
  'free, so this flag can only ever overstate what a paid plan adds.';
