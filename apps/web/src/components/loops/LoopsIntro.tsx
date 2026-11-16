// /loops, signed OUT: the Download loops product page (2026-11-15).
//
// WHY AN INTRO AND NOT A STRAIGHT REDIRECT TO SIGN-IN. "Download loops" is now in the top nav
// on every page, the landing included, so a signed-out visitor who presses it has asked "what
// is this?" — not "let me in". Bouncing them to a bare sign-in form answers neither and looks
// like the nav item is broken; it is also what Moises and LALAL.AI avoid: each product in their
// nav lands on a page that says what it is before it asks for an account. So: say what the
// product is, what you get, how it relates to Play along, and put sign-in one click on with a
// return path back here. This is also where the loop-download selling that used to sit on the
// landing now lives (the file card, the WAV spec and the rights note).
//
// A deep link with ?job=<id> still redirects to sign-in (app/loops/page.tsx): that link comes
// from a job page, so the visitor already knows the product and wants that song's loops.
//
// Server component, no client JS. Styled by styles/loops-page.css (`lp-` classes).
import { DEMO_WAV_FILENAME, DEMO_WAV_URL } from '@/lib/public-config';

export const LOOPS_SIGN_IN_HREF = `/login?return_to=${encodeURIComponent('/loops')}`;

export default function LoopsIntro() {
  return (
    <main className="lp-wrap lp-intro" id="main" data-testid="loops-intro">
      <header className="lp-head">
        <p className="lp-eyebrow">A separate tool from Play along</p>
        <h1 className="lp-h1">Download loops</h1>
        <p className="lp-lede">
          Bar-length loops cut from each stem of a song, as WAV files for your sampler or DAW. Pick a song you have
          split, choose its loops, and press Cut.
        </p>
        <div className="lp-cta-row">
          <a className="jp-primary lp-cta" href={LOOPS_SIGN_IN_HREF} data-testid="loops-intro-sign-in">
            Sign in to download loops
          </a>
          <a className="lp-link" href="/">
            No song yet? Split one in Play along →
          </a>
        </div>
        <p className="lp-muted">If you are new, you create an account on the sign-in page.</p>
      </header>

      <section aria-labelledby="lp-get-h" className="lp-intro-block">
        <h2 id="lp-get-h" className="lp-h2">
          What you get
        </h2>
        <dl className="lp-spec">
          <div>
            <dt>Lengths</dt>
            <dd>1, 2, 4 or 8 bars, up to 10 loops per stem</dd>
          </div>
          <div>
            <dt>Stems</dt>
            <dd>Drums, bass, guitar, keys, vocals and other</dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>24-bit WAV, 44.1&nbsp;kHz, named by stem, BPM, key estimate, section and number</dd>
          </div>
          <div>
            <dt>Timing</dt>
            <dd>
              Bars are counted from the first detected beat, not from bar 1, so a loop can start a beat early. Nudge it in
              your DAW if you need the downbeat.
            </dd>
          </div>
          <div>
            <dt>When</dt>
            <dd>Loops are cut only when you ask, within 24 hours of splitting the song.</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="lp-how-h" className="lp-intro-block">
        <h2 id="lp-how-h" className="lp-h2">
          How it works
        </h2>
        <ol className="lp-steps">
          <li>
            Split a song: paste it on the <a className="lp-link" href="/">Play along</a> page. The same job gives you the
            player and the loops.
          </li>
          <li>Sign in and open Download loops from the top bar.</li>
          <li>Pick the song and press Cut to make the WAV files.</li>
        </ol>
      </section>

      {DEMO_WAV_URL ? (
        <section aria-labelledby="lp-demo-h" className="lp-intro-block">
          <h2 id="lp-demo-h" className="lp-h2">
            Hear one first
          </h2>
          <div className="lp-file">
            <p className="lp-file-name">{DEMO_WAV_FILENAME}</p>
            <p className="lp-muted">24-bit WAV · 44.1&nbsp;kHz · stereo · 8&nbsp;bars · from our example song</p>
            <a className="lp-secondary lp-file-dl" href={DEMO_WAV_URL} download={DEMO_WAV_FILENAME}>
              Download the example loop
            </a>
            <p className="lp-muted">Free to use in your own music. Credit appreciated: Lucky Ticket by Jon Cartwright.</p>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="lp-rights-h" className="lp-intro-block">
        <h2 id="lp-rights-h" className="lp-h2">
          Can I use the loops commercially?
        </h2>
        <p className="lp-body">
          It depends on the source audio. Splitting a song doesn’t change who owns it. If it’s yours, or you hold the
          rights, use the loops as you like. If it’s someone else’s recording, you need clearance before you release
          anything. We don’t grant rights and can’t clear a sample.
        </p>
      </section>
    </main>
  );
}
