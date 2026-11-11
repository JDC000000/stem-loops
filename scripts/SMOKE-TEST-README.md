# Staging billing smoke test

`scripts/smoke_staging.mjs` drives the V3 billing path end-to-end against live
staging (Vercel + Supabase + Stripe BC sandbox). Zero npm dependencies (Node 18+).

## What it does

| # | Step | Result type |
|---|------|-------------|
| 1 | `GET /pricing` returns 200 and does not contain `live plan data is temporarily unavailable` (else FAIL, bail out) | PASS/FAIL |
| 2 | Pricing page shows Pro $4.99 CAD, Studio $12 CAD, and the 20/60/180 credit packs | PASS/FAIL |
| 3 | Create `smoke-test-<ts>@stemloops.test` via Supabase Admin API, confirm it exists; 3b mint its session via the Admin API (`admin/generate_link` + `verify`) and build the `@supabase/ssr` session cookie | PASS/FAIL |
| 4 | `POST /api/users/me/trial/grant` twice | PASS/FAIL |
| 5 | `GET /api/entitlements` -> `plan_code: free`, youtube/spotify/soundcloud | PASS/FAIL |
| 6 | `GET /api/billing/credits/balance` -> `credits_remaining: 0` | PASS/FAIL |
| 7 | `POST /api/billing/checkout {pack_code:'credits_20'}` -> `checkout_url`, GET it for 200 | PASS/FAIL, card submit SKIP |
| 8 | `POST /api/billing/checkout {plan_code:'pro'}` -> same | PASS/FAIL, card submit SKIP |
| 9 | Expire Stripe sessions, delete Stripe customer, delete user, verify absent from `auth.users` and no rows left in dependent public tables | PASS/FAIL |

Cleanup (step 9) always runs once a user was created. If it fails, the output
prints the email and id for manual deletion.

## Environment variables

Read from the shell, or from `./.env.staging` (repo root, gitignored by `.env*`;
override path with `SMOKE_ENV_FILE`). Shell values win.

| Var | Required | Where to get it |
|-----|----------|-----------------|
| `SUPABASE_URL` | yes | `https://ylzokjwnsraehmpclnkx.supabase.co` (scheme optional) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase dashboard > Project Settings > API Keys > the secret key labelled `service` (description: `service_role`; click Reveal), or `vercel env pull .env.staging --environment=preview`. Also mints the test user's session — see "How step 3b signs in" below. |
| `STRIPE_SECRET_KEY` | recommended | Stripe sandbox > Developers > API keys (`sk_test_...`). Enables session verification (mode, CAD, amount) and Stripe cleanup. Without it those parts are skipped. |
| `STAGING_BASE_URL` | no | Default `https://stem-loops-staging.vercel.app` |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | only if staging has deployment protection | Vercel project > Settings > Deployment Protection |

No anon/publishable key is needed. The app authenticates by `@supabase/ssr`
cookie only, so the script still has to obtain a session as the test user, but
it does that over the Admin API rather than a password grant (below). The
service-role key must never be committed.

## How step 3b signs in (and why not a password grant)

Two different hCaptcha layers exist in this product and earlier notes in this
repo conflated them:

1. **The app's own bot challenge** — `apps/web/src/lib/hcaptcha.ts`,
   `verifyHcaptchaToken()` against `https://hcaptcha.com/siteverify` with
   `HCAPTCHA_SECRET_KEY`. Fails closed by design. Not what blocks sign-in here.
2. **Supabase Auth's built-in captcha** — Dashboard > Authentication > Attack
   Protection > Captcha protection. While that is on, *every*
   `POST /auth/v1/token?grant_type=password` must carry a `captchaToken` or
   GoTrue returns `400 captcha_failed` / `no captcha_token found`.

Layer 2 is what broke `Nightly staging smoke` for five consecutive nights
(Nov 7-10 2026, runs 42388723786 / 42499514523 / 42690172243 / 42863665335 /
42887209202): step 3b failed and steps 4-8 all SKIPped, so the money path went
unexercised. A script cannot solve a captcha, and that setting is legitimate
production hardening, so the password grant is gone rather than the captcha.

Step 3b now mints the session with the service role, which admin endpoints
accept and captcha does not gate:

```
POST /auth/v1/admin/generate_link   { type: 'magiclink', email }
     -> 200 { hashed_token, verification_type, action_link, email_otp, ... }   (sends no email)
POST /auth/v1/verify                { token_hash, type }
     -> 200 { access_token, refresh_token, expires_in, expires_at, token_type, user }
```

The second response has the same shape the password grant returned, so the
existing `sessionCookieHeader()` and steps 4-8 are unchanged. The
implementation and the GoTrue source references that pin each endpoint's shape
live in `scripts/lib/smoke_session.mjs`; its unit tests (stubbed `fetch`,
including a no-credential-leak test) are in
`apps/web/test/smoke-staging-session.test.mjs`.

**Do not disable Supabase's captcha protection to make this test pass.**

## Run

```
node scripts/smoke_staging.mjs
```

Exit codes: `0` all PASS/SKIP, `1` any FAIL, `2` setup problem (missing env; the
public steps 1-2 still run first, then setup instructions print). Expected
runtime is roughly 30 seconds. CI: export the vars as secrets, then run the same
command.

## Manual steps (SKIP in the table)

Entering a card in Stripe Checkout (hCaptcha plus Stripe UI) is not scripted and
is not bypassed. Use test card `4242 4242 4242 4242` on a checkout URL by hand
to exercise the webhook. Sign-in is no longer a manual step: see "How step 3b
signs in" above.

## Known contract differences from the original brief

The script asserts what the code at `v3/main` actually ships:

- Trial grant takes no fingerprint. The first call returns `{granted:true, songs_remaining:3, expires_at, expired}`; the repeat returns HTTP 200 `{granted:false, songs_remaining:3}` (idempotent), not 409 `TRIAL_ALREADY_USED`, and there is no `songs_available` field.
- The pricing page falls back to hard-coded identical prices when the DB is down, so step 2 alone cannot detect degradation; step 1's banner check does.
- `usage_events.user_id` is `ON DELETE SET NULL`, so those rows may survive anonymized.

## Running against prod later

Not recommended without review. Set `STAGING_BASE_URL=https://stem-loops.com`,
the prod `SUPABASE_URL` / keys, a live `STRIPE_SECRET_KEY`, and `SMOKE_ALLOW_PROD=1`
(the script refuses otherwise). Checkout steps create real live-mode sessions
(expired and the customer deleted at cleanup).
