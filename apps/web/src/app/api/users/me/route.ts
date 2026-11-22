// DELETE /api/users/me — V3 Phase 1b RGPD account deletion (TSD §6.3).
//
// Permanently deletes the signed-in user's account. No undo.
//
// Body: { confirm_email: string } — must equal the user's own email
//   (trimmed, case-insensitive; emails are citext in public.users). The
//   /account/delete page enforces the same type-to-confirm in the browser;
//   this is the server-side check that cannot be bypassed.
//
// Responses:
//   204 — account deleted (session cookies are now dead; client redirects)
//   400 EMAIL_MISMATCH / INVALID_BODY
//   401 UNAUTHENTICATED
//   403 BAD_ORIGIN — Origin header present and not same-origin (CSRF guard;
//       DELETE + JSON already forces a CORS preflight, this is belt+braces)
//   502 SUBSCRIPTION_CANCEL_FAILED — Stripe refused, or its time budget ran
//       out; NOTHING was deleted, safe to retry. Alerted to Sentry with the
//       user's HMAC hash (review L-5).
//   502 CHECKOUT_EXPIRE_FAILED — QA-72: Stripe refused to expire an open
//       checkout session, or its time budget ran out; NOTHING was deleted,
//       safe to retry. Alerted the same way.
//   409 DEMO_ACCOUNT_DELETE_REFUSED — the account owns an is_demo job (Q-C, Phase B B2);
//       nothing was read from or sent to Stripe, nothing deleted.
//   500 DELETE_FAILED — the chord_edits erasure failed (NOTHING irreversible
//       happened: no subscription was cancelled, safe to retry), or the
//       account_deleted audit row (QA-72 M-2) or the Supabase Admin delete
//       failed after subscriptions were cancelled (users.deleted_at is
//       stamped, retry is idempotent)
//
// Order of operations (each step only runs if the previous one succeeded):
//   1. getUser() + confirm_email check
//   1b. Q-C: refuse (409) an account that owns any is_demo job, before any
//      subscription read or Stripe call.
//   2. read this user's subscriptions that are not 'canceled' (QA-53: paused
//      and incomplete too, not just active/trialing/past_due) and their
//      Stripe customer id (read-only).
//   2b. QA-72: expire every OPEN Stripe Checkout Session of the user's
//      customer (provider.expireOpenCheckoutSessions). A session stays open
//      24 h; completed in another tab after the deletion, it created and
//      billed a subscription for a user who no longer exists. Done BEFORE the
//      transaction (it holds no rows while Stripe answers) and before the
//      cancels below, so a session completed in the race is already a
//      subscription when they run. Expiring is harmless if a later step
//      fails (the user just starts a new checkout). Bounded by
//      CHECKOUT_EXPIRE_BUDGET_MS from the START of the request. A refusal is
//      a 502 with nothing deleted. Anything that still slips through (a
//      session made without a customer, the race) is closed by the webhook
//      backstop: billing/webhook cancels and refunds a subscription whose
//      account no longer exists.
//   3. ONE database transaction, in this order:
//        a. erase the user's public.chord_edits rows via
//           public.delete_chord_edits_for_user() (migration 031). chord_edits
//           has no ON DELETE CASCADE and is append-only for stemloops_app
//           (migration 025: no DELETE privilege), so a raw DELETE raises 42501;
//           the SECURITY DEFINER function is the one sanctioned erasure path.
//           It runs FIRST so a missing function / missing privilege / deadlock
//           fails the request while nothing irreversible has happened.
//        b. provider.cancelAllForAccountDeletion (lib/billing): lists the
//           customer's subscriptions AT STRIPE as well as our rows, cancels
//           immediately (not at period end, no proration) every one that is
//           not already over, whatever its status (writing its own
//           cancellation comment, QA-72 review M-1), and voids every open
//           (unpaid) invoice of the customer's subscriptions so none can be
//           paid later (QA-72 review M-3: renewals too, not just an
//           incomplete subscription's first invoice). A subscription Stripe says no longer exists counts as
//           cancelled. Bounded by t0 + STRIPE_BUDGET_MS (see the time budget).
//      The transaction COMMITs only after every cancel succeeded. If Stripe
//      refuses, the throw ROLLs BACK the erasure, so the user keeps their
//      account AND their chord edits (502, safe to retry). Stripe cannot be
//      rolled back, which is why it is the LAST thing inside the transaction:
//      the only way to cancel and still fail is the COMMIT itself failing (or
//      steps 5-6), and by then the erasure statement has already succeeded.
//   4. stamp public.users.deleted_at (tombstone; migration 021). Tolerates
//      the column not existing yet so the route works before 021 is applied.
//   5. append a usage_events row kind='account_deleted'. user_id is NULL;
//      the detail holds an HMAC of the user id, not the raw id or email, so
//      the audit trail carries no personal data. QA-72 review M-2: written
//      BEFORE the auth delete and required (a failure is a 500, safe to
//      retry): it is the webhook's proof that this account was deleted
//      through the app, without which the backstop never writes to Stripe.
//   6. Supabase Admin auth.admin.deleteUser. The DB then cascades per the
//      TSD §2.3 DDL (public.users and everything FK'd to it). We delete NO
//      rows ourselves other than the step-3 erasure.
//
// Errors from the erasure are NOT tolerated (no 42P01 / 42883 swallowing):
// a missing function (42883, migration 031 not applied) or a permission
// problem (42501) must stop the request before anything is cancelled, and is
// logged with its SQLSTATE so the operator can see which it was.
//
// Webhook interaction (not changed here): cancelling a subscription makes
// Stripe emit customer.subscription.deleted for a user that no longer
// exists moments later; the webhook's upsert may fail its FK and Stripe will
// retry/stop. See PR notes. QA-72: the webhook acknowledges events for a
// deleted account and, only when step 5's row proves the deletion, cancels +
// refunds a subscription that is still live for one, and refunds an invoice
// paid after the deletion (it never refunds a period this route left served).
// Operator steps for every alert: docs/runbooks/account-deletion-billing.md.

import { createHmac } from 'node:crypto';
import * as Sentry from '@sentry/nextjs';
import { NextRequest, NextResponse } from 'next/server';
import { deleteAuthUser, getUser } from '@/lib/auth/supabase';
import { getBillingProvider } from '@/lib/billing';
import { db } from '@/lib/db';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';
import { ipHashKey } from '@/lib/secret-env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Time budget (QA-53 / QA-72, same rule as the webhook's PR #298 budget).
// Every Stripe call is 6 s per attempt with no SDK retries (at most
// 2 x 6 = 12 s with stripe-node's forced reset retry), and the provider starts
// no call that could end after its deadline. Review L-1: BOTH deadlines are
// counted from the START of the request (t0), not from the step, so the auth
// lookup, the reads and a slow pool checkout eat into them instead of
// pushing the end of the request past maxDuration:
//   checkout expiry (QA-72)   ends by t0 + CHECKOUT_EXPIRE_BUDGET_MS (24 s):
//                             a list and an expire at their worst;
//   subscription cancel step  ends by t0 + STRIPE_BUDGET_MS (40 s): with
//                             the usual sub-second expiry that is more than
//                             a list + cancel + void at their worst (36 s);
//                             after a slow expiry it may not be, and the
//                             overrun is the same retryable 502 (the retry
//                             finds no open checkout and is fast).
// The remaining 20 s of maxDuration cover COMMIT, the tombstone, the Supabase
// admin delete and the audit row. Inside the transaction every statement and
// lock wait is capped too (ERASE_TX_* below), so a stuck lock is a 500, not a
// function killed mid-transaction. A budget overrun is a retryable 502 with
// nothing deleted.
export const maxDuration = 60;
const STRIPE_BUDGET_MS = 40_000;
const CHECKOUT_EXPIRE_BUDGET_MS = 24_000;
// Review L-1: like the webhook's SET LOCALs (webhook/route.ts). No
// idle_in_transaction timeout: the Stripe step legitimately idles the
// transaction for up to its budget.
const ERASE_TX_LOCK_TIMEOUT = '5s';
const ERASE_TX_STATEMENT_TIMEOUT = '10s';

/** Thrown inside the erase+cancel transaction so it ROLLs BACK and maps to 502. */
class SubscriptionCancelFailed extends Error {}

/** A deletion was refused because Stripe refused (the user was told to retry;
 *  nothing was deleted). Page a human: a live subscription or an open
 *  checkout may be behind it. Review L-5: carries the HMAC user hash (the
 *  same value the account_deleted audit row would hold), so the operator can
 *  find which user is stuck without an id or email in Sentry. */
function alertDeletionRefused(
  step: 'subscription_cancel' | 'checkout_expire',
  e: unknown,
  userHash: string,
  subscriptionRows: number | null = null,
): void {
  const x = e as { name?: string; code?: string; type?: string; message?: string } | null;
  const extra = {
    step,
    user_hash: userHash,
    subscriptionRows,
    error: x?.name ?? 'unknown',
    stripeCode: x?.code ?? null,
    stripeType: x?.type ?? null,
    detail: typeof x?.message === 'string' ? x.message.slice(0, 300) : null,
  };
  console.error('[users/me DELETE][ALERT] Stripe refused; account NOT deleted', JSON.stringify(extra));
  try {
    Sentry.captureMessage(`account deletion refused at ${step}; account not deleted (retryable)`, {
      level: 'error',
      tags: { route: 'api/users/me', qa: step === 'checkout_expire' ? 'QA-72' : 'QA-53' },
      extra,
    });
  } catch {
    // never let reporting change the answer
  }
}

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: message, code }, { status });
}

export async function DELETE(req: NextRequest) {
  // QA-72: the Stripe time budget counts from here, not from the Stripe step.
  const t0 = Date.now();
  // Destructive endpoint — require a same-origin browser request. DELETE verb
  // alone isn't a sufficient CSRF barrier (fetch can issue it cross-origin
  // when the server returns permissive CORS on a preflight), so we require
  // both an Origin header AND host-match. Missing Origin → 403 (fails closed;
  // non-browser clients that want to delete accounts must use the admin path).
  // Literal 'null' Origin (sandboxed iframe, data: URL) also rejected.
  // The rule lives in src/lib/same-origin.ts, shared with the POST routes,
  // and like them it now runs FIRST, before the session lookup.
  const originRefusal = crossOriginRefusal(req);
  if (originRefusal) return err(403, BAD_ORIGIN, originRefusal);

  const user = await getUser();
  if (!user) return err(401, 'UNAUTHENTICATED', 'Sign in to delete your account.');

  let body: { confirm_email?: unknown };
  try {
    body = (await req.json()) as { confirm_email?: unknown };
  } catch {
    return err(400, 'INVALID_BODY', 'Body must be JSON.');
  }
  const typed = typeof body?.confirm_email === 'string' ? body.confirm_email.trim().toLowerCase() : '';
  if (!typed || typed !== user.email.trim().toLowerCase()) {
    return err(400, 'EMAIL_MISMATCH', 'The email you typed does not match your account email.');
  }
  // QA track B, B-08: the audit hash below is keyed with IP_HASH_KEY, which now fails closed
  // in production when unset. Resolve it HERE, before anything is cancelled or deleted, so a
  // missing key refuses the whole request instead of failing half-way through it.
  let auditKey: string;
  try {
    auditKey = ipHashKey();
  } catch (e) {
    console.error('[users/me] DELETE refused:', e instanceof Error ? e.message : e);
    return err(500, 'INTERNAL_ERROR', 'Something went wrong on our end. Please try again.');
  }
  // HMAC-SHA256 with the server-side IP_HASH_KEY so the audit hash isn't a
  // confirmation oracle (plain SHA-256 of a known user_id would let anyone
  // with the uuid verify deletion). Reuses the existing IP_HASH_KEY
  // convention from lib/client-ip.ts rather than adding a new env var. The
  // audit row and the refusal alert carry the same value.
  const userHash = createHmac('sha256', auditKey).update(user.user_id).digest('hex');

  try {
    // 1b. Q-C (Phase B, B2): the account that owns the demo songs is never deleted here. Its
    //     deletion would clear is_demo on them (step 3) and take the Demo set and the home
    //     demo down for everyone. Checked by OWNERSHIP of an is_demo job, not by a hard-coded
    //     account id, and BEFORE step 2/2b: a refusal makes zero Stripe calls, writes no
    //     tombstone and leaves is_demo as it is. Inside the try, so a DB error is the normal
    //     500 DELETE_FAILED. `rows`, not rowCount: nothing found must read as "no demo".
    const demoOwned = await db.query(
      `SELECT 1 FROM public.jobs WHERE user_id = $1::uuid AND is_demo = true LIMIT 1`,
      [user.user_id],
    );
    if (demoOwned.rows.length > 0) {
      return err(409, 'DEMO_ACCOUNT_DELETE_REFUSED', "This account holds the demo songs and can't be deleted here.");
    }

    // 2. Read the subscriptions to cancel (read-only; nothing changes yet).
    //    Every status except 'canceled' (QA-53): a paused or incomplete
    //    subscription can still bill. The customer id lets the provider list
    //    the subscriptions it has, including any our webhook has not written.
    const provider = getBillingProvider();
    const subs = await db.query<{ provider_subscription_id: string }>(
      `SELECT provider_subscription_id FROM public.subscriptions
        WHERE user_id = $1::uuid AND provider = $2 AND status <> 'canceled'`,
      [user.user_id, provider.name],
    );
    const cust = await db.query<{ provider_customer_id: string }>(
      `SELECT provider_customer_id FROM public.customers_billing
        WHERE user_id = $1::uuid AND provider = $2`,
      [user.user_id, provider.name],
    );
    const knownIds = subs.rows.map((r) => r.provider_subscription_id);
    const customerId = cust.rows[0]?.provider_customer_id ?? null;

    // 2b. QA-72: no checkout of this user may complete after the deletion.
    let checkoutsExpired = 0;
    if (customerId) {
      try {
        const r = await provider.expireOpenCheckoutSessions(customerId, t0 + CHECKOUT_EXPIRE_BUDGET_MS);
        checkoutsExpired = r.expired.length;
      } catch (e) {
        alertDeletionRefused('checkout_expire', e, userHash);
        return err(
          502,
          'CHECKOUT_EXPIRE_FAILED',
          'We could not close your open checkout, so your account was not deleted. Please try again.',
        );
      }
    }

    // 3. Erase chord_edits, THEN cancel Stripe, in one transaction. See the
    //    header: the erasure goes first so its failure cancels nothing, and a
    //    Stripe failure rolls the erasure back.
    let cancelled = 0;
    let invoicesVoided = 0;
    try {
      await db.tx(async (client) => {
        // Review L-1: bound every lock wait and statement of this transaction.
        await client.query(
          `SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`,
          [ERASE_TX_LOCK_TIMEOUT, ERASE_TX_STATEMENT_TIMEOUT],
        );
        try {
          await client.query(`SELECT public.delete_chord_edits_for_user($1::uuid)`, [user.user_id]);
        } catch (e) {
          const code = (e as { code?: string } | null)?.code ?? 'unknown';
          // 42883 = undefined_function (migration 031 not applied),
          // 42501 = insufficient_privilege (EXECUTE not granted to this role).
          console.error(
            `[users/me DELETE] chord_edits erasure failed (SQLSTATE ${code}); nothing was cancelled or deleted:`,
            e instanceof Error ? e.message : 'unknown',
          );
          throw e;
        }

        // Kill the user's jobs. Without this, deleting auth.users runs the FK's
        // ON DELETE SET NULL on jobs.user_id and every live job (audio, stems,
        // loops) becomes an ANONYMOUS job: any link holder may then cut its loops
        // and any Studio account may sign its full-length WAVs, neither of which
        // the owner's job allowed. Inside this tx so a failed Stripe cancel below
        // leaves the jobs exactly as they were.
        //
        // expires_at = created_at, not now(): a Pro/Studio library is retained
        // PAST expires_at by the owner's subscription (JOB_RETAINED_UNTIL_SQL in
        // lib/retention.ts), and the cancel below only reaches the subscriptions
        // row later, via the webhook, which then starts 30 days' grace. The
        // retention rule ignores the subscription for any job whose expires_at is
        // <= created_at, so this turns paid retention off for good AND puts the
        // job in the past for every route (404) and for the worker's sweep, which
        // deletes the objects. LEAST() never extends a job; the WHERE skips jobs
        // already killed, so a retried deletion changes nothing.
        //
        // is_demo = false (migration 040): a demo song is retained until 2099 WHATEVER
        // its expires_at says, so without this the owner's deletion would leave it
        // retained AND anonymous (user_id SET NULL) — open to any id holder. Clearing
        // the flag puts it back on the expiry above, like every other job. The WHERE
        // also catches a demo already in the killed shape (expires_at = created_at).
        // Only ever writes false: no application path sets is_demo = true.
        await client.query(
          `UPDATE public.jobs SET expires_at = LEAST(expires_at, created_at), is_demo = false
            WHERE user_id = $1::uuid AND (expires_at > created_at OR is_demo)`,
          [user.user_id],
        );

        // Nothing to look up for a user who never reached checkout.
        if (knownIds.length > 0 || customerId) {
          try {
            const r = await provider.cancelAllForAccountDeletion(knownIds, customerId, t0 + STRIPE_BUDGET_MS);
            cancelled = r.cancelled.length;
            invoicesVoided = r.voidedInvoices.length;
          } catch (e) {
            alertDeletionRefused('subscription_cancel', e, userHash, knownIds.length);
            throw new SubscriptionCancelFailed();
          }
        }
      });
    } catch (e) {
      if (e instanceof SubscriptionCancelFailed) {
        return err(502, 'SUBSCRIPTION_CANCEL_FAILED', 'We could not cancel your subscription, so your account was not deleted. Please try again.');
      }
      throw e;
    }

    // 4. Tombstone (best-effort if migration 021 is not applied yet).
    try {
      await db.query(`UPDATE public.users SET deleted_at = now() WHERE id = $1::uuid`, [user.user_id]);
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== '42703') throw e; // 42703 = undefined_column
    }

    // 5. Audit (no personal data), BEFORE the auth delete and NOT
    //    best-effort (QA-72 review M-2). This row is the webhook's only proof
    //    that the account was deleted through the app: the backstop cancels
    //    and refunds a late subscription only for a user_hash that has it.
    //    Written first, so no webhook can find the auth user gone without
    //    it; a failed write is a 500 (DELETE_FAILED) and the retry converges
    //    (the cancels re-read Stripe). If the auth delete below then fails,
    //    the row stays (usage_events is append-only): it is only ever read
    //    for a user the database no longer has, and the user's retry adds
    //    the row that dates the real deletion (the webhook takes the latest).
    await db.query(
      `INSERT INTO public.usage_events (user_id, kind, detail) VALUES (NULL, 'account_deleted', $1::jsonb)`,
      [
        JSON.stringify({
          // See userHash above (HMAC, never the raw id or email).
          user_hash: userHash,
          subscriptions_cancelled: cancelled,
          invoices_voided: invoicesVoided,
          checkouts_expired: checkoutsExpired,
        }),
      ],
    );

    // 6. Delete the auth user; the DB cascades the rest.
    await deleteAuthUser(user.user_id);

    return new NextResponse(null, { status: 204 });
  } catch (e) {
    console.error('[users/me DELETE] failed:', e instanceof Error ? e.message : 'unknown');
    return err(500, 'DELETE_FAILED', 'We could not delete your account. Please try again.');
  }
}
