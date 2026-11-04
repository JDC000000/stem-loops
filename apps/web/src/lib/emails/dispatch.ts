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
 * True if the user has not previously received the welcome email. We track
 * this using a flag column on `users`; if the column is absent (test or
 * pre-migration environment) we fall back to a conservative "yes, send it"
 * — the welcome email is idempotent-safe on the recipient's side, and
 * Resend deduplicates identical sends over short windows via its own
 * suppression list.
 *
 * Phase 1a note: we do NOT create the column in this PR to keep migrations
 * out of an email-only patch. Until it exists, every checkout.session.
 * completed (mode=subscription) sends a welcome. That is explicitly
 * acceptable per TSD §M (best-effort, worst case = one extra email).
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
    // Column likely absent — degrade to "send it".
    return true;
  }
}

async function markWelcomed(userId: string): Promise<void> {
  try {
    await db.query('UPDATE users SET welcomed_at = now() WHERE id = $1', [userId]);
  } catch {
    // Column absent / write refused; non-fatal.
  }
}

// ── Public dispatchers ──────────────────────────────────────────────────

export async function sendWelcomeIfFirstTime(userId: string): Promise<void> {
  const to = await emailForUser(userId);
  if (!to) return;
  if (!(await shouldSendWelcome(userId))) return;
  const { subject, html } = renderWelcome();
  const res = await sendEmail({ to, subject, html, tag: 'welcome' });
  if (res.ok) await markWelcomed(userId);
}

export async function sendSubscriptionChanged(
  userId: string,
  vars: { plan_code: PlanCode; status: SubscriptionStatus; period_end: Date | string | null },
): Promise<void> {
  const to = await emailForUser(userId);
  if (!to) return;
  const { subject, html } = renderSubscriptionChanged(vars);
  await sendEmail({ to, subject, html, tag: 'subscription-changed' });
}

export async function sendReceipt(
  userId: string,
  vars: { amount_cad_cents: number; plan_or_pack_label: string; invoice_url: string | null },
): Promise<void> {
  const to = await emailForUser(userId);
  if (!to) return;
  const { subject, html } = renderReceipt(vars);
  await sendEmail({ to, subject, html, tag: 'receipt' });
}
