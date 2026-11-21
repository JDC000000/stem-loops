# Runbook: account deletion and billing alerts (QA-53 / QA-72)

Operator steps for every alert raised by account deletion (`DELETE /api/users/me`,
PR #314 QA-53 and PR #325 QA-72) and by the Stripe webhook backstop for deleted
accounts (`/api/billing/webhook`, QA-72). Every alert is a Sentry message with
`extra` fields. None of them carry a raw user id or an email.

## Identifiers you will see

| Field | What it is |
|---|---|
| `user_hash` | HMAC-SHA256 of the user id, keyed with `IP_HASH_KEY`. It is the same value as `detail->>'user_hash'` on the `account_deleted` row in `public.usage_events`. |
| `subscription`, `customer`, `invoice`, `refunds` | Stripe ids (`sub_`, `cus_`, `in_`, `re_`). Open them in the Stripe Dashboard, in the mode the alert came from. |
| `step` | Deletion only: `checkout_expire` or `subscription_cancel`. |
| `trigger` | Webhook only: `subscription_upserted`, `invoice_paid` or `checkout_session_completed`. |

### Finding a user from `user_hash`

- **Deleted account:** look up the audit row.
  ```sql
  SELECT created_at, detail FROM public.usage_events
   WHERE kind = 'account_deleted' AND detail->>'user_hash' = '<user_hash>'
   ORDER BY created_at;
  ```
- **Account that still exists** (a refused deletion): match the hash in the Supabase SQL editor with pgcrypto.
  - Paste `IP_HASH_KEY` from the Vercel env (Production) into the query for that session only.
  - Never paste it into a ticket, chat, PR or log.
  ```sql
  SELECT id, email FROM public.users
   WHERE encode(extensions.hmac(id::text, '<IP_HASH_KEY>', 'sha256'), 'hex') = '<user_hash>';
  ```

## Deletion alerts (`route: api/users/me`)

### A1. `account deletion refused at checkout_expire; account not deleted (retryable)`

**What happened**
- The user got `502 CHECKOUT_EXPIRE_FAILED`.
- Stripe refused to expire one of their open Checkout Sessions, or the 24 s time budget ran out.
- Nothing was deleted or cancelled.

**What to do**
1. Read `stripeCode` / `stripeType` / `detail`.
   - `rate_limit`, `api_connection_error` or a `StripeDeadlineError` are transient. Asking the user to retry is enough.
2. For anything else (for example `permission_error`):
   - Check that the restricted key has **Checkout Sessions: write**.
   - Fix the key in Vercel, then ask the user to retry.
3. If the user cannot wait:
   - Find the user (see above), then the customer (`customers_billing`).
   - In the Stripe Dashboard, expire the open Checkout Sessions of that customer.
   - Ask the user to retry the deletion.

### A2. `account deletion refused at subscription_cancel; account not deleted (retryable)`

**What happened**
- The user got `502 SUBSCRIPTION_CANCEL_FAILED`.
- One of the following failed or was refused, or the 40 s budget ran out:
  - listing the customer's subscriptions
  - cancelling them
  - listing their open invoices
  - voiding them
- The erase transaction rolled back. The account, chord edits and jobs are intact.
- Stripe may have cancelled some subscriptions already. A cancel cannot be rolled back.

**What to do**
1. Transient codes: ask the user to retry. A retry re-reads Stripe and converges.
2. Permission errors: the key needs all four of these. Fix the key, then ask for a retry.
   - Subscriptions: write
   - Invoices: write
   - Checkout Sessions: write
   - Invoice payments: read
3. Manual unblock, for a user stuck on 502 after the key is fixed:
   1. Find the user and their `cus_` id.
   2. In the Stripe Dashboard, for that customer:
      - cancel every subscription that is not canceled or incomplete_expired, immediately, with no proration;
      - void every **open** invoice of those subscriptions.
   3. Ask the user to retry. The retry now finds nothing to cancel and is fast.
   4. If the user is unreachable and must be deleted by an operator, use the in-app flow on their behalf; do not delete them in the Supabase dashboard (see W1 below).

### A3. `500 DELETE_FAILED` (no Sentry alert; Vercel log `[users/me DELETE] failed`)

Cause: one of these failed:
- the chord-edits erasure
- the tombstone
- the `account_deleted` audit row, which is required (QA-72 M-2)
- the Supabase auth delete

**What to do**
1. Find which step failed. The log line carries the message.
2. If the auth delete failed after the audit row was written:
   - The row stays; `usage_events` is append-only.
   - It is harmless. It is only read for a user the database no longer has.
   - The user's retry writes a second row, and that row dates the real deletion.
3. Ask the user to retry.

## Webhook alerts (`route: api/billing/webhook`, tag `QA-72`)

The backstop writes to Stripe (cancel, void, refund) **only** for a user that both:
- is missing from the database (the users foreign key fails with 23503), and
- has an `account_deleted` row with a matching `user_hash` (review M-2).

Everything else is alert-only, and the webhook answers 200 so Stripe stops retrying.

### W1. `subscription event for a user this database does not have, and no in-app deletion on record; NOT cancelled or refunded, check by hand`

`extra.account = missing_unproven`, `extra.action = alert_only`.

**Likely causes, in order**
1. **A second webhook endpoint on another database.**
   - Example: staging, or `stripe listen --forward-to localhost`, on the same Stripe account and mode as production.
   - That endpoint's database simply does not have the user.
   - Check which deployment raised it (Sentry environment / release).
   - Every Stripe webhook endpoint must map 1:1 to its database.
   - Remove or re-point the stray endpoint. Nothing to do for the customer.
2. **A user deleted outside the app** (for example from the Supabase dashboard).
   - #314's cancels never ran, so the subscription may still be live and billing.
   - In the Stripe Dashboard, open `subscription`:
     - if it is live, cancel it immediately (no proration) and void its open invoices;
     - decide by hand whether to refund the latest paid invoice;
     - add a note on the customer.
3. **A restored or rotated database** that lost users. Treat it as an incident, not per-customer.

### W2. `subscription no account owns; NOT cancelled or refunded, check by hand`

`extra.account = no_user`.

What happened: a subscription, or a subscription checkout on one of our prices, has:
- no `user_id` metadata,
- a customer not in `customers_billing`, and
- no subscriptions row.

**What to do**
1. Open the subscription and customer in Stripe.
   - Was it made in the Dashboard, by a Payment Link, or by another product on the same account?
2. If a real customer is paying for nothing:
   - link them to their account (insert `customers_billing` and set the subscription's `metadata.user_id`), then resend the event from the Dashboard; or
   - cancel and refund by hand.

### W3. `subscription of a deleted account is not on one of our prices; NOT cancelled or refunded, check by hand`

`extra.foreign_price = true` (review L-2).

- The account was proven deleted, but the subscription has an item that is not one of our plan prices.
- Decide by hand whether it is ours to cancel or refund.

### W4. `subscription of a deleted account is paid but cannot be refunded automatically; refund it by hand`

The subscription was cancelled (when `extra.cancelled` is true). One invoice could not be refunded by the API. An audit row `orphan_subscription_closed` was written.

| `extra.refund_refused_code` | Meaning | Action |
|---|---|---|
| null | The invoice was paid with no refundable payment (credit balance, paid out of band, a payment record). | Refund the customer by the original route, or credit their balance. |
| `charge_disputed`, `refund_disputed_payment` | The charge was charged back. | Do **not** refund. Handle the dispute in Stripe; the chargeback already returns the money. |
| `charge_not_refundable`, `charge_expired_for_capture` | Stripe will never refund this charge. | Refund by another route (bank transfer, customer credit). |

Retryable refusals (rate limits, connection errors, `balance_insufficient`, API errors) do **not** raise this alert. They are a 500, and Stripe redelivers.

### W5. `invoice paid after the account was deleted; refunded`

Review M-3:
- A renewal (or any invoice) of a deleted account was paid **after** the `account_deleted` row's time, for example from the hosted invoice page.
- It was refunded in full automatically. `extra.refunds` / `extra.refunded_invoices` list what was done.

**What to do:** nothing, unless a refund failed (that would be W4).

Note: since QA-72, deletion voids every open invoice of the user's subscriptions. If this alert repeats, check whether invoices are being finalised after deletion, for example a draft that finalised later.

### W6. `subscription of a deleted account cancelled and refunded`

A subscription that was still live after a proven deletion was cancelled and its latest paid invoice was refunded in full. The usual case is a checkout completed in another tab during deletion.

What the backstop did:
- The cancel carries the HMAC marker (`stem-loops QA-72 <64 hex>`) in `cancellation_details.comment`.
- It wrote one audit row, `orphan_subscription_closed`.

**What to do:** nothing.

The refund covers the latest invoice only. If the customer was a long-standing subscriber who survived an old (pre-QA-53) deletion, decide by hand about earlier invoices.

### Not an alert, for reference

- **`[webhook] ... account deleted, nothing left to close` (console only):**
  - an event for a subscription the deletion itself cancelled, or
  - a renewal paid **before** the deletion (a served period, kept).
- **`Stripe event mode does not match the API key mode`** (review I-1): the endpoint secret and the API key are in different modes. Fix the env; Stripe retries for about 3 days.
