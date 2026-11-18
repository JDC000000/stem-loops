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
// v8 (2026-11-17, Slice 1b, design v1.4 P7): less copy. The 8-row spec sheet became the ~70-word
// "What you get" block (components/landing/what-you-get.ts), the FAQ is five questions with the
// rest on /help (components/landing/faq.tsx), and no implementation names are on the page.
// The tempo/pitch gap is still stated, as "Coming soon", never as something you can do today.
//
// Static sections are server-rendered; the tool, the example lanes and the players are client
// islands that share one DemoProvider. The hero's example (Lanes) still frames itself around
// the loop cut: it is the demo-asset contract and its own measured copy, so it is left alone
// here and tracked as a follow-up.
import { DemoProvider } from '@/components/landing/DemoProvider';
import { ToolForm } from '@/components/landing/ToolForm';
import { HomeDemo } from '@/components/landing/HomeDemo';
import { Lanes } from '@/components/landing/Lanes';
import { AbCompare, PipeSongArt, PipeStemsArt, ToInputLink } from '@/components/landing/DemoArt';
import { PlayerArt } from '@/components/landing/PlayerArt';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import { Ic } from '@/components/landing/Icons';
import type { Metadata } from 'next';
import { YOUTUBE_INPUT_ENABLED } from '@/lib/public-config';
import { FaqItem, HOME_FAQ } from '@/components/landing/faq';
import { COMING_SOON, WHAT_YOU_GET } from '@/components/landing/what-you-get';
import { CHORDS_LINE_SHOWN } from '@/lib/chords-claim';
import { MAX_TRACK_SEC } from '@/lib/play/types';
import { JsonLd } from '@/components/seo/JsonLd';
import { homeGraph } from '@/lib/seo/jsonld';
import { pageFor } from '@/lib/seo/pages';
import { OG_ALT, OG_IMAGE } from '@/lib/seo/site';

// Story 1.4 (revised 2026-11-14): any song is accepted and its FIRST MAX_TRACK_MIN minutes are
// used — a longer track is trimmed on our end and still converted. The copy says the figure in minutes,
// derived from the same constant the player enforces, so the two can never drift apart.
const MAX_TRACK_MIN = Math.floor(MAX_TRACK_SEC / 60);

const OG_TITLE = 'Paste a song. Play along.';
// Every chord claim on this page depends on CHORDS_LINE_SHOWN (DB-17, lib/chords-claim.ts).
const OG_DESC = CHORDS_LINE_SHOWN
  ? 'Six stems with faders, mute and solo, and a chord track that moves with the song. Loop a detected section until you have it.'
  : 'Six stems with faders, mute and solo. Loop a detected section until you have it.';
// The image and its alt text are switched together in lib/seo/site.ts (DB-17).

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
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: OG_ALT }],
  },
  twitter: { card: 'summary_large_image', title: OG_TITLE, description: OG_DESC, images: [{ url: OG_IMAGE, alt: OG_ALT }] },
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
                {CHORDS_LINE_SHOWN
                  ? 'Six stems on faders, with the chords running over the top. Turn your part down and play it yourself.'
                  : 'Six stems on faders. Turn your part down and play it yourself.'}
              </p>
              <p className="audience">
                Uses the first {MAX_TRACK_MIN}&nbsp;minutes of any song, on a computer or a phone. Starting a job needs no account;
                opening the player needs one.
              </p>
            </div>
            {/* Slice 2a (design P4.1 item 2): the live play-along demo, signed out, near the
                top. A static poster until Play is tapped (P4.2); components/landing/HomeDemo.tsx. */}
            <HomeDemo />
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
                {CHORDS_LINE_SHOWN
                  ? 'When a job finishes it opens a player in the same tab: the chords across the top, the six stems on faders underneath, and a loop you can set on any detected section of the song.'
                  : 'When a job finishes it opens a player in the same tab: the six stems on faders, and a loop you can set on any detected section of the song.'}
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

        {/* 3. WHAT YOU GET (design v1.4, P7): ~70 words, true today. The lines live in
            components/landing/what-you-get.ts; the DB-17 switch is lib/chords-claim.ts. */}
        <section className="section" id="scope" aria-labelledby="scope-h">
          <div className="container">
            <div className="reading">
              <h2 id="scope-h">What you get</h2>
              <ul className="wyg" data-testid="what-you-get">
                {WHAT_YOU_GET.map((l) => (
                  <li key={l.key} data-line={l.key}>
                    <strong>{l.lead}</strong>
                    {l.rest}
                  </li>
                ))}
              </ul>
              <p className="wyg-soon" data-testid="coming-soon">
                <strong>Coming soon:</strong> {COMING_SOON.charAt(0).toLowerCase() + COMING_SOON.slice(1)}
              </p>
              <p className="body-lg more-link">
                <a href="/pricing">See the monthly song limits →</a>
              </p>
            </div>
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
                    <dd>
                      The first {MAX_TRACK_MIN}&nbsp;minutes. A longer song is trimmed on our end,{' '}
                      {CHORDS_LINE_SHOWN ? 'where the chord track and the player both stop.' : 'where the player stops.'}
                    </dd>
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
                  <p>We split it into drums, bass, guitar, keys, vocals and other — the six channels of the mixer.</p>
                  <dl className="kv">
                    <dt>Stems</dt>
                    <dd>6, pick any</dd>
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
                    {CHORDS_LINE_SHOWN
                      ? 'The stems load into the player with the chord track over them. '
                      : 'The stems load into the player. '}
                    Pull your part down, solo the one you are learning, or loop a section until it sticks.
                  </p>
                  <dl className="kv">
                    <dt>Player</dt>
                    <dd>6 faders, mute, solo, section loop</dd>
                    {CHORDS_LINE_SHOWN && (
                      <>
                        <dt>Chords</dt>
                        <dd>An estimate, kept in time with the song</dd>
                      </>
                    )}
                  </dl>
                </div>
              </li>
            </ol>
            <p className="pipe-foot">While it runs, the job page shows each stage: fetching, separating, finding bars, saving.</p>
          </div>
        </section>

        {/* 5. FAQ: five questions (P7: home FAQ ≤ 5). Every answer, these included, is on /help. */}
        <section className="section" id="faq" aria-labelledby="faq-h">
          <div className="container">
            <h2 id="faq-h">Questions</h2>
            <div className="faq">
              <div className="faq-col">
                {HOME_FAQ.slice(0, 3).map((e) => <FaqItem key={e.id} entry={e} />)}
              </div>
              <div className="faq-col">
                {HOME_FAQ.slice(3).map((e) => <FaqItem key={e.id} entry={e} />)}
              </div>
            </div>
            <p className="faq-more more-link">
              <a href="/help">More questions and answers →</a>
            </p>
          </div>
        </section>
      </main>
      <SiteFooter onLanding />
    </DemoProvider>
  );
}
