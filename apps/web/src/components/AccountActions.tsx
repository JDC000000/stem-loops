'use client';

// /account: "Send feedback" and "Sign out" (beta QA 2026-11-26, S4 / G5 and S5).
//
// WHERE: on /account, which the top bar's Account item reaches in one tap on a phone and on a
// desktop. Not as new items in the bar itself: A4 (Jon, 2026-11-21) fixed the phone bar at three
// items with no menu, and test/signed-in-nav.test.mjs pins it. /account is signed-in only (it
// redirects to /login), so both actions are signed-in only.
//
// SIGN OUT is a plain form POST to /api/auth/signout (same-origin guarded, answers 303 → /), so
// it works before hydration and without JavaScript. With JavaScript, the submit handler first
// drops what this browser holds for the user who is leaving: buffered player edits and a link
// saved for a sign-in round trip, as DeleteAccountForm does (security audit §3 M3), so the next
// person to sign in on a shared machine cannot flush or inherit them. It also drops this browser's
// song history (lib/history.ts, #486); the route clears its httpOnly `sl-history` cookie mirror.
// It never cancels the submit.
//
// SEND FEEDBACK is a mailto with a fixed subject (components/landing/legal.ts). No backend.
//
// PHONE: the row wraps (flex-wrap) and every control is >= 44x44 (--h-control), so nothing
// overflows at 320px. test/account-actions.test.mjs reads both off the rendered markup.
import type { CSSProperties } from 'react';
import { clearBufferedEdits } from '@/chord/edit-collector';
import { clearPendingLink } from '@/lib/pending-link';
import { clearHistory } from '@/lib/history';
import { FEEDBACK_URL } from '@/components/landing/legal';
import { buttonBase, secondaryButton } from '@/lib/ui/form-styles';

const row: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 12,
  marginTop: 16,
};

const link: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 'var(--h-control)',
  minWidth: 'var(--h-control)',
  color: 'var(--text-primary)',
  fontSize: 14,
};

const signOutButton: CSSProperties = {
  ...buttonBase,
  ...secondaryButton,
  width: 'auto',
  minWidth: 'var(--h-control)',
  fontSize: 14,
};

export function forgetLocalUserState(): void {
  try {
    clearBufferedEdits();
  } catch {
    /* best-effort */
  }
  try {
    clearPendingLink(window.localStorage);
  } catch {
    /* blocked storage holds nothing */
  }
  try {
    clearHistory();
  } catch {
    /* blocked storage holds nothing */
  }
}

export default function AccountActions() {
  return (
    <section aria-label="Feedback and sign out" style={row} data-testid="account-actions">
      <a href={FEEDBACK_URL} style={link}>Send feedback</a>
      <form method="post" action="/api/auth/signout" onSubmit={forgetLocalUserState} style={{ margin: 0 }}>
        <button type="submit" style={signOutButton}>Sign out</button>
      </form>
    </section>
  );
}
