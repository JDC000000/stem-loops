// stem-loops home. v6 (2026-11-11): repositioned onto the play-along product — Story 0 of
// claude/user-stories-play-along-2026-11-10.md, approved by Jon.
//
// v7 (2026-11-15): this is the PLAY ALONG product page and nothing else. Jon: "stem downloads
// would be removed from the play along section. It's just up on the top nav ... a full separate
// product ... on a separate user page." The loops section, the loop-file spec row and the loop
// lines in the pipeline and FAQ moved to the Download loops page's own intro (/loops,
// components/loops/LoopsIntro.tsx); the top nav names both products on every page.
// test/two-products-nav.test.mjs fails if loop-download selling comes back here.
//
// Every capability claim here maps to a row of the approved launch table. The gaps — tempo,
// pitch, lyrics — are stated on the page on purpose, because they are the first thing anyone
// asks for after playing along once and we would rather say "coming" than let them find out.
//
// Static sections are server-rendered; the tool, the example lanes and the players are client
// islands that share one DemoProvider. The hero's example (Lanes) still frames itself around
// the loop cut: it is the demo-asset contract and its own measured copy, so it is left alone
// here and tracked as a follow-up.
import { DemoProvider } from '@/components/landing/DemoProvider';
import { ToolForm } from '@/components/landing/ToolForm';
import { Lanes } from '@/components/landing/Lanes';
import { AbCompare, PipeSongArt, PipeStemsArt, ToInputLink } from '@/components/landing/DemoArt';
import { PlayerArt } from '@/components/landing/PlayerArt';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import { Ic } from '@/components/landing/Icons';
import type { Metadata } from 'next';
import { YOUTUBE_INPUT_ENABLED } from '@/lib/public-config';
import { MAX_TRACK_SEC } from '@/lib/play/types';
import { JsonLd } from '@/components/seo/JsonLd';
import { homeGraph } from '@/lib/seo/jsonld';
import { pageFor } from '@/lib/seo/pages';

// Story 1.4 (revised 2026-11-14): any song is accepted and its FIRST MAX_TRACK_MIN minutes are
// used — a longer track is trimmed on our end and still converted. The copy says the figure in minutes,
// derived from the same constant the player enforces, so the two can never drift apart.
const MAX_TRACK_MIN = Math.floor(MAX_TRACK_SEC / 60);

const OG_TITLE = 'Paste a song. Play along.';
const OG_DESC = 'Six stems with faders, mute and solo, and a chord track that moves with the song. Loop a detected section until you have it.';
const OG_ALT =
  'Four chord names, Gm, E flat, B flat and F, above six mixer channels for drums, bass, guitar, keys, vocals and other, with the guitar fader pulled down and muted, under the headline Paste a song. Play along.';

export const metadata: Metadata = {
  title: { absolute: 'stem-loops: play along with any song, stem by stem' },
  // One source: the registry entry for '/' (lib/seo/pages.ts), built from MAX_TRACK_MIN.
  description: pageFor('/')!.description,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'stem-loops',
    locale: 'en_CA',
    url: '/',
    title: OG_TITLE,
    description: OG_DESC,
    images: [{ url: '/og-image-v4.png', width: 1200, height: 630, alt: OG_ALT }],
  },
  twitter: { card: 'summary_large_image', title: OG_TITLE, description: OG_DESC, images: [{ url: '/og-image-v4.png', alt: OG_ALT }] },
};

export default function HomePage() {
  return (
    <DemoProvider>
      <JsonLd data={homeGraph()} />
      <a className="skip" href="#tool">
        Skip to the tool
      </a>
      <SiteHeader />
      <main id="main">
        {/* 1. HERO: the play-along promise, the tool, the stem example */}
        <section className="hero" aria-labelledby="h1">
          <div className="container hero-grid">
            <div className="hero-copy">
              <h1 id="h1">
                <span className="h1-line">Paste a song.</span> <span className="h1-line">Play along.</span>
              </h1>
              <p className="lead">
                We split the song into six stems, each with a fader, mute and solo, and run a chord track over the
                top — so you can turn your own part down and play it yourself.
              </p>
              <p className="audience">
                Uses the first {MAX_TRACK_MIN}&nbsp;minutes of any song, in Chrome on the desktop. Starting a job needs no account;
                opening the player needs one.
              </p>
            </div>
            <ToolForm />
            <Lanes />
          </div>
        </section>

        {/* 2. THE PLAYER: the product, drawn */}
        <section className="section" id="play" aria-labelledby="play-h">
          <div className="container">
            <div className="reading">
              <h2 id="play-h">What playing along looks like</h2>
              <p className="body-lg">
                When a job finishes it opens a player in the same tab: the chords across the top, the six stems on faders
                underneath, and a loop you can set on any detected section of the song.
              </p>
            </div>
            <PlayerArt />
            <div className="again">
              <p className="again-text">Try it on a song you are learning.</p>
              <ToInputLink className="btn btn-primary btn-again">
                <Ic name="up" />
                Paste a song
              </ToInputLink>
            </div>
          </div>
        </section>

        {/* 3. SCOPE: the honest spec sheet, including what is deliberately not here yet */}
        <section className="section" id="scope" aria-labelledby="scope-h">
          <div className="container">
            <div className="reading">
              <h2 id="scope-h">What it does, and what it does not do yet</h2>
              <p className="body-lg">
                The whole list, so none of it is a surprise once you are inside.{' '}
                <a href="/pricing">See the monthly track limits →</a>
              </p>
            </div>
            <dl className="spec">
              <div className="spec-row">
                <dt>Stems</dt>
                <dd>Six — drums, bass, guitar, keys, vocals and other. Every one has its own fader, a mute and a solo.</dd>
              </div>
              <div className="spec-row">
                <dt>Chords</dt>
                <dd>A chord track above the mixer, kept in time with the song. Check it by ear: it is an estimate, not a transcription.</dd>
              </div>
              <div className="spec-row">
                <dt>Looping</dt>
                <dd>Pick a detected section of the song and it repeats.</dd>
              </div>
              <div className="spec-row">
                <dt>Track length</dt>
                <dd>The first {MAX_TRACK_MIN}&nbsp;minutes of any song. A longer track is trimmed on our end to its first {MAX_TRACK_MIN}&nbsp;minutes, which is where the chord track and the player both stop.</dd>
              </div>
              <div className="spec-row">
                <dt>Where it runs</dt>
                <dd>Chrome, on a desktop. Other browsers and phones are not supported yet.</dd>
              </div>
              <div className="spec-row">
                <dt>Account</dt>
                <dd>
                  Needed to play, not to start. You can run a job signed out; the player, where the stems and chords
                  are shown, asks you to sign in. If you are new, you create an account on the{' '}
                  <a href="/login">sign-in page</a>. The one-time link by email only signs you back in to an account
                  that already exists; it does not create one.
                </dd>
              </div>
              <div className="spec-row spec-later">
                <dt>Tempo</dt>
                <dd>Not yet. Playing a song slower without dropping its pitch is the next thing being built.</dd>
              </div>
              <div className="spec-row spec-later">
                <dt>Pitch and capo</dt>
                <dd>Not yet. The song plays in its own key for now.</dd>
              </div>
              <div className="spec-row spec-later">
                <dt>Lyrics</dt>
                <dd>No. Chords only, and that is not planned to change.</dd>
              </div>
            </dl>
          </div>
        </section>

        {/* 4. PIPELINE on the lane grid */}
        <section className="section" id="how" aria-labelledby="how-h">
          <div className="container">
            <div className="reading">
              <h2 id="how-h">From one song to a player</h2>
              <p className="body-lg">Our example song, stage by stage, with the limits that apply at each one.</p>
            </div>
            <ol className="pipe" id="pipe">
              <li className="pipe-row">
                <p className="pipe-name">Paste</p>
                <div className="pipe-art">
                  <PipeSongArt />
                  <p className="mono pipe-meta">Lucky Ticket · 3:34 · original mix</p>
                </div>
                <div className="pipe-text">
                  <p>{YOUTUBE_INPUT_ENABLED ? 'A public YouTube link, or one audio or video file.' : 'One audio or video file (YouTube links are paused right now).'}</p>
                  <dl className="kv">
                    <dt>Files</dt>
                    <dd>mp3, wav, m4a, aac, flac, ogg, opus, aiff, mp4, m4v, mov, webm</dd>
                    <dt>Max upload</dt>
                    <dd>200&nbsp;MB</dd>
                    <dt>Length used</dt>
                    <dd>The first {MAX_TRACK_MIN}&nbsp;minutes</dd>
                    <dt>Tempo</dt>
                    <dd>40–250 BPM</dd>
                  </dl>
                </div>
              </li>
              <li className="pipe-row">
                <p className="pipe-name">Separate</p>
                <div className="pipe-art">
                  <PipeStemsArt />
                </div>
                <div className="pipe-text">
                  <p>Demucs splits it into drums, bass, guitar, keys, vocals and other — the six channels of the mixer.</p>
                  <dl className="kv">
                    <dt>Stems</dt>
                    <dd>6, pick any</dd>
                    <dt>Model</dt>
                    <dd>Demucs htdemucs_6s on Replicate</dd>
                  </dl>
                </div>
              </li>
              <li className="pipe-row">
                <p className="pipe-name">Play</p>
                <div className="pipe-art">
                  <AbCompare />
                </div>
                <div className="pipe-text">
                  <p>
                    The stems load into the player with the chord track over them. Pull your part down, solo the one you are
                    learning, or loop a section until it sticks.
                  </p>
                  <dl className="kv">
                    <dt>Player</dt>
                    <dd>6 faders, mute, solo, section loop</dd>
                    <dt>Chords</dt>
                    <dd>An estimate, kept in time with the song</dd>
                  </dl>
                </div>
              </li>
            </ol>
            <p className="pipe-foot">While it runs, the job page shows each stage: fetching, separating, finding bars, saving.</p>
          </div>
        </section>

        {/* 5. FAQ */}
        <section className="section" id="faq" aria-labelledby="faq-h">
          <div className="container">
            <h2 id="faq-h">Questions</h2>
            <div className="faq">
              <div className="faq-col">
                <details>
                  <summary>What do I actually get?</summary>
                  <p>
                    A player, in your browser, with the song’s six stems on their own faders and a chord track running
                    above them. Mute the guitar and play the guitar part; solo the bass to work it out; loop the chorus
                    until it sticks.
                  </p>
                </details>
                <details>
                  <summary>Do I need an account?</summary>
                  <p>
                    Not to start one. Running a job works signed out. The player asks you to sign in — that is where
                    the stems and the chord track are shown. If you are new, you create an account on the{' '}
                    <a href="/login">sign-in page</a>. A one-time link sent to your email only signs you back in to an
                    account that already exists; it does not create one.
                  </p>
                </details>
                <details>
                  <summary>Which browsers work?</summary>
                  <p>
                    Chrome on a desktop or laptop, which is what the player is built and tested against for now. Other
                    browsers and phones are not supported yet.
                  </p>
                </details>
                <details>
                  <summary>Can I slow a song down, or change its key?</summary>
                  <p>
                    Not yet, and that is a deliberate order rather than an oversight: separation, faders and chords came
                    first. Playing a track slower without dropping its pitch is next, and a capo or key change follows it.
                    Today the song plays at its own tempo in its own key.
                  </p>
                </details>
                <details>
                  <summary>How good are the chords?</summary>
                  <p>
                    Good enough to play along to on most songs, and wrong often enough that you should trust your ears
                    over the screen. They are an estimate made from the audio, not a transcription someone checked. Dense,
                    heavily altered or very quiet passages are where they slip.
                  </p>
                </details>
              </div>
              <div className="faq-col">
                <details>
                  <summary>How long does it take?</summary>
                  <p>
                    Our 3:34 example song took about 1–3 minutes (0:51 to 3:07 across four runs on 9 October 2026). Longer
                    tracks and a busy queue take longer. The job page shows each stage as it runs, with a timer.
                  </p>
                </details>
                <details>
                  <summary>How clean is the split?</summary>
                  <p>
                    Not perfect. Dense passages can leave a little bleed from other instruments in a stem. The
                    before-and-after in “From one song to a player” is a 4-bar MP3 crop of the tool’s real output, so you
                    can judge for yourself.
                  </p>
                </details>
                <details id="faq-files">
                  <summary>What happens to my files?</summary>
                  <p>
                    Your link or file goes to our storage, and the audio goes to Replicate to split it and to Klangio to estimate the chords. Sources, stems and
                    loops are deleted after 24 hours. With a subscription, the songs in your account are kept as a library while you subscribe, and for 30 days after it ends. Anyone holding the link to a job you start without an account can fetch its audio and stems, so don’t pass that link around. A job you start while signed in opens only for your account. More in
                    the <a href="/privacy">privacy notice</a>.
                  </p>
                </details>
                <details>
                  <summary>Can I use the stems in my own music?</summary>
                  <p>
                    It depends on the source audio. Splitting a song doesn’t change who owns it. If it’s yours, or you hold the
                    rights, use it as you like. If it’s someone else’s recording, practising along to it is one thing; releasing
                    anything made from it needs clearance first. We don’t grant rights and can’t clear a sample.
                  </p>
                </details>
                <details>
                  <summary>Does it work with YouTube links?</summary>
                  {YOUTUBE_INPUT_ENABLED ? (
                    <p>
                      Yes, with public videos on youtube.com or youtu.be, including Shorts and YouTube Music links. Playlists,
                      private, age-restricted and live videos don’t work. YouTube sometimes blocks automated fetches; if it does,
                      try again in a few minutes or upload the file.
                    </p>
                  ) : (
                    <p>Not right now: YouTube links are paused. Upload the audio or video file instead.</p>
                  )}
                </details>
              </div>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter onLanding />
    </DemoProvider>
  );
}
