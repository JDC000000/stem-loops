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
            {/* Sign-in needs a way in from the landing page because THE JOB PAGE is
                gated: app/jobs/[id]/page.tsx:32-33 awaits getUser() and redirects to
                /login, so a visitor who starts a job is sent to the sign-in form
                before the player, the faders or the chords render.

                NOT because stem download is gated. This comment used to read "V3-J9: an
                account is required to download stems", in the present tense, as a
                description of the code. It is not one. V3-J9 (TSD §12.9) is Jon's
                DECISION that stem download will require sign-up; the gate is unbuilt.
                Measured on this tree: mintStemDownloadUrl (lib/stem-urls.ts:68) has no
                production consumer at all — its only callers are its own contract test
                — and api/jobs/[id]/stems/route.ts makes ZERO getUser() calls and says
                in its own header that it is "Deliberately NOT gated on sign-in". The
                sign-in LINK is still owed to V3-J9, which lists "a sign-in affordance
                on the landing page" as an agent deliverable; only the stated reason was
                wrong. (api/jobs/[id]/stems/route.ts:72-73 still carries the same claim
                and is deliberately left alone — it sits under an unresolved M-11 note
                that needs Jon's recorded acceptance.)

                Sign-in itself works today; the sign-up tab self-describes as unavailable
                until NEXT_PUBLIC_HCAPTCHA_SITE_KEY is set (LoginForm.tsx), so this link
                never leads to a silently broken form. */}
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
