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
//   500 DELETE_FAILED — Supabase Admin delete failed after subscriptions
//       were cancelled; users.deleted_at is stamped, retry is idempotent
//
// Order of operations (each step only runs if the previous one succeeded):
//   1. getUser() + confirm_email check
//   2. cancel every active/trialing/past_due subscription for this user
//      immediately (not at period end — the account is going away). A
//      subscription Stripe says no longer exists counts as cancelled.
//   3. stamp public.users.deleted_at (tombstone; migration 021). Tolerates
//      the column not existing yet so the route works before 021 is applied.
//   3a. sweep tables that do NOT CASCADE from public.users. Today that is
//      public.chord_edits (migration 025 has no ON DELETE CASCADE on user_id —
//      the per-table header is explicit about the sweep being the audit
//      trail). Must run BEFORE step 4 or auth.admin.deleteUser fails on the
//      FK. Tolerates the table not existing yet (undefined_table / 42P01) so
//      the route still works on envs that haven't applied 025.
//   4. Supabase Admin auth.admin.deleteUser. The DB then cascades per the
//      TSD §2.3 DDL (public.users and everything FK'd to it). We delete NO
//      rows ourselves other than the step-3a sweep.
//   5. append a usage_events row kind='account_deleted'. user_id is NULL
//      (the FK is ON DELETE SET NULL and the user is gone); the detail holds
//      a SHA-256 of the user id, not the raw id or email, so the audit trail
//      carries no personal data. Failure here is logged, not surfaced — the
//      account is already gone.
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CANCELLABLE_STATUSES = ['active', 'trialing', 'past_due'];

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
  const user = await getUser();
  if (!user) return err(401, 'UNAUTHENTICATED', 'Sign in to delete your account.');

  // Destructive endpoint — require a same-origin browser request. DELETE verb
  // alone isn't a sufficient CSRF barrier (fetch can issue it cross-origin
  // when the server returns permissive CORS on a preflight), so we require
  // both an Origin header AND host-match. Missing Origin → 403 (fails closed;
  // non-browser clients that want to delete accounts must use the admin path).
  // Literal 'null' Origin (sandboxed iframe, data: URL) also rejected.
  const origin = req.headers?.get?.('origin');
  const host = req.headers?.get?.('host');
  if (!origin || origin === 'null' || !host) {
    return err(403, 'BAD_ORIGIN', 'Cross-origin or non-browser request refused.');
  }
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    return err(403, 'BAD_ORIGIN', 'Malformed Origin header.');
  }
  // Normalize both sides: strip default ports (:443 for https, :80 for http)
  // so a proxy that forwards `Host: x.com:443` doesn't 403 legitimate users.
  const normalize = (h: string) => h.replace(/:(443|80)$/, '');
  if (normalize(originHost) !== normalize(host)) {
    return err(403, 'BAD_ORIGIN', 'Cross-origin request refused.');
  }

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
    // 2. Cancel subscriptions.
    const provider = getBillingProvider();
    const subs = await db.query<{ provider_subscription_id: string }>(
      `SELECT provider_subscription_id FROM public.subscriptions
        WHERE user_id = $1::uuid AND provider = $2 AND status = ANY($3::text[])`,
      [user.user_id, provider.name, CANCELLABLE_STATUSES],
    );
    let cancelled = 0;
    for (const row of subs.rows) {
      try {
        await provider.cancelSubscription(row.provider_subscription_id, false);
        cancelled += 1;
      } catch (e) {
        if (isAlreadyCanceled(e)) continue;
        console.error('[users/me DELETE] subscription cancel failed:', e instanceof Error ? e.message : 'unknown');
        return err(502, 'SUBSCRIPTION_CANCEL_FAILED', 'We could not cancel your subscription, so your account was not deleted. Please try again.');
      }
    }

    // 3. Tombstone (best-effort if migration 021 is not applied yet).
    try {
      await db.query(`UPDATE public.users SET deleted_at = now() WHERE id = $1::uuid`, [user.user_id]);
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== '42703') throw e; // 42703 = undefined_column
    }

    // 3a. Sweep non-cascading training tables (chord_edits — migration 025).
    //     Must run BEFORE deleteAuthUser or the FK on public.chord_edits.user_id
    //     will refuse the public.users delete that Supabase cascades out of
    //     auth.users. Tolerates 42P01 (undefined_table) so pre-025 envs still
    //     delete cleanly. No other error class is swallowed — a failing sweep
    //     must surface so the admin delete does not then explode on FK.
    try {
      await db.query(`DELETE FROM public.chord_edits WHERE user_id = $1::uuid`, [user.user_id]);
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code !== '42P01') throw e; // 42P01 = undefined_table
    }

    // 4. Delete the auth user; the DB cascades the rest.
    await deleteAuthUser(user.user_id);

    // 5. Audit (no personal data).
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
