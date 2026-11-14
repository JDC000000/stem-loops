// Shared helpers for plain-HTML email templates (V3 Phase 1a).
//
// No React Email. Each template is a function returning {subject, html}.
// Variables are HTML-escaped before interpolation — never trust pass-through.

export interface RenderedEmail {
  subject: string;
  html: string;
}

export function escapeHtml(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Minimal URL guard. Rejects anything that isn't https/http/mailto so a
 * poisoned provider field can't inject `javascript:` into an <a href="">.
 * Falls back to '#' (template still renders deterministically).
 */
export function safeUrl(url: string | null | undefined): string {
  if (!url) return '#';
  const trimmed = String(url).trim();
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed;
  return '#';
}

/** Format integer cents as "$X.YY CAD". */
export function formatCadCents(amountCents: number): string {
  const safe = Number.isFinite(amountCents) ? Math.round(amountCents) : 0;
  const dollars = (safe / 100).toFixed(2);
  return `$${dollars} CAD`;
}

/** Format a Date or ISO string as YYYY-MM-DD in UTC. Deterministic. */
export function formatDateUtc(input: Date | string | null | undefined): string {
  if (!input) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** Wrap body HTML in a plain, light shell. Readable in both themes. The wordmark is all
 *  #0d0d0d on light backgrounds: lime on white is 1.51:1, so the dash is dropped, never
 *  darkened (brand book v2.2 §2, A7). */
export function shell(bodyHtml: string, preheader?: string): string {
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</div>`
    : '';
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
  </head>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;">
    ${pre}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:28px;max-width:560px;">
            <tr><td>
              <div style="font-size:14px;font-weight:700;color:#0d0d0d;margin-bottom:16px;">stem-loops</div>
              ${bodyHtml}
              <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
              <div style="font-size:12px;color:#888;">
                stem-loops &mdash; <a href="https://stem-loops.com" style="color:#555;">stem-loops.com</a>
              </div>
            </td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
