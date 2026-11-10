// Header + footer shared by the landing, /terms and /privacy.
import { ToInputLink } from './DemoArt';
import { Ic } from './Icons';

export function SiteHeader({ showHistory = true, showSignIn = true }: { showHistory?: boolean; showSignIn?: boolean }) {
  return (
    <header className="site-header">
      <div className="container header-row">
        {/* Wordmark: "stem" + lime dash + "loops" (the name is always written stem-loops) */}
        <a className="wordmark" href="/" aria-label="stem-loops, home">
          <span className="wm-stem">stem</span>
          <span className="wm-dash">-</span>
          <span className="wm-loops">loops</span>
        </a>
        {/* Grouped so the header stays wordmark-left / links-right: .header-row is
            space-between, and a third direct child would strand "Job history" in the
            middle of the bar. */}
        {(showHistory || showSignIn) && (
          <nav className="header-nav" aria-label="Account">
            {showHistory && (
              <a className="header-link" href="/history">
                Job history
              </a>
            )}
            {/* V3-J9: an account is required to download stems, so sign-in needs a way in
                from the landing page. Sign-in itself works today; the sign-up tab
                self-describes as unavailable until NEXT_PUBLIC_HCAPTCHA_SITE_KEY is set
                (LoginForm.tsx), so this link never leads to a silently broken form. */}
            {showSignIn && (
              <a className="header-link" href="/login">
                Sign in
              </a>
            )}
          </nav>
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
