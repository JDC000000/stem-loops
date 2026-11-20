import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import FlashBanner from '@/components/FlashBanner';
import SiteAnalytics from '@/components/SiteAnalytics';
import { SITE_DESCRIPTION } from '@/lib/seo/site';

export const metadata: Metadata = {
  metadataBase: new URL('https://stem-loops.com'),
  title: { default: 'stem-loops', template: '%s · stem-loops' },
  // DB-17: switched with the one claim switch; defined in lib/seo/site.ts.
  description: SITE_DESCRIPTION,
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

export const viewport: Viewport = {
  themeColor: '#0d0d0d',
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
