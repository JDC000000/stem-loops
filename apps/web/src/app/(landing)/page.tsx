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
// Static sections are server-rendered; the tool and the demo are client islands.
//
// v9 (2026-11-21, A4, Jon's J1 story: "on my mobile, take a YouTube link and put it in, and very
// quickly be able to listen and learn"): phone first. The paste form comes FIRST, above the demo,
// so its button is on the first screen of a 360x800 phone. The demo is shown ONCE (the drawn
// player, the example lanes and the demo's "own page" link are gone), the "From one song to a
// player" pipeline section is gone with its implementation detail, and "What you get" is three
// one-line proof points. The FAQ stays at five, plus the one line linking the plans.
//
// Every chord claim here reads the DB-17 switch (lib/chords-claim.ts) when the page is built.
import { ToolForm } from '@/components/landing/ToolForm';
import { HomeDemo } from '@/components/landing/HomeDemo';
import { SiteFooter, SiteHeader } from '@/components/landing/SiteChrome';
import type { Metadata } from 'next';
import { FaqItem, homeFaq } from '@/components/landing/faq';
import { COMING_SOON, whatYouGet } from '@/components/landing/what-you-get';
import { chordsLineShown } from '@/lib/chords-claim';
import { JsonLd } from '@/components/seo/JsonLd';
import { homeGraph } from '@/lib/seo/jsonld';
import { pageFor } from '@/lib/seo/pages';
import { ogAlt, ogImage } from '@/lib/seo/site';

// The length cap (Story 1.4) is stated by the tool's own note (ToolForm.tsx, from MAX_TRACK_SEC).
const OG_TITLE = 'Paste a song. Play along.';

// STATIC and CDN-cached (PR #332, round 2): no `dynamic` export. The DB-17 chord switch
// (lib/chords-claim.ts) is read when the page is BUILT; a Vercel env change needs a Redeploy,
// which rebuilds this page with the new value.

export function generateMetadata(): Metadata {
  // Every chord claim on this page depends on the switch (DB-17, lib/chords-claim.ts).
  const OG_DESC = chordsLineShown()
    ? 'Six stems with faders, mute and solo, and a chord track that moves with the song. Loop a detected section until you have it.'
    : 'Six stems with faders, mute and solo. Loop a detected section until you have it.';
  // The image and its alt text are switched together in lib/seo/site.ts (DB-17).
  const OG_IMAGE = ogImage();
  const OG_ALT = ogAlt();
  return {
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
}

export default function HomePage() {
  const chords = chordsLineShown();
  const faq = homeFaq(chords);
  return (
    <>
      <JsonLd data={homeGraph()} />
      <a className="skip" href="#tool">
        Skip to the tool
      </a>
      <SiteHeader />
      <main id="main">
        {/* 1. HERO: the promise, then the tool, then the one demo */}
        <section className="hero" aria-labelledby="h1">
          <div className="container hero-grid">
            <div className="hero-copy">
              <h1 id="h1">
                <span className="h1-line">Paste a song.</span> <span className="h1-line">Play along.</span>
              </h1>
              <p className="lead">
                {chords
                  ? 'The chords in time and every part on its own fader, on your phone or your computer.'
                  : 'Every part on its own fader, on your phone or your computer.'}
              </p>
            </div>
            <ToolForm />
            <HomeDemo chordsShown={chords} />
          </div>
        </section>

        {/* 2. WHAT YOU GET: three one-line proof points (components/landing/what-you-get.ts),
            the "Coming soon" disclosure, and the one line linking the plans. */}
        <section className="section" id="scope" aria-labelledby="scope-h">
          <div className="container">
            <div className="reading">
              <h2 id="scope-h">What you get</h2>
              <ul className="wyg" data-testid="what-you-get">
                {whatYouGet(chords).map((l) => (
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

        {/* 3. FAQ: five questions at most (P7). Every answer, these included, is on /help. */}
        <section className="section" id="faq" aria-labelledby="faq-h">
          <div className="container">
            <h2 id="faq-h">Questions</h2>
            <div className="faq">
              <div className="faq-col">
                {faq.slice(0, 3).map((e) => <FaqItem key={e.id} entry={e} />)}
              </div>
              <div className="faq-col">
                {faq.slice(3).map((e) => <FaqItem key={e.id} entry={e} />)}
              </div>
            </div>
            <p className="faq-more more-link">
              <a href="/help">More questions and answers →</a>
            </p>
          </div>
        </section>
      </main>
      <SiteFooter onLanding />
    </>
  );
}
