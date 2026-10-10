import localFont from 'next/font/local';
import { IconSprite } from '@/components/landing/Icons';
import '@/styles/landing.css';

// Self-hosted JetBrains Mono, variable weight, latin subset (40 KB), used for the small
// mono labels only; the page text uses the system sans.
const jetbrainsMono = localFont({
  src: './fonts/jetbrains-mono-latin-wght-normal.woff2',
  weight: '100 800',
  style: 'normal',
  display: 'swap',
  variable: '--font-jbm',
  fallback: ['ui-monospace', 'SF Mono', 'Consolas', 'monospace'],
});

// Landing, /terms and /privacy. The job and history pages keep their own styles: this
// group's stylesheet only loads here, and the landing hands off to a job with a full
// navigation so it never follows the user there.
export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`sl-root ${jetbrainsMono.variable}`}>
      {/* JS-only parts (lanes, players) are hidden until this runs; inline so there's no flash */}
      <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
      <noscript>
        <p className="noscript">The tool and the audio example need JavaScript.</p>
      </noscript>
      <IconSprite />
      {children}
    </div>
  );
}
