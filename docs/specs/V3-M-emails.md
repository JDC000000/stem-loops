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

Copy and rules: emails v1.2 (Project doc `claude/emails-v1.2-2026-11-13.md`),
IDs R2–R7 below. The billing webhook translates provider events (Stripe today,
Paddle later) into `BillingEvent`s (see `apps/web/src/lib/billing/types.ts`).
Each event sends at most one change email (plus R2 the first time a plan is
active), chosen by comparing the stored `subscriptions` row (read before the
upsert) with the event. All sends are
best-effort: the dispatcher is wrapped in `emailBestEffort(...)` so a Resend
outage or a template bug can NEVER cause Stripe to retry the webhook.

| Abstracted event | Stripe event(s) | Email | Template |
| --- | --- | --- | --- |
| `subscription_upserted`, status `active`/`trialing`, user never welcomed | `customer.subscription.created` / `.updated` | R2 welcome (once per user, `users.welcomed_at`); never on `incomplete` | `welcome.ts` |
| `subscription_upserted`, no stored row or stored `incomplete`, now active, R2 not sent in this event | same | R4 "Your Pro plan is active" (a re-subscriber) | `subscription-changed.ts` |
| `subscription_upserted`, `cancel_at_period_end` false → true | `customer.subscription.updated` (portal cancel) | R5 plan ending ("ends on …", access until period end) | `plan-ending.ts` |
| `subscription_upserted`, plan changed while active | same | R4 "Your plan is now Studio" | `subscription-changed.ts` |
| `subscription_upserted`, became `paused` / paused or past_due → `active` | same | R4 "paused" / "active again" | `subscription-changed.ts` |
| `subscription_upserted`, anything else (renewal, `incomplete`, `past_due`, `canceled`) | same | none | — |
| `subscription_canceled` for a stored plan that was not `incomplete` | `customer.subscription.deleted` | R6 plan ended (access has ended; the handler downgrades) | `plan-ended.ts` |
| `invoice_payment_failed` with `billing_reason` `subscription_cycle` or `subscription_update`, stored row matched | `invoice.payment_failed` | R7 payment failed (grace date = period start + 7 days) | `payment-failed.ts` |
| `invoice_payment_failed` with `subscription_create` (declined card at Checkout) | same | none | — |
| `credit_purchase_completed` | `checkout.session.completed` (mode=payment) | R3 receipt (credit pack) | `receipt.ts` |
| `invoice_paid` | `invoice.paid` | R3 receipt; "Pro plan" for `subscription_create`, "Pro plan renewal" for `subscription_cycle` | `receipt.ts` |

Note on "first subscription": the mode=subscription Checkout session is NOT
emitted as a first-class `BillingEvent` — the companion
`customer.subscription.created` (and any `.updated`) arrives as
`subscription_upserted`. A first subscription sends R2 + R3 only.

`emailForUser` skips users whose `deleted_at` is set, so a webhook that lands
while an account is being deleted sends nothing.

## Variables per template

| Template | File | Variables |
| --- | --- | --- |
| R2 welcome | `templates/welcome.ts` | `plan_code`, `period_end`, `monthly_job_quota` (from `plans`; clause omitted when unknown) |
| R3 receipt | `templates/receipt.ts` | `amount_cad_cents`, `plan_or_pack_label`, `invoice_url \| null`, `kind` (`credit_pack` / `subscription`), `paid_on` |
| R4 plan changed | `templates/subscription-changed.ts` | `plan_code`, `status` (`active` / `trialing` / `paused`), `period_end`, `previous_plan_code`, `resumed`, `monthly_job_quota` |
| R5 plan ending | `templates/plan-ending.ts` | `plan_code`, `period_end`, `undo_available` (D4a; default false) |
| R6 plan ended | `templates/plan-ended.ts` | `plan_code`, `period_end`, `now`, `on_free`, `free_quota` |
| R7 payment failed | `templates/payment-failed.ts` | `plan_code`, `grace_end`, `now`, `next_attempt` |

Each template exports a `render…` function returning `{subject, html, text}`
and is pure: the same input renders the same bytes (`now` is injected). The
shell is the dark one from emails v1.2 §2.4; lime is used only on the single
CTA. The footer comes from `footerFor(kind)`; its "Reply if something doesn't
work" line is rendered only when `EMAIL_REPLY_TO` is set.

## Welcome idempotency

`users.welcomed_at timestamptz` is read and written by
`sendWelcomeIfFirstTime`. The column exists: migration
`019_v3_users_welcomed_at.sql` (with its `down/` file) created it. (An earlier
version of this file said the column was "not created by this PR"; that was
true of the Phase 1a PR and is no longer the state of the repo — emails v1.2
E11.) The `catch` in `shouldSendWelcome` still degrades to "send" on a DB
that predates 019, for local bring-up only.

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
- `apps/web/src/lib/emails/dispatch.ts` — `sendWelcomeIfFirstTime` / `sendSubscriptionChanged` / `sendPlanEnding` / `sendPlanEnded` / `sendPaymentFailed` / `sendReceipt`
- `apps/web/src/lib/emails/templates/shared.ts` — escape, URL guard, CAD and date formatters, dark HTML shell, plain-text builder, `footerFor`
- `apps/web/src/lib/emails/templates/{welcome,receipt,subscription-changed,plan-ending,plan-ended,payment-failed}.ts`
- `apps/web/src/app/api/billing/webhook/route.ts` — call-sites inside `handleBillingEvent`
- `apps/web/test/emails.test.mjs` — fetch mock + retry assertions + template pins
- `apps/web/test/emails-v12-templates.test.mjs` — subject, lead, plain text and footer for every template
- `apps/web/test/emails-dispatch.test.mjs` — idempotency keys, deleted-user skip
- `apps/web/test/webhook-subscription-emails.test.mjs` — which Stripe event sends which email
