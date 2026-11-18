// The app's own origin, for URLs we hand to a third party to send the user back to
// (Stripe Checkout success/cancel, Stripe billing-portal return). QA track B, B-07.
//
// It used to be `req.headers.get('origin') ?? 'https://stem-loops.com'`: any direct caller
// could choose where Stripe redirects a payer after payment. Now it comes from config only:
//   • APP_URL (server env), when it is a valid http(s) URL. Its ORIGIN is used (no path).
//     Staging and preview deployments that must return to themselves set this.
//   • otherwise DEFAULT_APP_URL, the production origin (pinned to lib/seo/site.ts SITE_URL
//     by test/app-url.test.mjs).
// An APP_URL that does not parse, or is not http(s), is IGNORED with one warning: a typo must
// not turn into a redirect to wherever the typo points. http is accepted only for localhost
// and 127.0.0.1 (local stacks); anything else must be https.
//
// Pure and import-free so route tests can load it through a data-URL transpile.

export const DEFAULT_APP_URL = 'https://stem-loops.com';

let warned = false;

export function appOrigin(): string {
  const raw = process.env.APP_URL;
  if (raw === undefined || raw.trim() === '') return DEFAULT_APP_URL;
  try {
    const u = new URL(raw.trim());
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return u.origin;
  } catch {
    // fall through to the warning
  }
  if (!warned) {
    warned = true;
    console.warn(`[app-url] APP_URL is not a usable https URL; using ${DEFAULT_APP_URL}.`);
  }
  return DEFAULT_APP_URL;
}
