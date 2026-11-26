// Public contact address for the legal pages (terms + privacy). Set by Jon 2026-10-10.
export const CONTACT_EMAIL = 'joncartwright00@gmail.com';
export const CONTACT_URL = `mailto:${CONTACT_EMAIL}`;
export const CONTACT_LABEL = CONTACT_EMAIL;
// "Last updated" on each legal page, kept SEPARATE so each date moves only when that page's text
// does (QA C-12 follow-up, 2026-11-18). ISO days: lib/seo/pages.ts builds each page's lastModified
// from the same constant, and the copy-truth surfaces test pins that the two agree.
//
// The DB-17 chord switch (lib/chords-claim.ts) changes the text of BOTH pages without a code
// change, so the SHOWN day is the later of the constant and CHORDS_CLAIMS_CHANGED_ON (legalUpdated).
// No imports beyond that relative one, so lib/seo (loaded directly by node in tests) can read this.
import { legalUpdated } from '../../lib/chords-claim.ts';

export const TERMS_UPDATED_ON = '2026-11-25';
export const PRIVACY_UPDATED_ON = '2026-11-25';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** '2026-11-21' -> '21 November 2026'. */
export function formatDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The day each page shows and lists as lastModified (YYYY-MM-DD). */
export const termsUpdatedOn = (): string => legalUpdated(TERMS_UPDATED_ON);
export const privacyUpdatedOn = (): string => legalUpdated(PRIVACY_UPDATED_ON);
