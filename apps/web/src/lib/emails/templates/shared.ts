// Shared helpers for the plain-HTML email templates (emails v1.2 §2).
//
// No React Email. Each template is a function returning {subject, html, text}.
// Variables are HTML-escaped before interpolation; never trust pass-through.
//
// The shell is the dark one from emails v1.2 §2.4 (page #0d0d0d, card #161616,
// body #e0e0e0, labels and footer #999999). Lime (#a3e635) appears in exactly
// one place: the single CTA button (brand book A7). The wordmark is one colour
// with no lime dash, so a client that forces a light theme inverts it to an
// all-dark wordmark rather than leaving a lime dash on white (A7).

import type { PlanCode } from '@/lib/billing/types';

export interface RenderedEmail {
  subject: string;
  html: string;
  /** Plain-text part (emails v1.2 §2.5, E9). Every renderer returns one. */
  text: string;
}

export const DEFAULT_SITE_BASE = 'https://stem-loops.com';

/** Brand colours used by the shell (emails v1.2 §2.3). */
export const EMAIL_COLOURS = {
  page: '#0d0d0d',
  card: '#161616',
  border: '#2a2a2a',
  headline: '#ffffff',
  body: '#e0e0e0',
  muted: '#999999',
  lime: '#a3e635',
  onLime: '#0d0d0d',
} as const;

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

/** safeUrl, then attribute-escaped: the only way a URL reaches an href. */
export function hrefFor(url: string | null | undefined): string {
  return escapeHtml(safeUrl(url));
}

/** Trim trailing slashes off the site base; default stem-loops.com. */
export function siteBaseOf(siteBase?: string): string {
  return (siteBase ?? DEFAULT_SITE_BASE).replace(/\/+$/, '');
}

/** Format integer cents as "$X.YY CAD". */
export function formatCadCents(amountCents: number): string {
  const safe = Number.isFinite(amountCents) ? Math.round(amountCents) : 0;
  const dollars = (safe / 100).toFixed(2);
  return `$${dollars} CAD`;
}

function toDate(input: Date | string | null | undefined): Date | null {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Format a Date or ISO string as YYYY-MM-DD in UTC. Deterministic. */
export function formatDateUtc(input: Date | string | null | undefined): string {
  const d = toDate(input);
  return d ? d.toISOString().slice(0, 10) : '';
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Format a date for prose: "15 January 2027", UTC, no leading zero. */
export function formatDateProse(input: Date | string | null | undefined): string {
  const d = toDate(input);
  if (!d) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Human plan name: Free, Pro, Studio. */
export function planLabel(code: PlanCode | string): string {
  switch (code) {
    case 'pro':
      return 'Pro';
    case 'studio':
      return 'Studio';
    case 'free':
      return 'Free';
    default:
      return String(code);
  }
}

// ── Footer (emails v1.2 §2.6) ──────────────────────────────────────────

/**
 * Which "why" line the footer carries.
 *   service  — "You got this email because you have a stem-loops account."
 *   records  — receipts: "Keep this email for your records."
 * Lifecycle footers (unsubscribe + postal sender line, D1) are not built yet.
 */
export type FooterKind = 'service' | 'records';

export const WHY_LINE: Record<FooterKind, string> = {
  service: 'You got this email because you have a stem-loops account.',
  records: 'Keep this email for your records.',
};

export const REPLY_LINE = 'Reply if something doesn’t work. A person reads it.';

/**
 * Footer lines for an email. The reply line is rendered only when
 * EMAIL_REPLY_TO is set and non-blank: the same test resend.ts uses to decide
 * whether a reply_to goes out at all (E10).
 */
export function footerFor(
  kind: FooterKind,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const lines = [WHY_LINE[kind]];
  if (env.EMAIL_REPLY_TO?.trim()) lines.push(REPLY_LINE);
  return lines;
}

// ── Body building blocks (emails v1.2 §2.4) ─────────────────────────────

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
const MONO = "'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace";

export function h1(text: string): string {
  return `<h1 style="margin:0 0 12px;font-size:24px;line-height:1.3;font-weight:600;color:${EMAIL_COLOURS.headline};">${escapeHtml(text)}</h1>`;
}

/** A paragraph. `html` must already be escaped (use p() for plain text). */
export function pHtml(html: string): string {
  return `<p style="margin:0 0 16px;">${html}</p>`;
}

export function p(text: string): string {
  return pHtml(escapeHtml(text));
}

/** Underlined body-colour link; never a second button. */
export function link(url: string, label: string): string {
  return `<a href="${hrefFor(url)}" style="color:${EMAIL_COLOURS.body};text-decoration:underline;">${escapeHtml(label)}</a>`;
}

export interface DetailRow {
  label: string;
  value: string;
}

export function detailRows(rows: DetailRow[]): string {
  if (!rows.length) return '';
  const trs = rows
    .map(
      (r) =>
        `<tr><td style="padding:4px 16px 4px 0;color:${EMAIL_COLOURS.muted};font-size:14px;">${escapeHtml(r.label)}</td>` +
        `<td style="padding:4px 0;color:${EMAIL_COLOURS.headline};font-size:14px;font-family:${MONO};">${escapeHtml(r.value)}</td></tr>`,
    )
    .join('\n');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:collapse;">\n${trs}\n</table>`;
}

export interface Cta {
  label: string;
  url: string;
}

/** The one lime element. 12 + 20 + 12 = 44px tall; padding on the <td>. */
export function ctaButton(cta: Cta): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
  <tr><td bgcolor="${EMAIL_COLOURS.lime}" style="background:${EMAIL_COLOURS.lime};border-radius:4px;padding:12px 20px;">
    <a href="${hrefFor(cta.url)}" style="display:inline-block;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:${EMAIL_COLOURS.onLime};text-decoration:none;">${escapeHtml(cta.label)}</a>
  </td></tr>
</table>`;
}

// ── Shell ───────────────────────────────────────────────────────────────

export interface ShellInput {
  subject: string;
  preheader: string;
  /** Body HTML, already escaped (built from the helpers above). */
  bodyHtml: string;
  cta: Cta;
  footer: string[];
  siteBase?: string;
}

/** Wrap a body in the dark shell from emails v1.2 §2.4. */
export function shell(input: ShellInput): string {
  const base = siteBaseOf(input.siteBase);
  const footerHtml = input.footer.map(escapeHtml).join('<br>\n          ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${escapeHtml(input.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${EMAIL_COLOURS.page};" bgcolor="${EMAIL_COLOURS.page}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${EMAIL_COLOURS.page}" style="background:${EMAIL_COLOURS.page};">
  <tr><td align="center" style="padding:24px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${EMAIL_COLOURS.card}"
           style="max-width:560px;background:${EMAIL_COLOURS.card};border:1px solid ${EMAIL_COLOURS.border};border-radius:6px;">
      <tr><td style="padding:28px 24px;font-family:${FONT};font-size:16px;line-height:1.6;color:${EMAIL_COLOURS.body};">
        <p class="wordmark" style="margin:0 0 24px;font-size:14px;font-weight:600;color:${EMAIL_COLOURS.headline};">stem-loops</p>
        ${input.bodyHtml}
        ${ctaButton(input.cta)}
        <hr style="border:none;border-top:1px solid ${EMAIL_COLOURS.border};margin:28px 0 16px;">
        <p style="margin:0;font-size:13px;line-height:1.5;color:${EMAIL_COLOURS.muted};">
          ${footerHtml}<br>
          <a href="${hrefFor(base)}" style="color:${EMAIL_COLOURS.muted};text-decoration:underline;">stem-loops.com</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

export interface PlainTextInput {
  /** Body paragraphs and detail lines, in order. Empty entries are dropped. */
  paragraphs: string[];
  cta: Cta;
  footer: string[];
}

/**
 * Plain-text part (emails v1.2 §2.5): the wordmark line, the body,
 * "<CTA label>: <url>", then "—" and the footer lines, then stem-loops.com.
 */
export function plainText(input: PlainTextInput): string {
  const blocks = ['stem-loops', ...input.paragraphs.filter((s) => s.trim() !== '')];
  blocks.push(`${input.cta.label}: ${safeUrl(input.cta.url)}`);
  return `${blocks.join('\n\n')}\n\n—\n${[...input.footer, 'stem-loops.com'].join('\n')}\n`;
}

/** Detail rows as plain-text lines ("Label: value"), one block. */
export function detailText(rows: DetailRow[]): string {
  return rows.map((r) => `${r.label}: ${r.value}`).join('\n');
}
