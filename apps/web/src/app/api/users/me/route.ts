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
//   502 SUBSCRIPTION_CANCEL_FAILED — Stripe refused; NOTHING was deleted,
//       safe to retry
//   500 DELETE_FAILED — the chord_edits erasure failed (NOTHING irreversible
//       happened: no subscription was cancelled, safe to retry), or the
//       Supabase Admin delete failed after subscriptions were cancelled
//       (users.deleted_at is stamped, retry is idempotent)
//
// Order of operations (each step only runs if the previous one succeeded):
//   1. getUser() + confirm_email check
//   2. read this user's active/trialing/past_due subscriptions (read-only).
//   3. ONE database transaction, in this order:
//        a. erase the user's public.chord_edits rows via
//           public.delete_chord_edits_for_user() (migration 031). chord_edits
//           has no ON DELETE CASCADE and is append-only for stemloops_app
//           (migration 025: no DELETE privilege), so a raw DELETE raises 42501;
//           the SECURITY DEFINER function is the one sanctioned erasure path.
//           It runs FIRST so a missing function / missing privilege / deadlock
//           fails the request while nothing irreversible has happened.
//        b. cancel each subscription immediately (not at period end — the
//           account is going away). A subscription Stripe says no longer
//           exists counts as cancelled.
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
import { NextRequest, NextResponse } from 'next/server';
import { deleteAuthUser, getUser } from '@/lib/auth/supabase';
import { getBillingProvider } from '@/lib/billing';
import { db } from '@/lib/db';
import { BAD_ORIGIN, crossOriginRefusal } from '@/lib/same-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CANCELLABLE_STATUSES = ['active', 'trialing', 'past_due'];

/** Thrown inside the erase+cancel transaction so it ROLLs BACK and maps to 502. */
class SubscriptionCancelFailed extends Error {}

function err(status: number, code: string, message: string) {
  return NextResponse.json({ error: message, code }, { status });
}

/** True when Stripe says the subscription is already gone / canceled. */
function isAlreadyCanceled(e: unknown): boolean {
  const x = e as { code?: string; statusCode?: number; message?: string } | null;
  if (!x) return false;
  if (x.code === 'resource_missing' || x.statusCode === 404) return true;
  return typeof x.message === 'string' && /already (been )?cancel/i.test(x.message);
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

  try {
    // 2. Read the subscriptions to cancel (read-only; nothing changes yet).
    const provider = getBillingProvider();
    const subs = await db.query<{ provider_subscription_id: string }>(
      `SELECT provider_subscription_id FROM public.subscriptions
        WHERE user_id = $1::uuid AND provider = $2 AND status = ANY($3::text[])`,
      [user.user_id, provider.name, CANCELLABLE_STATUSES],
    );

    // 3. Erase chord_edits, THEN cancel Stripe, in one transaction. See the
    //    header: the erasure goes first so its failure cancels nothing, and a
    //    Stripe failure rolls the erasure back.
    let cancelled = 0;
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

        // Expire the user's live jobs. Without this, deleting auth.users runs the
        // FK's ON DELETE SET NULL on jobs.user_id and every live job (audio, stems,
        // loops; up to 24 h) becomes an ANONYMOUS job: any link holder may then cut
        // its loops and any Studio account may sign its full-length WAVs, neither
        // of which the owner's job allowed. Every job route treats
        // expires_at <= now() as gone (404), and the worker's retention sweep
        // deletes the objects (cleanup.py, keyed on expires_at). Inside this tx so
        // a failed Stripe cancel below leaves the jobs exactly as they were.
        await client.query(
          `UPDATE public.jobs SET expires_at = now()
            WHERE user_id = $1::uuid AND expires_at > now()`,
          [user.user_id],
        );

        for (const row of subs.rows) {
          try {
            await provider.cancelSubscription(row.provider_subscription_id, false);
            cancelled += 1;
          } catch (e) {
            if (isAlreadyCanceled(e)) continue;
            console.error('[users/me DELETE] subscription cancel failed:', e instanceof Error ? e.message : 'unknown');
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
            user_hash: createHmac('sha256', process.env.IP_HASH_KEY ?? 'dev-key')
              .update(user.user_id)
              .digest('hex'),
            subscriptions_cancelled: cancelled,
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
