import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import FlashBanner from '@/components/FlashBanner';
import SiteAnalytics from '@/components/SiteAnalytics';
import { siteDescription } from '@/lib/seo/site';

// generateMetadata, not a const: the default description carries the DB-17 chord claim, which
// is read when this metadata is generated (lib/chords-claim.ts): at build for static pages.
export function generateMetadata(): Metadata {
  return {
  metadataBase: new URL('https://stem-loops.com'),
  title: { default: 'stem-loops', template: '%s · stem-loops' },
  // DB-17: switched with the one claim switch; defined in lib/seo/site.ts.
  description: siteDescription(),
  applicationName: 'stem-loops',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
    ],
    shortcut: '/favicon.ico',
    apple: '/apple-touch-icon.png',
  },
  };
}

// Self-hosted JetBrains Mono (variable, latin subset, 40 KB), loaded once for EVERY route so
// the player's mono readouts match the landing (brand book M13). next/font sets --font-jbm on
// <html>; design-tokens.css builds --font-mono from it.
const jetbrainsMono = localFont({
  src: './(landing)/fonts/jetbrains-mono-latin-wght-normal.woff2',
  weight: '100 800',
  style: 'normal',
  display: 'swap',
  variable: '--font-jbm',
  fallback: ['ui-monospace', 'SF Mono', 'Consolas', 'monospace'],
});

// viewportFit 'cover' (#360): the page draws edge to edge on iOS, so env(safe-area-inset-*) is
// non-zero there. Every surface that touches an edge pads itself: body (globals.css), the
// fixed player root and sheets, the flash banner, the sticky submit bar. On a device with no
// cutout every inset is 0 and nothing moves. Real-device check: Jon's checklist item 9.
export const viewport: Viewport = {
  themeColor: '#0d0d0d',
  viewportFit: 'cover',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: the landing adds `js` / playback classes to <html> before hydration
    <html lang="en" className={jetbrainsMono.variable} suppressHydrationWarning>
      <body>
        <FlashBanner />
        {children}
        {/* Vercel Web Analytics (2A): anonymous page views, no cookies; see lib/analytics.ts. */}
        <SiteAnalytics />
      </body>
    </html>
  );
}
