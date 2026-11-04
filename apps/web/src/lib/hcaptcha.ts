// hCaptcha server-side verification — V3 Phase 1b (TSD §1.1, V3-C1).
//
// Pure helper: no `pg`, no `next` imports, so it can be unit tested with a
// stubbed global `fetch`. Fails CLOSED on every error path (missing secret,
// network failure, non-2xx, malformed JSON): a bot-challenge outage must not
// open the gate.

export const HCAPTCHA_VERIFY_URL = 'https://hcaptcha.com/siteverify';

export type HcaptchaResult = { success: boolean; errorCodes?: string[] };

export async function verifyHcaptchaToken(
  token: string,
  remoteip?: string,
): Promise<HcaptchaResult> {
  const secret = process.env.HCAPTCHA_SECRET_KEY;
  if (!secret) return { success: false, errorCodes: ['missing-secret-env'] };
  if (typeof token !== 'string' || token.length === 0) {
    return { success: false, errorCodes: ['missing-input-response'] };
  }

  const form = new URLSearchParams();
  form.set('secret', secret);
  form.set('response', token);
  if (remoteip) form.set('remoteip', remoteip);

  try {
    const res = await fetch(HCAPTCHA_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) return { success: false, errorCodes: [`http-${res.status}`] };
    const json = (await res.json()) as { success?: unknown; 'error-codes'?: unknown };
    if (json.success === true) return { success: true };
    const errorCodes = Array.isArray(json['error-codes'])
      ? (json['error-codes'] as unknown[]).filter((c): c is string => typeof c === 'string')
      : [];
    return { success: false, errorCodes };
  } catch {
    return { success: false, errorCodes: ['network-error'] };
  }
}
