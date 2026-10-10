// stem-loops home: the redesigned landing (prototype v4.1/v5 in
// documents/stem-loops-landing/prototype, reviewed by CRO/design/QA). Static sections are
// server-rendered; the tool, the example lanes and the players are client islands that
// share one DemoProvider.
import { DemoProvider } from '@/components/landing/DemoProvider';
import { ToolForm } from '@/components/landing/ToolForm';
import { Lanes } from '@/components/landing/Lanes';
import { AbCompare, DemoWavDownload, PipeCutArt, PipeSongArt, PipeStemsArt, ToInputLink } from '@/components/landing/DemoArt';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import { Ic } from '@/components/landing/Icons';
import type { Metadata } from 'next';

const OG_TITLE = 'Paste a song. Get bar-length loops.';
const OG_DESC = 'Stems split with Demucs, loops cut to 1, 2, 4 or 8 bars at the detected BPM. Free, 24-bit WAV, no account.';
const OG_ALT =
  'Four waveform lanes, drums, bass, vocals and guitar, with the first two of eight bars bracketed as the loop, under the headline Paste a song. Get bar-length loops.';

export const metadata: Metadata = {
  title: { absolute: 'stem-loops: split a song into stems and bar-length loops' },
  description:
    'Split a track into drums, bass, vocals, guitar and keys. Get 1, 2, 4 or 8-bar loops at the detected BPM as 24-bit WAV. Free, no account.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'stem-loops',
    url: '/',
    title: OG_TITLE,
    description: OG_DESC,
    images: [{ url: '/og-image.png', width: 1200, height: 630, alt: OG_ALT }],
  },
  twitter: { card: 'summary_large_image', title: OG_TITLE, description: OG_DESC, images: [{ url: '/og-image.png', alt: OG_ALT }] },
};

export default function HomePage() {
  return (
    <DemoProvider>
      <a className="skip" href="#tool">
        Skip to the tool
      </a>
      <SiteHeader />
      <main id="main">
        {/* 1. HERO: tool + lanes */}
        <section className="hero" aria-labelledby="h1">
          <div className="container hero-grid">
            <div className="hero-copy">
              <h1 id="h1">
                <span className="h1-line">Paste a song.</span> <span className="h1-line">Get bar&#8209;length loops.</span>
              </h1>
              <p className="lead">
                stem-loops splits a song into stems and cuts 1,&nbsp;2,&nbsp;4 or 8&#8209;bar 24&#8209;bit WAV loops at the detected BPM,
                for beats, practice tracks and sampling. Free, no account.
              </p>
            </div>
            <ToolForm />
            <Lanes />
          </div>
        </section>

        {/* 2. PIPELINE on the lane grid */}
        <section className="section" id="how" aria-labelledby="how-h">
          <div className="container">
            <div className="reading">
              <h2 id="how-h">From one song to a folder of loops</h2>
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
                  <p>A public YouTube link, or one audio or video file.</p>
                  <dl className="kv">
                    <dt>Files</dt>
                    <dd>mp3, wav, m4a, aac, flac, ogg, opus, aiff, mp4, m4v, mov, webm</dd>
                    <dt>Max upload</dt>
                    <dd>200&nbsp;MB</dd>
                    <dt>Shortest song</dt>
                    <dd>8 bars</dd>
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
                  <p>Demucs splits it into drums, bass, vocals, guitar, keys and other.</p>
                  <dl className="kv">
                    <dt>Stems</dt>
                    <dd>6, pick any</dd>
                    <dt>Model</dt>
                    <dd>Demucs htdemucs_6s on Replicate</dd>
                  </dl>
                </div>
              </li>
              <li className="pipe-row">
                <p className="pipe-name">Cut</p>
                <div className="pipe-art">
                  <PipeCutArt />
                  <p className="mono pipe-meta">drums · 8 bars · the file below</p>
                </div>
                <div className="pipe-text">
                  <p>
                    Tempo is detected from the drums, or the bass if you skipped drums. Bars are counted in 4/4 from the start of the
                    track, and each stem is cut into loops.
                  </p>
                  <dl className="kv">
                    <dt>Lengths</dt>
                    <dd>1, 2, 4 or 8 bars</dd>
                    <dt>Per stem</dt>
                    <dd>Up to 10 loops</dd>
                    <dt>Output</dt>
                    <dd>24-bit WAV, 44.1&nbsp;kHz</dd>
                    <dt>Download</dt>
                    <dd>Per loop, or all as a ZIP</dd>
                  </dl>
                </div>
              </li>
            </ol>
            <p className="pipe-foot">While it runs, the job page shows each stage: downloading, separating, extracting, uploading.</p>
          </div>
        </section>

        {/* 3. TAKE ONE HOME: the real deliverable + before/after */}
        <section className="section" id="output" aria-labelledby="out-h">
          <div className="container">
            <div className="reading">
              <h2 id="out-h">The file you get</h2>
              <p className="body-lg">
                The 8&#8209;bar drums loop from our example song, unchanged, as you would download it. Your loops come out the same
                way: one 24&#8209;bit WAV per loop, named by stem, BPM, key estimate, section and number.
              </p>
            </div>
            <div className="take">
              <div className="file-card">
                <div className="file-text">
                  <p className="file-name">
                    lucky_<wbr />ticket_<wbr />drums_<wbr />101.33bpm_<wbr />G#_<wbr />minor_<wbr />chorus_<wbr />0001.wav
                  </p>
                  <p className="mono file-meta">
                    <span className="tok">24&#8209;bit WAV ·</span> <span className="tok">44.1&nbsp;kHz ·</span>{' '}
                    <span className="tok">stereo ·</span> <span className="tok">8&nbsp;bars ·</span>{' '}
                    <span className="tok">18.95&nbsp;s ·</span> <span className="tok">4.8&nbsp;MB</span>
                  </p>
                  <p className="file-note">The key in the name is the tool’s estimate; another run of this song said G minor.</p>
                </div>
                <DemoWavDownload />
                <p className="licence">Free to use in your own music. Credit appreciated: Lucky Ticket by Jon Cartwright.</p>
              </div>
              <AbCompare />
            </div>
            <div className="again">
              <p className="again-text">Try it on your own track.</p>
              <ToInputLink className="btn btn-primary btn-again">
                <Ic name="up" />
                Go to the input
              </ToInputLink>
            </div>
          </div>
        </section>

        {/* 4. FAQ */}
        <section className="section" id="faq" aria-labelledby="faq-h">
          <div className="container">
            <h2 id="faq-h">Questions</h2>
            <div className="faq">
              <div className="faq-col">
                <details>
                  <summary>What is a bar-length loop?</summary>
                  <p>
                    A loop that is exactly 1, 2, 4 or 8 bars long at the tempo we detect. Bars are counted in 4/4 from the start of the
                    track, so a loop’s start may need a nudge in your DAW. Tempo is detected automatically and can sit a fraction off
                    the original, so check long loops by ear.
                  </p>
                </details>
                <details>
                  <summary>How long does it take?</summary>
                  <p>
                    Our 3:34 example song took about 1–3 minutes (51 s to 3 min 7 s across four runs on 9 Oct 2026). Longer tracks and
                    a busy queue take longer. The job page shows each stage as it runs, with a timer.
                  </p>
                </details>
                <details id="faq-files">
                  <summary>What happens to my files?</summary>
                  <p>
                    Your link or file goes to our storage, and the audio goes to Replicate to run Demucs. Sources and loops are deleted
                    after 24 hours. There are no accounts; recent jobs are remembered in your browser. Anyone with a job’s link can
                    open it, so don’t pass it around. More in the <a href="/privacy">privacy notice</a>.
                  </p>
                </details>
                <details>
                  <summary>How clean is the split?</summary>
                  <p>
                    Not perfect. Dense passages can leave a little bleed from other instruments in a stem. The before-and-after above
                    is a 4-bar MP3 crop of the tool’s real output, so you can judge for yourself.
                  </p>
                </details>
              </div>
              <div className="faq-col">
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
                  <p>
                    Yes, with public videos on youtube.com or youtu.be, including Shorts and YouTube Music links. Playlists, private,
                    age-restricted and live videos don’t work. YouTube sometimes blocks automated fetches; if it does, try again in a
                    few minutes or upload the file.
                  </p>
                </details>
                <details>
                  <summary>How accurate is the BPM?</summary>
                  <p>
                    Close. On the example above we detected 101.3 BPM; an independent beat tracker (librosa) measures 102.0. Detection
                    can also land on half or double time, and there’s no manual override, so check it by ear.
                  </p>
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
