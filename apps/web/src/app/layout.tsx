import type { Metadata, Viewport } from 'next';
import './globals.css';
import FlashBanner from '@/components/FlashBanner';
import { MAX_TRACK_SEC } from '@/lib/play/types';

export const metadata: Metadata = {
  metadataBase: new URL('https://stem-loops.com'),
  title: { default: 'stem-loops', template: '%s · stem-loops' },
  description: `Split a song into six stems with faders and a chord track, and play along. Tracks up to ${Math.floor(MAX_TRACK_SEC / 60)} minutes, in Chrome on the desktop.`,
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
    <html lang="en" suppressHydrationWarning>
      <body>
        <FlashBanner />
        {children}
      </body>
    </html>
  );
}
