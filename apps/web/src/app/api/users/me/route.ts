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
//       out; NOTHING was deleted, safe to retry. Alerted to Sentry.
//   500 DELETE_FAILED — the chord_edits erasure failed (NOTHING irreversible
//       happened: no subscription was cancelled, safe to retry), or the
//       Supabase Admin delete failed after subscriptions were cancelled
//       (users.deleted_at is stamped, retry is idempotent)
//
// Order of operations (each step only runs if the previous one succeeded):
//   1. getUser() + confirm_email check
//   2. read this user's subscriptions that are not 'canceled' (QA-53: paused
//      and incomplete too, not just active/trialing/past_due) and their
//      Stripe customer id (read-only).
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
//           not already over, whatever its status, and voids an incomplete
//           subscription's still-open first invoice so it cannot be paid
//           later. A subscription Stripe says no longer exists counts as
//           cancelled. Bounded by STRIPE_BUDGET_MS (see the time budget).
//      The transaction COMMITs only after every cancel succeeded. If Stripe
//      refuses, the throw ROLLs BACK the erasure, so the user keeps their
//      account AND their chord edits (502, safe to retry). Stripe cannot be
//      rolled back, which is why it is the LAST thing inside the transaction:
//      the only way to cancel and still fail is the COMMIT itself failing (or
//      step 5), and by then the erasure statement has already succeeded.
//   4. stamp public.users.deleted_at (tombstone; migration 021). Tolerates
//      the column not existing yet so the route works before 021 is applied.
//   5. Supabase Admin auth.admin.deleteUser. The DB then cascades per the
//      TSD §2.3 DDL (public.users and everything FK'd to it). We delete NO
//      rows ourselves other than the step-3 erasure.
//   6. append a usage_events row kind='account_deleted'. user_id is NULL
//      (the FK is ON DELETE SET NULL and the user is gone); the detail holds
//      an HMAC of the user id, not the raw id or email, so the audit trail
//      carries no personal data. Failure here is logged, not surfaced — the
//      account is already gone.
//
// Errors from the erasure are NOT tolerated (no 42P01 / 42883 swallowing):
// a missing function (42883, migration 031 not applied) or a permission
// problem (42501) must stop the request before anything is cancelled, and is
// logged with its SQLSTATE so the operator can see which it was.
//
// Webhook interaction (not changed here): cancelling a subscription makes
// Stripe emit customer.subscription.deleted for a user that no longer
// exists moments later; the webhook's upsert may fail its FK and Stripe will
// retry/stop. See PR notes.

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

// Time budget (QA-53, same rule as the webhook's PR #298 budget). The Stripe
// step runs inside the erase transaction, holding a pooled connection, so it
// is bounded: every Stripe call is 6 s per attempt with no SDK retries (at
// most 2 x 6 = 12 s with stripe-node's forced reset retry), and the provider
// starts no call that could end after STRIPE_BUDGET_MS. 36 s fits a list,
// a cancel and a void (3 x 12 s), which is one subscription's worst case;
// the remaining 24 s of maxDuration cover the auth lookup, the millisecond
// statements, COMMIT, the Supabase admin delete and the audit row. A budget
// overrun is a retryable 502 with nothing deleted, never a killed function
// in the middle of the transaction.
export const maxDuration = 60;
const STRIPE_BUDGET_MS = 36_000;

/** Thrown inside the erase+cancel transaction so it ROLLs BACK and maps to 502. */
class SubscriptionCancelFailed extends Error {}

/** A live subscription may have survived a refused deletion: page a human
 *  (the user was told to retry; nothing was deleted). Ids and codes only. */
function alertCancelFailed(e: unknown, subscriptionRows: number): void {
  const x = e as { name?: string; code?: string; type?: string; message?: string } | null;
  const extra = {
    error: x?.name ?? 'unknown',
    stripeCode: x?.code ?? null,
    stripeType: x?.type ?? null,
    detail: typeof x?.message === 'string' ? x.message.slice(0, 300) : null,
    subscriptionRows,
  };
  console.error('[users/me DELETE][ALERT] subscription cancel failed; account NOT deleted', JSON.stringify(extra));
  try {
    Sentry.captureMessage('account deletion: subscription cancel failed, account not deleted (retryable)', {
      level: 'error',
      tags: { route: 'api/users/me', qa: 'QA-53' },
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

  try {
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

    // 3. Erase chord_edits, THEN cancel Stripe, in one transaction. See the
    //    header: the erasure goes first so its failure cancels nothing, and a
    //    Stripe failure rolls the erasure back.
    let cancelled = 0;
    let invoicesVoided = 0;
    try {
      await db.tx(async (client) => {
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
            const r = await provider.cancelAllForAccountDeletion(knownIds, customerId, Date.now() + STRIPE_BUDGET_MS);
            cancelled = r.cancelled.length;
            invoicesVoided = r.voidedInvoices.length;
          } catch (e) {
            alertCancelFailed(e, knownIds.length);
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

    // 5. Delete the auth user; the DB cascades the rest.
    await deleteAuthUser(user.user_id);

    // 6. Audit (no personal data).
    try {
      await db.query(
        `INSERT INTO public.usage_events (user_id, kind, detail) VALUES (NULL, 'account_deleted', $1::jsonb)`,
        [
          JSON.stringify({
            // HMAC-SHA256 with the server-side IP_HASH_KEY so the audit hash
            // isn't a confirmation oracle (plain SHA-256 of a known user_id
            // would let anyone with the uuid verify deletion). Reuses the
            // existing IP_HASH_KEY convention from lib/client-ip.ts rather
            // than adding a new env var.
            user_hash: createHmac('sha256', auditKey)
              .update(user.user_id)
              .digest('hex'),
            subscriptions_cancelled: cancelled,
            invoices_voided: invoicesVoided,
          }),
        ],
      );
    } catch (e) {
      console.error('[users/me DELETE] audit insert failed:', e instanceof Error ? e.message : 'unknown');
    }

    return new NextResponse(null, { status: 204 });
  } catch (e) {
    console.error('[users/me DELETE] failed:', e instanceof Error ? e.message : 'unknown');
    return err(500, 'DELETE_FAILED', 'We could not delete your account. Please try again.');
  }
}
