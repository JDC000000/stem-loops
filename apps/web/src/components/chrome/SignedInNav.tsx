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
  /** Where "Play along" goes — a job if the viewer has one, else the tool. */
  playHref: string;
  /** Where "Download loops" goes — that job's loops, else the tool. */
  loopsHref: string;
};

type Item = { label: string; href: string; match: (p: string) => boolean; outlined?: true };

export default function SignedInNav({ signedIn, playHref, loopsHref }: SignedInNavProps) {
  // usePathname returns null outside a router (and in renderToStaticMarkup).
  // The nav still renders in full; only aria-current goes quiet.
  const pathname = usePathname() ?? '';
  const [open, setOpen] = useState(false);

  const items: Item[] = [
    { label: 'Play along', href: playHref, match: (p) => p.startsWith('/jobs/') },
    // "Download loops" — Jon's wording, approved over "Song loops". The loops
    // live in the <section id="loops"> below the player on the job page, so
    // this is that section, not a route of its own. There is no /loops page.
    { label: 'Download loops', href: loopsHref, match: () => false },
    { label: 'Job history', href: '/history', match: (p) => p === '/history' },
    signedIn
      ? { label: 'Account', href: '/account', match: (p) => p.startsWith('/account'), outlined: true }
      : { label: 'Sign in', href: '/login', match: (p) => p === '/login', outlined: true },
  ];

  return (
    <header className="sin-bar">
      <div className="sin-inner">
        <a className="sin-wordmark" href="/" aria-label="stem-loops, home">
          <span>stem</span>
          <span className="sin-dash">-</span>
          <span className="sin-loops">loops</span>
        </a>

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
