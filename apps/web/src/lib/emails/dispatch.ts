// Email dispatcher — V3 Phase 1a (TSD §M).
//
// Fans billing events out to the right template + sendEmail call. Every
// public function is best-effort: it logs + returns on failure and never
// throws, so the billing webhook response is never blocked by Resend's
// availability.
//
// Why this lives next to templates/: keeps the webhook route thin — the
// route describes WHEN we send, this file describes WHAT we send.

import { db } from '@/lib/db';
import type { PlanCode, SubscriptionStatus } from '@/lib/billing/types';
import { sendEmail } from './resend';
import { renderWelcome } from './templates/welcome';
import { renderSubscriptionChanged } from './templates/subscription-changed';
import { renderReceipt } from './templates/receipt';

/**
 * Look up the primary email for a user. Returns null if the row is missing
 * or the email is the derived `{uuid}@noemail.local` placeholder used by the
 * webhook's defensive upsert (sending to that domain would bounce).
 */
async function emailForUser(userId: string): Promise<string | null> {
  try {
    const res = await db.query<{ email: string | null }>(
      'SELECT email FROM users WHERE id = $1',
      [userId],
    );
    const email = res.rows[0]?.email ?? null;
    if (!email) return null;
    if (/@noemail\.local$/i.test(email)) return null;
    return email;
  } catch (err) {
    console.warn('[emails] emailForUser failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * True if the user has not previously received the welcome email. The
 * `welcomed_at` column lands in migration 019 — PR #38 Lens A flagged that
 * every subscription_upserted event was re-firing the welcome because the
 * column didn't exist yet. Now the common path is a PK read; the catch keeps
 * the pre-019 dev-DB bring-up working (returns true → send it), which
 * matches the prior best-effort contract per TSD §M.
 */
async function shouldSendWelcome(userId: string): Promise<boolean> {
  try {
    const res = await db.query<{ welcomed_at: Date | null }>(
      'SELECT welcomed_at FROM users WHERE id = $1',
      [userId],
    );
    if (res.rowCount === 0) return true;
    return !res.rows[0]?.welcomed_at;
  } catch {
    // Column likely absent (pre-019 DB) — degrade to "send it".
    return true;
  }
}

async function markWelcomed(userId: string): Promise<void> {
  try {
    await db.query('UPDATE users SET welcomed_at = now() WHERE id = $1', [userId]);
  } catch {
    // Column absent (pre-019 DB) / write refused; non-fatal.
  }
}

// ── Public dispatchers ──────────────────────────────────────────────────
//
// Idempotency-key shapes (PR #38 Lens A follow-up). Each key is derived from
// the ONE business id that truly identifies the send; no fetched state
// leaks in. Keys match the Resend 24h dedupe window — fine for the webhook
// retry path, long enough to cover Stripe's 72h retry (we also gate welcome
// on the users.welcomed_at column, so those don't rely on Resend alone).
//
//   welcome:<user_id>                                — once per user, ever.
//   sub-changed:<provider_subscription_id>:<status>  — dedupes a retried
//                                                       status event.
//   receipt-sub:<invoice_id>                         — one receipt per invoice.
//   receipt-credit:<provider_charge_id>              — one receipt per charge.

export async function sendWelcomeIfFirstTime(userId: string): Promise<void> {
  const to = await emailForUser(userId);
  if (!to) return;
  if (!(await shouldSendWelcome(userId))) return;
  const { subject, html } = renderWelcome();
  const res = await sendEmail({
    to,
    subject,
    html,
    tag: 'welcome',
    idempotencyKey: `welcome:${userId}`,
  });
  if (res.ok) await markWelcomed(userId);
}

export async function sendSubscriptionChanged(
  userId: string,
  vars: {
    plan_code: PlanCode;
    status: SubscriptionStatus;
    period_end: Date | string | null;
    /** Stripe subscription id — the stable natural key for dedupe. */
    provider_subscription_id: string;
  },
): Promise<void> {
  const to = await emailForUser(userId);
  if (!to) return;
  const { subject, html } = renderSubscriptionChanged(vars);
  await sendEmail({
    to,
    subject,
    html,
    tag: 'subscription-changed',
    idempotencyKey: `sub-changed:${vars.provider_subscription_id}:${vars.status}`,
  });
}

export async function sendReceipt(
  userId: string,
  vars: {
    amount_cad_cents: number;
    plan_or_pack_label: string;
    invoice_url: string | null;
    /**
     * Either a Stripe invoice id (subscription renewal path) or a charge /
     * payment-intent id (one-time credit purchase). The webhook knows which
     * one it has; this field is what drives the Resend dedupe key, so it
     * MUST be a real provider-side identifier (no random uuids).
     */
    receipt_source: { kind: 'subscription'; invoice_id: string }
                  | { kind: 'credit'; provider_charge_id: string };
  },
): Promise<void> {
  const to = await emailForUser(userId);
  if (!to) return;
  const { subject, html } = renderReceipt(vars);
  const key =
    vars.receipt_source.kind === 'subscription'
      ? `receipt-sub:${vars.receipt_source.invoice_id}`
      : `receipt-credit:${vars.receipt_source.provider_charge_id}`;
  await sendEmail({
    to,
    subject,
    html,
    tag: 'receipt',
    idempotencyKey: key,
  });
}
