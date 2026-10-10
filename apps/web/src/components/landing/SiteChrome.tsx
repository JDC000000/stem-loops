// Header + footer shared by the landing, /terms and /privacy.
import { ToInputLink } from './DemoArt';
import { Ic } from './Icons';

export function SiteHeader({ showHistory = true }: { showHistory?: boolean }) {
  return (
    <header className="site-header">
      <div className="container header-row">
        {/* Wordmark: "stem" + lime dash + "loops" (the name is always written stem-loops) */}
        <a className="wordmark" href="/" aria-label="stem-loops, home">
          <span className="wm-stem">stem</span>
          <span className="wm-dash">-</span>
          <span className="wm-loops">loops</span>
        </a>
        {showHistory && (
          <a className="header-link" href="/history">
            Job history
          </a>
        )}
      </div>
    </header>
  );
}

export function SiteFooter({ onLanding = false }: { onLanding?: boolean }) {
  return (
    <footer className="site-footer">
      <div className="container footer-row">
        <p className="footer-line">stem-loops. Stems by Demucs, run on Replicate.</p>
        <nav className="footer-links" aria-label="Legal">
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
        </nav>
        {onLanding ? (
          <ToInputLink className="back-top">
            <Ic name="up" />
            Go to the input
          </ToInputLink>
        ) : (
          <a className="back-top" href="/">
            <Ic name="up" />
            Back to stem-loops
          </a>
        )}
      </div>
    </footer>
  );
}
