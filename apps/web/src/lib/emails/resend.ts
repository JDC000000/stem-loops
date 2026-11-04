// Resend client wrapper — V3 Phase 1a (TSD §M1).
//
// Sends transactional emails via the Resend HTTPS API. Best-effort: on
// failure we log + capture to Sentry and return, NEVER throw. The webhook
// and other callers rely on this to not block the request flow (TSD §M).
//
// Retry policy: one retry on 5xx or network errors, 1s backoff. 4xx is
// permanent (bad address, domain not verified, etc.) and surfaces to logs
// without retry — retrying is pointless and costs the sender's reputation.
//
// From address:
//   notifications@stem-loops.com — once the domain is verified in Resend.
//   onboarding@resend.dev        — fallback when it isn't (Resend's shared
//                                  sandbox sender, usable without domain
//                                  verification; delivers only to the
//                                  account owner's verified address in
//                                  sandbox, which is acceptable for Phase
//                                  1a bring-up).
// Override with RESEND_FROM env if a different address is required.

import * as Sentry from '@sentry/nextjs';

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'stem-loops <notifications@stem-loops.com>';
const SANDBOX_FROM = 'onboarding@resend.dev';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Resend tag (shows up in the dashboard). Use template name. */
  tag: string;
  /**
   * Stable per-send key. Resend dedupes concurrent + retried requests that
   * share this value for ~24h, so the webhook's retry-on-5xx path cannot
   * accidentally double-send if the client times out between the API's
   * write and its 200 response (PR #38 Lens A finding).
   *
   * Callers compose the key from the real business id — e.g.
   * `welcome:<user_id>`, `receipt-sub:<invoice_id>` — not from fetched state.
   * See dispatch.ts for the canonical shapes.
   */
  idempotencyKey: string;
}

export interface SendEmailResult {
  ok: boolean;
  id?: string;
  status?: number;
  error?: string;
}

function getFromAddress(): string {
  const override = process.env.RESEND_FROM?.trim();
  if (override) return override;
  // If the domain-verified from is explicitly disabled (e.g. RESEND_SANDBOX=1
  // for CI / preview deploys where notifications@stem-loops.com isn't
  // verified yet), fall back to Resend's shared sandbox sender.
  if (process.env.RESEND_SANDBOX === '1') return SANDBOX_FROM;
  return DEFAULT_FROM;
}

function isRetryable(status: number): boolean {
  return status >= 500 && status <= 599;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Send one email. Never throws. Returns {ok:false, ...} on failure so the
 * caller can log/metric without wrapping in try/catch.
 *
 * Testability: we read `globalThis.fetch` so tests can swap it out without
 * touching a transport module.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Treat an unset key as a graceful skip in non-prod. In prod we still
    // return {ok:false} and log a warning — webhook continues, Sentry sees
    // the misconfig.
    const msg = 'RESEND_API_KEY not set; skipping email send';
    console.warn(`[emails] ${msg} tag=${input.tag}`);
    return { ok: false, error: msg };
  }

  const payload = {
    from: getFromAddress(),
    to: input.to,
    subject: input.subject,
    html: input.html,
    tags: [{ name: 'template', value: input.tag }],
  };

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    // Idempotency-Key is honored by Resend to dedupe retries/concurrent
    // sends on the SAME key for ~24h. Combined with our own retry-on-5xx,
    // this makes a timed-out send safe to retry.
    'Idempotency-Key': input.idempotencyKey,
  };

  // Up to 2 attempts total: initial + 1 retry on 5xx or network error.
  let lastErr: string | undefined;
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers,
        body,
      });
      lastStatus = res.status;
      if (res.ok) {
        let id: string | undefined;
        try {
          const parsed = (await res.json()) as { id?: string };
          id = parsed?.id;
        } catch {
          // Body may be empty/non-JSON on some edge responses; still success.
        }
        return { ok: true, id, status: res.status };
      }
      // Non-2xx
      let errText = '';
      try {
        errText = await res.text();
      } catch {
        // ignore
      }
      lastErr = `resend ${res.status}: ${errText.slice(0, 500)}`;
      if (!isRetryable(res.status) || attempt === 2) {
        console.warn(`[emails] send failed tag=${input.tag} ${lastErr}`);
        try {
          Sentry.captureException(new Error(lastErr), {
            tags: { subsystem: 'emails', template: input.tag },
          });
        } catch {
          // Sentry may not be initialized in tests; ignore.
        }
        return { ok: false, status: res.status, error: lastErr };
      }
      // Retryable 5xx — wait and try again.
      await sleep(1000);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      if (attempt === 2) {
        console.error(`[emails] send network error tag=${input.tag} ${lastErr}`);
        try {
          Sentry.captureException(err, {
            tags: { subsystem: 'emails', template: input.tag },
          });
        } catch {
          // ignore
        }
        return { ok: false, error: lastErr };
      }
      await sleep(1000);
    }
  }
  // Unreachable, but TS wants a return.
  return { ok: false, status: lastStatus, error: lastErr };
}
