// Email dispatcher — V3 Phase 1a (TSD §M), emails v1.2.
//
// Fans billing events out to the right template + sendEmail call. Every
// public function is best-effort: it logs + returns on failure and never
// throws, so the billing webhook response is never blocked by Resend's
// availability.
//
// Why this lives next to templates/: keeps the webhook route thin — the
// route describes WHEN we send, this file describes WHAT we send.

import { db } from '@/lib/db';
import type { PlanCode } from '@/lib/billing/types';
import { PAST_DUE_GRACE_MS } from '@/lib/billing/entitlements';
import { sendEmail } from './resend';
import { renderWelcome } from './templates/welcome';
import {
  renderSubscriptionChanged,
  type SubscriptionChangedStatus,
} from './templates/subscription-changed';
import { renderReceipt } from './templates/receipt';
import { renderPlanEnding } from './templates/plan-ending';
import { renderPlanEnded } from './templates/plan-ended';
import { renderPaymentFailed } from './templates/payment-failed';

/**
 * Look up the primary email for a user. Returns null if the row is missing,
 * the account is deleted or being deleted (E7: `deleted_at` is stamped before
 * the auth user goes, and a Stripe webhook can land in between), or the email
 * is the derived `{uuid}@noemail.local` placeholder used by the webhook's
 * defensive upsert (sending to that domain would bounce).
 */
async function emailForUser(userId: string): Promise<string | null> {
  try {
    const res = await db.query<{ email: string | null }>(
      'SELECT email FROM users WHERE id = $1 AND deleted_at IS NULL',
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

/** plans.monthly_job_quota for a plan code, or null (the copy then omits it). */
async function planQuota(code: string): Promise<number | null> {
  try {
    const res = await db.query<{ monthly_job_quota: number | string | null }>(
      'SELECT monthly_job_quota FROM plans WHERE code = $1',
      [code],
    );
    const n = Number(res.rows[0]?.monthly_job_quota);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
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
// Idempotency-key shapes (PR #38 Lens A follow-up; emails v1.2 §2.7). Each
// key is derived from the business ids that truly identify the send; no
// fetched state leaks in. Keys match the Resend 24h dedupe window — fine for
// the webhook retry path; welcome is also gated on users.welcomed_at.
//
//   welcome:<user_id>                                     R2, once per user, ever.
//   sub-changed:<provider_subscription_id>:<status>:<plan> R4; the plan is in
//                                                          the key so a Pro ->
//                                                          Studio switch is not
//                                                          deduped as "active".
//   plan-ending:<provider_subscription_id>:<period_end>   R5.
//   sub-changed:<provider_subscription_id>:canceled       R6 (shape unchanged).
//   payment-failed:<invoice_id>:<attempt_count>           R7, one per attempt.
//   receipt-sub:<invoice_id>                              R3, one per invoice.
//   receipt-credit:<provider_charge_id>                   R3, one per charge.

/**
 * R2. Sends the subscriber welcome once per user. Returns true only when the
 * welcome was sent by THIS call, so the webhook can skip R4 for the same event.
 * The webhook calls it only for an `active` or `trialing` subscription (E3).
 */
export async function sendWelcomeIfFirstTime(
  userId: string,
  vars: { plan_code?: PlanCode | null; period_end?: Date | string | null } = {},
): Promise<boolean> {
  const to = await emailForUser(userId);
  if (!to) return false;
  if (!(await shouldSendWelcome(userId))) return false;
  const monthly_job_quota = vars.plan_code ? await planQuota(vars.plan_code) : null;
  const { subject, html, text } = renderWelcome({
    plan_code: vars.plan_code ?? null,
    period_end: vars.period_end ?? null,
    monthly_job_quota,
  });
  const res = await sendEmail({
    to,
    subject,
    html,
    text,
    tag: 'welcome',
    idempotencyKey: `welcome:${userId}`,
  });
  if (res.ok) await markWelcomed(userId);
  return res.ok;
}

/** R4. The webhook picks the case; see the subscription_upserted branch. */
export async function sendSubscriptionChanged(
  userId: string,
  vars: {
    plan_code: PlanCode;
    status: SubscriptionChangedStatus;
    period_end: Date | string | null;
    /** Stripe subscription id — the stable natural key for dedupe. */
    provider_subscription_id: string;
    previous_plan_code?: PlanCode | null;
    resumed?: boolean;
  },
): Promise<void> {
  const to = await emailForUser(userId);
  if (!to) return;
  const monthly_job_quota = await planQuota(vars.plan_code);
  const { subject, html, text } = renderSubscriptionChanged({
    plan_code: vars.plan_code,
    status: vars.status,
    period_end: vars.period_end,
    previous_plan_code: vars.previous_plan_code ?? null,
    resumed: vars.resumed ?? false,
    monthly_job_quota,
  });
  await sendEmail({
    to,
    subject,
    html,
    text,
    tag: 'subscription-changed',
    idempotencyKey: `sub-changed:${vars.provider_subscription_id}:${vars.status}:${vars.plan_code}`,
  });
}

/** R5. cancel_at_period_end turned true: the plan ends at period_end. */
export async function sendPlanEnding(
  userId: string,
  vars: {
    plan_code: PlanCode;
    period_end: Date | string | null;
    provider_subscription_id: string;
  },
): Promise<void> {
  const to = await emailForUser(userId);
  if (!to) return;
  const { subject, html, text } = renderPlanEnding({
    plan_code: vars.plan_code,
    period_end: vars.period_end,
  });
  const end = vars.period_end ? new Date(vars.period_end) : null;
  const endKey = end && !Number.isNaN(end.getTime()) ? end.toISOString() : 'none';
  await sendEmail({
    to,
    subject,
    html,
    text,
    tag: 'plan-ending',
    idempotencyKey: `plan-ending:${vars.provider_subscription_id}:${endKey}`,
  });
}

/** R6. The subscription has ended (customer.subscription.deleted). */
export async function sendPlanEnded(
  userId: string,
  vars: {
    plan_code: PlanCode;
    period_end: Date | string | null;
    provider_subscription_id: string;
    /** False when another subscription still entitles the user. */
    on_free: boolean;
    now?: Date;
  },
): Promise<void> {
  const to = await emailForUser(userId);
  if (!to) return;
  const free_quota = vars.on_free ? await planQuota('free') : null;
  const { subject, html, text } = renderPlanEnded({
    plan_code: vars.plan_code,
    period_end: vars.period_end,
    now: vars.now ?? new Date(),
    on_free: vars.on_free,
    free_quota,
  });
  await sendEmail({
    to,
    subject,
    html,
    text,
    tag: 'subscription-changed',
    idempotencyKey: `sub-changed:${vars.provider_subscription_id}:canceled`,
  });
}

/** R7. A renewal (or mid-period plan change) charge failed. */
export async function sendPaymentFailed(
  userId: string,
  vars: {
    plan_code: PlanCode;
    /** Start of the period the failed invoice is for. */
    period_start: Date | string;
    next_attempt: Date | string | null;
    provider_invoice_id: string;
    attempt_count: number;
    now?: Date;
  },
): Promise<void> {
  const start = new Date(vars.period_start);
  if (Number.isNaN(start.getTime())) {
    console.warn(`[emails] payment-failed skipped: no period start for ${vars.provider_invoice_id}`);
    return;
  }
  const to = await emailForUser(userId);
  if (!to) return;
  const { subject, html, text } = renderPaymentFailed({
    plan_code: vars.plan_code,
    grace_end: new Date(start.getTime() + PAST_DUE_GRACE_MS),
    now: vars.now ?? new Date(),
    next_attempt: vars.next_attempt,
  });
  await sendEmail({
    to,
    subject,
    html,
    text,
    tag: 'payment-failed',
    idempotencyKey: `payment-failed:${vars.provider_invoice_id}:${vars.attempt_count}`,
  });
}

/** R3. */
export async function sendReceipt(
  userId: string,
  vars: {
    amount_cad_cents: number;
    plan_or_pack_label: string;
    invoice_url: string | null;
    paid_on?: Date | string | null;
    /**
     * Either a Stripe invoice id (subscription path) or a charge /
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
  const { subject, html, text } = renderReceipt({
    amount_cad_cents: vars.amount_cad_cents,
    plan_or_pack_label: vars.plan_or_pack_label,
    invoice_url: vars.invoice_url,
    paid_on: vars.paid_on ?? null,
    kind: vars.receipt_source.kind === 'credit' ? 'credit_pack' : 'subscription',
  });
  const key =
    vars.receipt_source.kind === 'subscription'
      ? `receipt-sub:${vars.receipt_source.invoice_id}`
      : `receipt-credit:${vars.receipt_source.provider_charge_id}`;
  await sendEmail({
    to,
    subject,
    html,
    text,
    tag: 'receipt',
    idempotencyKey: key,
  });
}
