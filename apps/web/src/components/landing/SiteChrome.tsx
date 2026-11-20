// Header + footer shared by the landing, /help, /terms, /privacy and the 404.
import SignedInNav from '@/components/chrome/SignedInNav';
import { ToInputLink } from './DemoArt';
import { Ic } from './Icons';

/**
 * The landing, /terms, /privacy and the 404 render THE SAME top nav as every other page
 * (2026-11-15): Play along · Download loops · Song library ("Job history" until Slice 2a, "Library" until #316) · Sign in / Account, with the
 * current product marked. These pages are statically rendered, so the session is not read
 * here; see the header of components/chrome/SignedInNav.tsx for how the last item is chosen.
 *
 * It used to be a separate, marketing-only bar (Job history · Sign in) — which is why Jon
 * could not find Download loops from the home page. The old `.site-header` bar and its
 * `showHistory` / `showSignIn` props are gone; the sign-in link it carried is now the
 * nav's own last item (still owed to V3-J9's "a sign-in affordance on the landing page").
 */
export function SiteHeader() {
  return <SignedInNav signedIn={null} />;
}

export function SiteFooter({ onLanding = false }: { onLanding?: boolean }) {
  return (
    <footer className="site-footer">
      <div className="container footer-row">
        <p className="footer-line">stem-loops. Play along with any song.</p>
        {/* The two products, as peers, the way the top nav lists them. */}
        <nav className="footer-links" aria-label="Products">
          <a href="/">Play along</a>
          <a href="/loops">Download loops</a>
        </nav>
        <nav className="footer-links" aria-label="Legal">
          <a href="/help">Help</a>
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
