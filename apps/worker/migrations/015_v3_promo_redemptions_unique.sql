-- 015_v3_promo_redemptions_unique.sql — V3 Phase 1a round-2 review fix.
--
-- Round-1 adversarial review MEDIUM finding: 013_v3_commercial.sql declares
-- promo_redemptions as append-only with the webhook writing
-- `ON CONFLICT DO NOTHING` in its header-comment contract (route.ts:17), but
-- the table only has `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` — no
-- natural unique constraint. Every Stripe webhook retry (the common case on
-- 2xx latency) double-inserts the same redemption, inflating the audit log
-- and distorting any downstream coupon-abuse analytics.
--
-- Fix: add a NATURAL unique constraint on (user_id, stripe_promotion_code_id)
-- so the webhook's ON CONFLICT clause has a real target. The webhook INSERT is
-- updated in the same PR to match this constraint.
--
-- NULL-handling note: Postgres default UNIQUE treats NULLs as distinct — two
-- rows with stripe_promotion_code_id=NULL are allowed under this constraint.
-- That is intentional for Phase 1a:
--   • The webhook currently only knows the raw `code` string (session.metadata
--     `promo_code`), not the Stripe Promotion Code ID, so most Phase 1a rows
--     will land with stripe_promotion_code_id=NULL. Enforcing uniqueness on a
--     NULL-defaulted column via `NULLS NOT DISTINCT` would collapse every one
--     of those rows into one, erasing the audit trail.
--   • When Phase 1b resolves the Promotion Code ID at checkout-time and writes
--     it here, each (user, promotion_code) pair is uniquely constrained and
--     Stripe retries are correctly deduped.
-- When the Phase 1b work lands, revisit this to add a partial unique index
-- that also covers (user_id, code) for the code-string path.

-- Pre-cleanup: in case any duplicate rows crept in before this migration
-- lands, de-dupe the (user_id, stripe_promotion_code_id) pairs that would
-- otherwise block constraint creation. Keep the earliest row (lowest id).
DELETE FROM public.promo_redemptions a
USING public.promo_redemptions b
WHERE a.id > b.id
  AND a.user_id = b.user_id
  AND a.stripe_promotion_code_id IS NOT NULL
  AND b.stripe_promotion_code_id IS NOT NULL
  AND a.stripe_promotion_code_id = b.stripe_promotion_code_id;

ALTER TABLE public.promo_redemptions
  DROP CONSTRAINT IF EXISTS promo_redemptions_user_stripe_code_uniq;

ALTER TABLE public.promo_redemptions
  ADD CONSTRAINT promo_redemptions_user_stripe_code_uniq
  UNIQUE (user_id, stripe_promotion_code_id);
