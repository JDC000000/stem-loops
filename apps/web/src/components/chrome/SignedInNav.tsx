'use client';

// The persistent header for the signed-in app. Presentational and interactive
// only — it is handed everything it needs.
//
// WHY IT IS A CLIENT COMPONENT AND THE SESSION STILL IS NOT READ HERE.
// Two things this bar must do cannot be done on the server in the App Router:
// mark the current page (`aria-current`), which needs the pathname, and open a
// menu (`aria-expanded`), which needs state. Both are view concerns. The
// SESSION is NOT one of them: `signedIn` arrives as a prop from
// SignedInChrome, which awaits `getUser()` on the server — the same pattern as
// app/jobs/[id]/page.tsx:32. There is no client-side auth read, and this file
// imports nothing from @/lib/auth.
//
// WHY A SIBLING OF SiteHeader RATHER THAN AN EXTENSION OF IT.
// SiteHeader (components/landing/SiteChrome.tsx) is styled entirely by
// src/styles/landing.css, which is imported by app/(landing)/layout.tsx and
// therefore loads on four routes ONLY: /, /terms, /privacy and the 404.
// Rendering SiteHeader on /account would emit `.site-header`, `.header-row`,
// `.wordmark` and `.header-link` with NO RULES BEHIND THEM — an unstyled strip
// of blue underlined links. Making it work would mean lifting landing.css out
// of the landing group, which changes what loads on the landing page; and the
// two bars do not agree on contents anyway (this one carries the product items
// and an Account control, that one carries marketing). So: a sibling, with its
// own stylesheet, and SiteChrome.tsx untouched. The cost is two bars to keep in
// step; the gates in test/signed-in-nav.test.mjs pin this one's contract.
import { usePathname } from 'next/navigation';
import { useState } from 'react';

export type SignedInNavProps = {
  /** Server-resolved. Drives Account (true) vs Sign in (false). */
  signedIn: boolean;
};

type Item = {
  label: string;
  href: string;
  match: (p: string) => boolean;
  outlined?: true;
  /** Set on the two product items: the tag shown beside the wordmark. */
  product?: string;
};

export default function SignedInNav({ signedIn }: SignedInNavProps) {
  // usePathname returns null outside a router (and in renderToStaticMarkup).
  // The nav still renders in full; only aria-current goes quiet.
  const pathname = usePathname() ?? '';
  const [open, setOpen] = useState(false);

  // Story 7.2: the tool, Download loops, Job history and Account, in the
  // order the design canvas shows (kept from PR #208).
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
  // Signed out, the bar still offers Download loops: /loops redirects to
  // sign-in and comes back (Story 7.5, the signed-out state is designed too).
  const items: Item[] = [
    { label: 'Play along', href: '/', match: (p) => p.startsWith('/jobs/'), product: 'Play along' },
    { label: 'Download loops', href: '/loops', match: (p) => p === '/loops' || p.startsWith('/loops/'), product: 'Loops' },
    { label: 'Job history', href: '/history', match: (p) => p === '/history' },
    signedIn
      ? { label: 'Account', href: '/account', match: (p) => p.startsWith('/account'), outlined: true }
      : { label: 'Sign in', href: '/login', match: (p) => p === '/login', outlined: true },
  ];

  // Story 7.4: say which product you are in. The current pill already does on
  // a wide screen, but below 760px the items are folded into the menu, so the
  // only thing on screen is the wordmark. A short tag beside it carries the
  // product at every width. Off a product page there is no tag: /history and
  // /account belong to neither.
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
            <span className="sin-product" data-testid="sin-product">
              {product}
            </span>
          )}
        </div>

        <button
          type="button"
          className="sin-toggle"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          aria-controls="sin-menu"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="sin-bars" aria-hidden="true" />
        </button>

        <nav
          id="sin-menu"
          className={`sin-nav${open ? ' sin-open' : ''}`}
          aria-label="Main"
        >
          {items.map((it) => {
            const current = it.match(pathname);
            return (
              <a
                key={it.label}
                className={`sin-item${current ? ' sin-current' : ''}${it.outlined ? ' sin-outlined' : ''}`}
                href={it.href}
                {...(current ? { 'aria-current': 'page' as const } : {})}
              >
                {it.label}
              </a>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
