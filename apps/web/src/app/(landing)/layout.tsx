import { IconSprite } from '@/components/landing/Icons';
import '@/styles/landing.css';
import '@/styles/landing-color.css';

// JetBrains Mono is loaded app-wide by app/layout.tsx (it sets --font-jbm on <html>).

const INLINE_BOOT =
  "document.documentElement.classList.add('js');" +
  "document.addEventListener('submit',function(e){if(e.target&&e.target.id==='tool')e.preventDefault()},true);";

// Landing, /terms and /privacy. The job and history pages keep their own styles: this
// group's stylesheet only loads here, and the landing hands off to a job with a full
// navigation so it never follows the user there.
export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="sl-root">
      {/* Inline, before any markup: (1) mark JS so JS-only parts (lanes, players) show without a
          flash; (2) never let the tool form do a native GET submit (a tap before hydration would
          reload the page as /?source=… and lose the input). React's onSubmit still runs. */}
      <script dangerouslySetInnerHTML={{ __html: INLINE_BOOT }} />
      <noscript>
        <p className="noscript">The tool and the audio example need JavaScript.</p>
      </noscript>
      <IconSprite />
      {children}
    </div>
  );
}
