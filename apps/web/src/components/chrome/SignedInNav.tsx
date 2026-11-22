'use client';

// THE ONE TOP NAV — every page, signed in or out (2026-11-15, Jon: "Download
// loops is a separate product in the top nav on every page, including the
// landing page"). Two products side by side — Play along · Download loops —
// then Song library ("Job history" until Slice 2a, "Library" until #316), Pricing and Account / Sign in. The current product is marked
// (aria-current + the #275 edge-and-weight cue) and named by a tag beside the
// wordmark (on a phone the bar shows three items, see PHONES below).
// Moises-style separation: products are peers in the bar, each with its own
// page, and the marketing page of one product does not sell the other.
//
// The file keeps its old name so the eight signed-in layouts and their gates
// (test/signed-in-nav.test.mjs) are untouched; SiteHeader
// (components/landing/SiteChrome.tsx) now renders this same component on the
// landing, /terms, /privacy and the 404.
//
// SESSION. Two callers, two ways of knowing it:
//   * signed-in subtrees: SignedInChrome awaits `getUser()` on the server and
//     passes a boolean. That is the authoritative read.
//   * the marketing pages are STATICALLY rendered (prerendered, cached at the
//     edge — the landing is the page most crawled and most shared), so they
//     cannot read the session on the server without becoming dynamic on every
//     hit. They pass `signedIn={null}`: the bar renders "Sign in", and after
//     mount swaps it for "Account" if the browser holds a Supabase session
//     cookie. That is a LABEL hint, not an auth decision: nothing is unlocked
//     by it, /account still checks `getUser()` and sends a stale cookie to
//     sign-in, and no request is made (no /api/auth/me hit per landing view).
//     This file still imports nothing from @/lib/auth.
//
// PHONES: THREE ITEMS, NO MENU (A4, 2026-11-21; Jon's J1/J8 story). Below 760px the bar shows
// Play · Songs · Account (Sign in when signed out) inline, so the Song library is one tap from
// any page. Download loops and Pricing are not in the phone bar: they are on /account and in the
// footer (components/landing/SiteChrome.tsx). Desktop keeps all five, with their full labels.
// The old hamburger menu is gone: three items fit the bar, and a menu was an extra tap.
//
// WHY A CLIENT COMPONENT: marking the current page needs the pathname, and the Account/Sign in
// label hint reads the cookie after mount; both are view concerns.
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isSongLibraryPath } from '@/lib/nav-current';

export type SignedInNavProps = {
  /**
   * Server-resolved on signed-in subtrees: Account (true) vs Sign in (false).
   * `null` on the statically rendered marketing pages: see the header.
   */
  signedIn: boolean | null;
};

/**
 * True when the browser holds a Supabase auth cookie (`sb-<ref>-auth-token`,
 * possibly chunked as `.0`, `.1`). Exported for the tests. A label hint only.
 */
export function hasSessionCookie(cookie: string): boolean {
  return /(?:^|;\s*)sb-[^=;]+-auth-token(?:\.\d+)?=[^;]/.test(cookie);
}

type Item = {
  label: string;
  href: string;
  match: (p: string) => boolean;
  outlined?: true;
  /** Set on the two product items: the tag shown beside the wordmark. */
  product?: string;
  /** The phone label, when it differs from the desktop one (Play, Songs). */
  short?: string;
  /** Desktop only: not in the phone bar (it lives on /account and in the footer). */
  wideOnly?: true;
};

export default function SignedInNav({ signedIn }: SignedInNavProps) {
  // usePathname returns null outside a router (and in renderToStaticMarkup).
  // The nav still renders in full; only aria-current goes quiet.
  const pathname = usePathname() ?? '';
  const [hinted, setHinted] = useState(false);
  useEffect(() => {
    if (signedIn !== null) return;
    try {
      setHinted(hasSessionCookie(document.cookie));
    } catch {
      setHinted(false);
    }
  }, [signedIn]);
  const showAccount = signedIn ?? hinted;

  // Sign in from the Download loops page comes back to it, as the page's own button does. Only
  // there: elsewhere the login page's default landing is the right one, and no other item may
  // carry a query (test/signed-in-nav.test.mjs).
  const onLoops = pathname === '/loops';
  const signInHref = onLoops ? `/login?return_to=${encodeURIComponent('/loops')}` : '/login';

  // Story 7.2: the tool, Download loops, Song library and Account, in the
  // order the design canvas shows (kept from PR #208); Pricing (P6) sits just
  // before Account / Sign in.
  //
  // "Download loops" was withheld until there was a page behind it: the loops
  // used to render inside the job page's `done` branch, so the only target was
  // a fragment on a URL this bar has no id for. /loops is now a real page that
  // takes no job id (it has its own song picker), so the item is a plain link
  // to a page that is always there. Still true and still gated: no href here
  // may be job-specific, and none may point at a fragment.
  //
  // "Play along" goes to the tool rather than to a specific job for the reason
  // set out in SignedInChrome: a per-browser cookie cannot answer "which job is
  // THIS user's" and must not be asked to.
  //
  // Signed out, the bar still offers Download loops: /loops shows signed-out
  // visitors that product's own intro, with sign-in one click on (Story 7.5).
  //
  // "Play along" is current on the landing too: the landing IS the Play along
  // product page (2026-11-15), as /loops is Download loops'.
  const items: Item[] = [
    { label: 'Play along', short: 'Play', href: '/', match: (p) => p === '/' || p.startsWith('/jobs/'), product: 'Play along' },
    { label: 'Download loops', href: '/loops', match: (p) => p === '/loops' || p.startsWith('/loops/'), product: 'Download loops', wideOnly: true },
    // Current on /history and on the set-list pages, /sets and /sets/<id> (B2 follow-up): set
    // lists have no item of their own (three phone items, A4), and they are lists of library songs.
    { label: 'Song library', short: 'Songs', href: '/history', match: isSongLibraryPath },
    // P6 (Jon, 2026-11-17): Pricing is in the bar, signed in and out, on every
    // page including the landing. It belongs to neither product, so it carries
    // no `product` tag.
    // A4: desktop only; on a phone Pricing is on /account and in the footer.
    { label: 'Pricing', href: '/pricing', match: (p) => p === '/pricing', wideOnly: true },
    showAccount
      ? { label: 'Account', href: '/account', match: (p) => p.startsWith('/account'), outlined: true }
      : { label: 'Sign in', href: signInHref, match: (p) => p === '/login', outlined: true },
  ];

  // Story 7.4: say which product you are in. The current pill does on a wide
  // screen; the tag beside the wordmark carries it too. Below 760px: on Play
  // along pages the tag gives way to the three items (the current "Play" item
  // says it); on /loops, which has no phone item, the tag stays, small, under the
  // wordmark (signed-in-nav.css), so Story 8.4 holds at every width. Off a product page there is no tag: /history,
  // /account, /pricing and the legal pages belong to neither.
  const product = items.find((it) => it.product && it.match(pathname))?.product ?? null;

  return (
    <header className="sin-bar">
      <div className="sin-inner">
        <div className="sin-brand">
          <a className="sin-wordmark" href="/" aria-label="stem-loops, home">
            <span>stem</span>
            <span className="sin-dash">-</span>
            <span className="sin-loops">loops</span>
          </a>
          {product && (
            <span className="sin-product" data-testid="sin-product" data-product={product}>
              {product}
            </span>
          )}
        </div>

        <nav id="sin-menu" className="sin-nav" aria-label="Main">
          {items.map((it) => {
            const current = it.match(pathname);
            const cls = ['sin-item', current ? 'sin-current' : '', it.outlined ? 'sin-outlined' : '', it.wideOnly ? 'sin-wide-only' : '']
              .filter(Boolean)
              .join(' ');
            return (
              <a key={it.label} className={cls} href={it.href} {...(current ? { 'aria-current': 'page' as const } : {})}>
                {it.short ? (
                  // One label per width: the hidden one is display:none, so the accessible name
                  // always matches what is on screen.
                  <>
                    <span className="sin-l-wide">{it.label}</span>
                    <span className="sin-l-phone">{it.short}</span>
                  </>
                ) : (
                  it.label
                )}
              </a>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
