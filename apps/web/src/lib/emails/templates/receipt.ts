// R3 — Receipt (emails v1.2 §3 R3; service email).
// Triggered on:
//   - checkout.session.completed (mode=payment)   — one-time credit pack
//   - invoice.paid                                — subscription invoice
//
// The hosted Stripe invoice URL is the authoritative receipt for tax; this
// email is a record pointing at it. One button: "View invoice" when there is
// an invoice URL, otherwise "Go to your account". No pack prices, no
// "buy more" line (§2.8).

import {
  detailRows,
  detailText,
  footerFor,
  formatCadCents,
  formatDateUtc,
  h1,
  link,
  p,
  pHtml,
  plainText,
  safeUrl,
  shell,
  siteBaseOf,
  type DetailRow,
  type RenderedEmail,
} from './shared';

export interface ReceiptVars {
  amount_cad_cents: number;
  plan_or_pack_label: string;
  invoice_url: string | null;
  /** What was bought. The credits sentence is shown only for a credit pack. */
  kind?: 'credit_pack' | 'subscription';
  /** When the payment was made; rendered as an ISO date row when set. */
  paid_on?: Date | string | null;
  siteBase?: string;
}

export function renderReceipt(vars: ReceiptVars): RenderedEmail {
  const base = siteBaseOf(vars.siteBase);
  const amount = formatCadCents(vars.amount_cad_cents);
  const label = vars.plan_or_pack_label;
  const invoiceUrl = safeUrl(vars.invoice_url);
  const hasInvoice = invoiceUrl !== '#';
  const accountUrl = `${base}/account`;

  const subject = `Receipt from stem-loops — ${amount}`;
  const preheader = `Receipt for ${label} — ${amount}`;
  const lead = 'We received your payment. Here is the summary.';

  const rows: DetailRow[] = [
    { label: 'Item', value: label },
    { label: 'Amount', value: amount },
  ];
  const paidOn = formatDateUtc(vars.paid_on);
  if (paidOn) rows.push({ label: 'Date', value: paidOn });

  let note = '';
  if (vars.kind === 'credit_pack') {
    note = 'Credits never expire. Each one covers one uploaded track on the Free plan.';
  } else if (hasInvoice) {
    note = 'Your invoice is on the Stripe page linked below.';
  }

  const cta = hasInvoice
    ? { label: 'View invoice', url: invoiceUrl }
    : { label: 'Go to your account', url: accountUrl };
  const footer = footerFor('records');

  const bodyParts = [h1('Thanks for your payment'), p(lead), detailRows(rows)];
  if (note) bodyParts.push(p(note));
  if (hasInvoice) {
    // Secondary destination is an underlined link, never a second button.
    bodyParts.push(pHtml(`Your plan and credits are on your ${link(accountUrl, 'account page')}.`));
  }
  const html = shell({ subject, preheader, bodyHtml: bodyParts.join('\n'), cta, footer, siteBase: base });

  const paragraphs = [lead, detailText(rows), note];
  if (hasInvoice) paragraphs.push(`Your account: ${accountUrl}`);
  const text = plainText({ paragraphs, cta, footer });
  return { subject, html, text };
}
