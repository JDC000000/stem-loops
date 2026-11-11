// stem-loops home. v6 (2026-11-11): repositioned onto the play-along product — Story 0 of
// claude/user-stories-play-along-2026-11-10.md, approved by Jon. The page used to sell the
// loop downloader; the player is the product now and the loops are the second thing, kept
// but moved below the fold (Story 6, "a distant second").
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
import { AbCompare, DemoWavDownload, PipeCutArt, PipeSongArt, PipeStemsArt, ToInputLink } from '@/components/landing/DemoArt';
import { PlayerArt } from '@/components/landing/PlayerArt';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import { Ic } from '@/components/landing/Icons';
import type { Metadata } from 'next';
import { YOUTUBE_INPUT_ENABLED } from '@/lib/public-config';
import { MAX_TRACK_SEC } from '@/lib/play/types';

// Story 1.4: tracks are capped. The copy says the cap in minutes, derived from the same
// constant the player enforces, so the two can never drift apart.
const MAX_TRACK_MIN = Math.floor(MAX_TRACK_SEC / 60);

const OG_TITLE = 'Paste a song. Play along.';
const OG_DESC = 'Six stems with faders, mute and solo, and a chord track that moves with the song. Loop a section until you have it.';
const OG_ALT =
  'Four chord names, Gm, E flat, B flat and F, above six mixer channels for drums, bass, vocals, guitar, keys and other, with the guitar fader pulled down and muted, under the headline Paste a song. Play along.';

export const metadata: Metadata = {
  title: { absolute: 'stem-loops: play along with any song, stem by stem' },
  description:
    `Split a song into six stems with faders, mute and solo, and a chord track that moves with the song. Loop any section. Tracks up to ${MAX_TRACK_MIN} minutes, in Chrome on the desktop.`,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'stem-loops',
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
                stem-loops splits a track into six stems with real faders, mute and solo, and runs a chord track over the
                top — so you can turn your own part down and play it yourself.
              </p>
              <p className="audience">
                Tracks up to {MAX_TRACK_MIN}&nbsp;minutes, in Chrome on the desktop. You need an account.
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
                underneath, and a loop you can drop on any section of the song.
              </p>
            </div>
            <PlayerArt />
            <div className="again">
              <p className="again-text">Try it on a song you are learning.</p>
              <ToInputLink className="btn btn-primary btn-again">
                <Ic name="up" />
                Go to the input
              </ToInputLink>
            </div>
          </div>
        </section>

        {/* 3. SCOPE: the honest spec sheet, including what is deliberately not here yet */}
        <section className="section" id="scope" aria-labelledby="scope-h">
          <div className="container">
            <div className="reading">
              <h2 id="scope-h">What it does, and what it does not do yet</h2>
              <p className="body-lg">The whole list, so none of it is a surprise once you are inside.</p>
            </div>
            <dl className="spec">
              <div className="spec-row">
                <dt>Stems</dt>
                <dd>Six — drums, bass, vocals, guitar, keys and other. Every one has its own fader, a mute and a solo.</dd>
              </div>
              <div className="spec-row">
                <dt>Chords</dt>
                <dd>A chord track above the mixer, kept in time with the song. Check it by ear: it is an estimate, not a transcription.</dd>
              </div>
              <div className="spec-row">
                <dt>Looping</dt>
                <dd>Pick a section of the song and it repeats.</dd>
              </div>
              <div className="spec-row">
                <dt>Track length</dt>
                <dd>Up to {MAX_TRACK_MIN}&nbsp;minutes. Longer tracks are not supported: the chord track and the player both stop there.</dd>
              </div>
              <div className="spec-row">
                <dt>Where it runs</dt>
                <dd>Chrome, on a desktop. Other browsers and phones are not supported yet.</dd>
              </div>
              <div className="spec-row">
                <dt>Account</dt>
                <dd>
                  Required. Sign in with an email and a password, or ask for a one-time link by email, on the{' '}
                  <a href="/login">sign-in page</a>.
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
                    <dt>Supported length</dt>
                    <dd>Up to {MAX_TRACK_MIN}&nbsp;minutes</dd>
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
                  <p>Demucs splits it into drums, bass, vocals, guitar, keys and other — the six channels of the mixer.</p>
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
                  <PipeCutArt />
                  <p className="mono pipe-meta">drums · 8 bars · the loop file below</p>
                </div>
                <div className="pipe-text">
                  <p>
                    The stems load into the player with the chord track over them. The same job also cuts bar-length loops
                    from each stem, which is what the art beside this shows.
                  </p>
                  <dl className="kv">
                    <dt>Player</dt>
                    <dd>6 faders, mute, solo, section loop</dd>
                    <dt>Loops</dt>
                    <dd>1, 2, 4 or 8 bars, up to 10 per stem</dd>
                    <dt>Loop files</dt>
                    <dd>24-bit WAV, 44.1&nbsp;kHz</dd>
                  </dl>
                </div>
              </li>
            </ol>
            <p className="pipe-foot">While it runs, the job page shows each stage: downloading, separating, extracting, uploading.</p>
          </div>
        </section>

        {/* 5. THE LOOPS: the second product, kept and demoted (Story 6) */}
        <section className="section" id="loops" aria-labelledby="out-h">
          <div className="container">
            <div className="reading">
              <h2 id="out-h">You can still take the loops home</h2>
              <p className="body-lg">
                Every job cuts bar-length loops as well, for anyone who came here to build a sample folder rather than to
                practise. This is the 8&#8209;bar drums loop from our example song, unchanged, as you would download it:
                one 24&#8209;bit WAV per loop, named by stem, BPM, key estimate, section and number.
              </p>
            </div>
            <div className="take">
              <div className="file-card">
                <div className="file-text">
                  <p className="file-name">
                    lucky_<wbr />ticket_<wbr /><span className="fn-stem" data-stem="drums">drums</span>_<wbr />102.0bpm_<wbr />G_<wbr />minor_<wbr />verse_<wbr />0006.wav
                  </p>
                  <p className="mono file-meta">
                    <span className="tok">24&#8209;bit WAV ·</span> <span className="tok">44.1&nbsp;kHz ·</span>{' '}
                    <span className="tok">stereo ·</span> <span className="tok">8&nbsp;bars ·</span>{' '}
                    <span className="tok">18.82&nbsp;s ·</span> <span className="tok">4.8&nbsp;MB</span>
                  </p>
                  <p className="file-note">The key in the name is the tool’s estimate; another run of this song said G# minor.</p>
                </div>
                <DemoWavDownload />
                <p className="licence">Free to use in your own music. Credit appreciated: Lucky Ticket by Jon Cartwright.</p>
              </div>
              <AbCompare />
            </div>
          </div>
        </section>

        {/* 6. FAQ */}
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
                    until it sticks. The same job also leaves you a folder of bar-length loops to download.
                  </p>
                </details>
                <details>
                  <summary>Do I need an account?</summary>
                  <p>
                    Yes. You can sign in with an email and a password, or have a one-time link sent to your email, on the{' '}
                    <a href="/login">sign-in page</a>.
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
                    Our 3:34 example song took about 1–3 minutes (51 s to 3 min 7 s across four runs on 9 Oct 2026). Longer
                    tracks and a busy queue take longer. The job page shows each stage as it runs, with a timer.
                  </p>
                </details>
                <details>
                  <summary>How clean is the split?</summary>
                  <p>
                    Not perfect. Dense passages can leave a little bleed from other instruments in a stem. The
                    before-and-after above is a 4-bar MP3 crop of the tool’s real output, so you can judge for yourself.
                  </p>
                </details>
                <details id="faq-files">
                  <summary>What happens to my files?</summary>
                  <p>
                    Your link or file goes to our storage, and the audio goes to Replicate to run Demucs. Sources, stems and
                    loops are deleted after 24 hours. Anyone with a job’s link can open it, so don’t pass it around. More in
                    the <a href="/privacy">privacy notice</a>.
                  </p>
                </details>
                <details>
                  <summary>Can I use the loops commercially?</summary>
                  <p>
                    It depends on the source audio. Splitting a song doesn’t change who owns it. If it’s yours, or you hold the rights,
                    use the loops as you like. If it’s someone else’s recording, you need clearance before you release anything.
                    stem-loops doesn’t grant rights and can’t clear a sample. The demo drums file on this page is different: it is free
                    to use in your own music (credit to Lucky Ticket by Jon Cartwright is appreciated).
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
