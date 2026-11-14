import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import FlashBanner from '@/components/FlashBanner';
import { MAX_TRACK_SEC } from '@/lib/play/types';

export const metadata: Metadata = {
  metadataBase: new URL('https://stem-loops.com'),
  title: { default: 'stem-loops', template: '%s · stem-loops' },
  description: `Split a song into six stems with faders and a chord track, and play along. Uses the first ${Math.floor(MAX_TRACK_SEC / 60)} minutes of any song, in Chrome on the desktop.`,
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
      </body>
    </html>
  );
}
