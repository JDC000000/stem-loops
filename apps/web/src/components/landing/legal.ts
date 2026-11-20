// Public contact address for the legal pages (terms + privacy). Set by Jon 2026-10-10.
export const CONTACT_EMAIL = 'joncartwright00@gmail.com';
export const CONTACT_URL = `mailto:${CONTACT_EMAIL}`;
export const CONTACT_LABEL = CONTACT_EMAIL;
// "Last updated" on each legal page, kept SEPARATE so each date moves only when that page's text
// does (QA C-12 follow-up, 2026-11-18). Each must name the same day as the page's lastModified in
// lib/seo/pages.ts; the copy-truth surfaces test pins that. Flipping the DB-17 switch changes
// the text of BOTH pages, so bump both on flip day (its flip-day checklist says so too).
export const TERMS_UPDATED = '18 November 2026';
export const PRIVACY_UPDATED = '20 November 2026';
