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
            {/* Sign-in needs a way in from the landing page because THE JOB PAGE
                redirects: app/jobs/[id]/page.tsx:32-33 awaits getUser() and sends a
                signed-out visitor to /login before the player, the faders or the
                chords render.

                Naming the right reason matters, because this comment used to give a
                different one — it cited V3-J9 and the download path, in the present
                tense, as if describing the code. It was not describing the code.
                V3-J9 (TSD §12.9) is Jon's DECISION about a path that is still
                UNBUILT: mintStemDownloadUrl (lib/stem-urls.ts:68) has no production
                consumer, its only callers being its own contract test, and the
                serving route under api/jobs/[id]/ makes ZERO getUser() calls. The
                LINK is still owed to V3-J9, which lists "a sign-in affordance on the
                landing page" among the agent deliverables; only the stated reason
                was wrong. (The same wording survives in that route's own header. It
                is deliberately left alone: it sits under an unresolved M-11 note
                awaiting Jon's recorded acceptance.)

                Sign-in itself works today; the sign-up tab self-describes as
                unavailable until NEXT_PUBLIC_HCAPTCHA_SITE_KEY is set
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
            Paste a song
          </ToInputLink>
        ) : (
          <a className="back-top" href="/">
            <Ic name="up" />
            Go to the home page
          </a>
        )}
      </div>
    </footer>
  );
}
