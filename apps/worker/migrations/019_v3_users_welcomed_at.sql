-- 019_v3_users_welcomed_at.sql — add users.welcomed_at so the V3-M1 welcome
-- email is idempotent.
--
-- Background. PR #38 shipped V3-M1/M2/M3 transactional emails. The welcome
-- dispatcher already READS `welcomed_at` and swallows a missing-column error
-- as "send it" (dispatch.ts:shouldSendWelcome) — a deliberate graceful
-- degrade for the migration-less phase. Lens A on PR #38 flagged the
-- side-effect: every `subscription_upserted` event (Stripe retries, plan
-- changes, status flips) fired a welcome email. Users renewing or switching
-- plans got re-welcomed; spammy, and reputational risk for the sender
-- domain.
--
-- After this migration:
--   • dispatch.ts shouldSendWelcome SELECTs welcomed_at and returns false when
--     non-null (already welcomed).
--   • dispatch.ts markWelcomed() UPDATEs welcomed_at = now() AFTER a successful
--     send, so a Resend failure leaves the user eligible for a retry on the
--     next webhook.
--
-- Index rationale. `users_welcomed_at_null_idx` is a partial index on
-- `id WHERE welcomed_at IS NULL`. The webhook's shouldSendWelcome lookup is a
-- PK read, so this index mainly helps future batch "who hasn't been welcomed"
-- jobs stay cheap once the common case (every mature user is welcomed) makes
-- the full index dense and the partial index tiny.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS. Safe on
-- a fresh DB and on a re-run. Append-only per §11 Merge Safety Rule (b).

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS welcomed_at timestamptz;

CREATE INDEX IF NOT EXISTS users_welcomed_at_null_idx
  ON public.users (id) WHERE welcomed_at IS NULL;

COMMENT ON COLUMN public.users.welcomed_at IS
  'Set once by the V3-M1 welcome dispatcher after a successful Resend send. NULL means no welcome email has been sent yet.';
