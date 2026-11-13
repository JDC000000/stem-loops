// Receipt email — V3-M3 (TSD §M).
// Triggered on:
//   - checkout.session.completed (mode=payment)   — one-time credit pack
//   - invoice.paid                                — subscription renewal
//
// The hosted Stripe invoice URL is the authoritative receipt for tax; this
// email is a convenience nudge pointing at it.

import {
  escapeHtml,
  formatCadCents,
  safeUrl,
  shell,
  type RenderedEmail,
} from './shared';

export interface ReceiptVars {
  amount_cad_cents: number;
  plan_or_pack_label: string;
  invoice_url: string | null;
  siteBase?: string;
}

export function renderReceipt(vars: ReceiptVars): RenderedEmail {
  const base = (vars.siteBase ?? 'https://stem-loops.com').replace(/\/+$/, '');
  const amount = formatCadCents(vars.amount_cad_cents);
  const label = vars.plan_or_pack_label;
  const invoiceUrl = safeUrl(vars.invoice_url);

  // PR #38 Lens B: safeUrl() rejects non-http(s) schemes, but a URL still
  // allowed by safeUrl can contain a `"` and break out of the href attribute
  // once interpolated. Attribute-escape the URL (and the /account base URL)
  // before use. escapeHtml covers &<>"'; that is sufficient for an HTML
  // double-quoted attribute value.
  const invoiceHref = escapeHtml(invoiceUrl);
  const accountHref = escapeHtml(`${base}/account`);

  const subject = `Receipt from stem-loops — ${amount}`;
  const html = shell(
    `
      <h1 style="font-size:20px;margin:0 0 12px;">Thanks for your payment</h1>
      <p style="font-size:15px;line-height:1.5;margin:0 0 16px;">
        Here's the summary.${invoiceUrl !== '#' ? ' Your invoice is on the Stripe page linked below.' : ''}
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0"
             style="font-size:14px;margin:0 0 20px;border-collapse:collapse;">
        <tr>
          <td style="color:#666;padding:4px 16px 4px 0;">Item</td>
          <td style="padding:4px 0;"><strong>${escapeHtml(label)}</strong></td>
        </tr>
        <tr>
          <td style="color:#666;padding:4px 16px 4px 0;">Amount</td>
          <td style="padding:4px 0;"><strong>${escapeHtml(amount)}</strong></td>
        </tr>
      </table>
      ${
        invoiceUrl !== '#'
          ? `<p style="margin:0 0 24px;">
          <a href="${invoiceHref}"
             style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;margin-right:8px;">
            View invoice
          </a>
          <a href="${accountHref}"
             style="display:inline-block;background:#f0f0f0;color:#111;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;">
            Go to your account
          </a>
        </p>`
          : `<p style="margin:0 0 24px;">
          <a href="${accountHref}"
             style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;">
            Go to your account
          </a>
        </p>`
      }
      <p style="font-size:13px;color:#777;line-height:1.5;margin:0;">
        Keep this email for your records. Reply with any questions.
      </p>
    `,
    `Receipt for ${label} — ${amount}`,
  );
  return { subject, html };
}
