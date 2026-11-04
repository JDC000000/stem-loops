# V3-M: Transactional Email (welcome / subscription-changed / receipt)

**Authoritative TSD:** §M in `TSD-V3-DELTA.md` on the Claude Projects "Stem Loops - Project 2026" workspace.

**Why this file exists:** mirrors the stable parts of TSD §M so reviewers, CI
tests, and future worker agents can cite them inline.

**Provider:** Resend (`RESEND_API_KEY`, server-side only). From address:
`stem-loops <notifications@stem-loops.com>`. Until the domain is verified in
Resend, set `RESEND_SANDBOX=1` to fall back to `onboarding@resend.dev` (the
shared Resend sandbox sender) — in sandbox, Resend only delivers to the
account owner's verified address, which is acceptable for Phase 1a bring-up.

## Triggers → templates (abstracted)

The billing webhook translates provider events (Stripe today, Paddle later)
into `BillingEvent`s (see `apps/web/src/lib/billing/types.ts`). Each is
mapped to zero, one, or two emails. All sends are best-effort — the
dispatcher is wrapped in `emailBestEffort(...)` so a Resend outage or a
template bug can NEVER cause Stripe to retry the webhook.

| Abstracted event | Stripe event(s) | Emails sent | Template |
| --- | --- | --- | --- |
| `subscription_upserted` | `customer.subscription.created`, `customer.subscription.updated` | welcome (first-time only) + subscription-changed | `welcome.ts`, `subscription-changed.ts` |
| `subscription_canceled` | `customer.subscription.deleted` | subscription-changed (status=`canceled`) | `subscription-changed.ts` |
| `credit_purchase_completed` | `checkout.session.completed` (mode=payment) | receipt | `receipt.ts` |
| `invoice_paid` | `invoice.paid` | receipt | `receipt.ts` |

Note on "first subscription → welcome + sub-changed": the task brief lists
the trigger as `checkout.session.completed` where mode=subscription. In the
Stripe provider adapter, the mode=subscription Checkout session is NOT
emitted as a first-class `BillingEvent` — it is the companion
`customer.subscription.created` that hits the webhook as `subscription_
upserted` and that we hook. Same user-visible behaviour, one source of truth.

## Variables per template

| Template | File | Required variables |
| --- | --- | --- |
| welcome | `apps/web/src/lib/emails/templates/welcome.ts` | — (uses only siteBase; no per-user data today, see `WelcomeVars` for expansion shape) |
| subscription-changed | `apps/web/src/lib/emails/templates/subscription-changed.ts` | `plan_code` (`free`/`pro`/`studio`), `status` (SubscriptionStatus union), `period_end` (Date \| ISO string \| null) |
| receipt | `apps/web/src/lib/emails/templates/receipt.ts` | `amount_cad_cents` (int), `plan_or_pack_label` (string), `invoice_url` (string \| null) |

Each template exports a `render…` function returning `{subject, html}` and
is pure — same input renders the same bytes (see `test/emails.test.mjs`
"deterministic for a fixed input").

## Welcome idempotency

A `users.welcomed_at timestamptz` column is read + written by
`sendWelcomeIfFirstTime`. The column is **not** created by this PR — adding
a migration from an email-only patch is out of scope. Behaviour when the
column is absent: every `subscription_upserted` event sends a welcome.
Phase 1b: ship migration `0XX_users_welcomed_at.sql` and this file becomes
authoritative.

## Why not send welcome from auth signup?

Considered an auth callback hook (`/api/auth/me` or a Supabase Edge
Function trigger on `handle_new_user`). Rejected for Phase 1a because:

1. Supabase email-confirmation flow already sends an email on signup; a
   second one before the user converts clutters the inbox.
2. Stem-loops' value event is "first paid run" — tying welcome to
   checkout keeps the timing meaningful and moves one DB write out of the
   signup path.
3. The webhook has the full transactional context (user_id resolved,
   email known) — no extra cross-service hop needed.

Phase 1b may revisit this if signup-only (free-tier) welcome becomes
useful.

## Failure mode

- Resend 5xx → one retry after 1s. Two consecutive 5xx → log + Sentry
  `captureException` tagged `subsystem=emails`, template name on the tag.
  Webhook continues.
- Resend 4xx → no retry, log + Sentry, webhook continues.
- Network error → one retry, then log + Sentry, webhook continues.
- `RESEND_API_KEY` unset → warn log, return `{ok:false}`, webhook continues.
- Dispatcher-level throw (template render bug, DB unreachable during
  user-email lookup) → caught inside `emailBestEffort`, webhook continues.

Nothing here can block Stripe's retry logic or desync entitlements. That
is the entire contract this module has with the rest of V3.

## Files

- `apps/web/src/lib/emails/resend.ts` — HTTP client + retry policy
- `apps/web/src/lib/emails/dispatch.ts` — `sendWelcomeIfFirstTime` / `sendSubscriptionChanged` / `sendReceipt`
- `apps/web/src/lib/emails/templates/shared.ts` — escape, URL guard, CAD formatter, HTML shell
- `apps/web/src/lib/emails/templates/{welcome,subscription-changed,receipt}.ts`
- `apps/web/src/app/api/billing/webhook/route.ts` — call-sites inside `handleBillingEvent`
- `apps/web/test/emails.test.mjs` — fetch mock + retry assertions + template determinism
