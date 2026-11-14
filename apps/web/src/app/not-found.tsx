import type { Metadata } from 'next';
import { Ic, IconSprite } from '@/components/landing/Icons';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import '@/styles/landing.css';
import '@/styles/landing-color.css';
import '@/styles/not-found.css';

// JetBrains Mono comes from the root layout, as on every route.

// Our own title; the root layout's template appends " · stem-loops".
export const metadata: Metadata = {
  title: 'Page not found',
};

// Branded 404 inside the app chrome, with one link home: "Start a new song", the label the job pages use.
export default function NotFound() {
  return (
    <div className="sl-root">
      <IconSprite />
      <SiteHeader />
      <main id="main" className="nf">
        <div className="container">
          <p className="mono nf-code">404</p>
          <h1>We can’t find that page.</h1>
          <a className="btn btn-primary nf-home" href="/">
            <Ic name="up" className="nf-back" />
            Start a new song
          </a>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
