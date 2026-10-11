import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { Ic, IconSprite } from '@/components/landing/Icons';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import '@/styles/landing.css';
import '@/styles/landing-color.css';
import '@/styles/not-found.css';

// The same self-hosted mono as app/(landing)/layout.tsx (the root 404 sits outside that group).
const jetbrainsMono = localFont({
  src: './(landing)/fonts/jetbrains-mono-latin-wght-normal.woff2',
  weight: '100 800',
  style: 'normal',
  display: 'swap',
  variable: '--font-jbm',
  fallback: ['ui-monospace', 'SF Mono', 'Consolas', 'monospace'],
});

// The title Next's default 404 already used, so the words are unchanged.
export const metadata: Metadata = {
  title: { absolute: '404: This page could not be found.' },
};

// Branded 404 inside the app chrome. Words are only those the site's error pages already use
// (Next's 404 text and the job pages' "New track" link), with one link home.
export default function NotFound() {
  return (
    <div className={`sl-root ${jetbrainsMono.variable}`}>
      <IconSprite />
      <SiteHeader />
      <main id="main" className="nf">
        <div className="container">
          <p className="mono nf-code">404</p>
          <h1>This page could not be found.</h1>
          <a className="btn btn-primary nf-home" href="/">
            <Ic name="up" className="nf-back" />
            New track
          </a>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
