import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://stem-loops.com'),
  title: { default: 'stem-loops', template: '%s · stem-loops' },
  description: 'Split a song into stems and 1, 2, 4 or 8-bar loops at the detected BPM, as 24-bit WAV. Free, no account.',
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
      <body>{children}</body>
    </html>
  );
}
