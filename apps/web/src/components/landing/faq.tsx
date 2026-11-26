// The questions and answers, in ONE place (design v1.4, P7: "Home-page FAQ ≤ 5; the rest on
// a Help page"). The home page renders HOME_FAQ — five of them — and links to /help, which
// renders every entry. Each answer is written once, so the two pages cannot disagree.
//
// Copy rules (P7, "Copy rules for the whole site"): no implementation names (the separation
// model, its host, mono, sample rates) — the privacy notice names the outside services, as
// it must, and the answers point there.
import type { ReactNode } from 'react';
import { YOUTUBE_INPUT_ENABLED } from '@/lib/public-config';
import { chordsLineShown } from '@/lib/chords-claim';

export type FaqEntry = { id: string; q: string; a: ReactNode };

/**
 * Every entry, built for one value of the DB-17 chords switch (lib/chords-claim.ts). A function,
 * not a module constant: the switch is read when the page renders (at build for the static pages).
 */
export function faqEntries(chords: boolean = chordsLineShown()): Record<string, FaqEntry> {
  return {
  get: {
    id: 'faq-get',
    q: 'What do I actually get?',
    a: (
      <p>
        {chords
          ? 'A player, in your browser, with the song’s six stems on their own faders and a chord track running above them.'
          : 'A player, in your browser, with the song’s six stems on their own faders.'}{' '}
        Mute the guitar and play the guitar part; solo the bass to work it out; loop the chorus until it sticks.
      </p>
    ),
  },
  account: {
    id: 'faq-account',
    q: 'Do I need an account?',
    a: (
      <p>
        To play your own songs, yes: a free one. When you paste a link signed out, you sign in first and the song
        starts as soon as you are in. A file you upload starts straight away and asks you to sign in when its player
        opens. The demo songs open without signing in. To open your own songs you sign in, which is where{' '}
        {chords ? 'the stems and the chord track are shown' : 'the stems are shown'}. If you are new, you create an account on the <a href="/login">sign-in page</a>. A
        one-time link sent to your email only signs you back in to an account that already exists; it does not create
        one.
      </p>
    ),
  },
  browsers: {
    id: 'faq-browsers',
    q: 'Which browsers work?',
    a: (
      <p>
        Your phone or your computer: the player is built for both, and tested in Chrome. On a phone it loads lighter
        audio so all six stems fit in memory. Other browsers are not tested yet.
      </p>
    ),
  },
  tempo: {
    id: 'faq-tempo',
    q: 'Can I slow a song down, or change its key?',
    a: (
      // QW-4: both are in the player's ⋯ (More) menu today. Speed: components/play/PlayerScreen.tsx
      // (1, 0.9, 0.75, pitch kept; absent where the browser cannot stretch audio). Capo / transpose:
      // components/play/TransposeMenuItem.tsx, chord names only, shown when the song has chords
      // (so it leaves this answer with the DB-17 switch off).
      <p>
        Slow it down, yes: in the player’s ⋯ menu, Speed (Beta) plays the song at 90% or 75% without
        changing its pitch, in browsers that can do it.
        {chords
          ? ' The same menu has Capo / transpose, which moves the chord names to a capo or another key; the audio itself stays in its own key.'
          : ' Changing the key is not offered: the song plays in its own key.'}
      </p>
    ),
  },
  chords: {
    id: 'faq-chords',
    q: 'How good are the chords?',
    a: (
      <p>
        Good enough to play along to on most songs, and wrong often enough that you should trust your ears over the
        screen. They are an estimate made from the audio, not a transcription someone checked.
      </p>
    ),
  },
  // #379 item 3 (Jon, S22): pickup songs are a known limit. Bar 1 is placed on the first strong
  // beat found, with no downbeat model, so a song that opens with a pickup can number its bars early.
  pickup: {
    id: 'faq-pickup',
    q: 'Why does bar 1 start early on some songs?',
    a: (
      <p>
        Songs that start with a pickup (a few notes before the first full bar) may show bar 1 a beat or two early; the
        chords still follow the music.
      </p>
    ),
  },
  time: {
    id: 'faq-time',
    q: 'How long does it take?',
    a: (
      <p>
        {/* C-14 (QA 2026-11-18): the old "about 1–3 minutes" was measured on 9 October 2026, before
            the chord stage (2026-11-04) and six-stem Opus encode + upload (2026-11-10), and no
            measurement of the current pipeline is in the repo. So no figure is promised here. The
            only later timings on record are three YouTube jobs on 2026-11-17 (2m19s, 2m42s, 2m26s;
            Project doc LEDGER-17, 17:37Z), which supports "a few minutes" and nothing tighter. */}
        Usually a few minutes. It depends on how long the song is and how busy the queue is. The job page shows each
        stage as it runs, with a timer.
      </p>
    ),
  },
  split: {
    id: 'faq-split',
    q: 'How clean is the split?',
    a: (
      <p>
        Not perfect. Dense passages can leave a little bleed from other instruments in a stem. The demo songs on the
        home page are the tool’s real output: solo a part and judge for yourself.
      </p>
    ),
  },
  files: {
    id: 'faq-files',
    q: 'What happens to my files?',
    a: (
      <p>
        {/* DB-17: with the chords switch off this stays a full disclosure (it names no feature, and
            the privacy notice lists every processor) rather than dropping a service silently. */}
        {chords
          ? 'Your link or file goes to our storage, and the audio goes to two outside services: one splits it into stems, one estimates the chords.'
          : 'Your link or file goes to our storage, and the audio goes to the outside services named in the privacy notice for processing.'}{' '}
        {/* Source of truth: 24 hours = RETENTION_HOURS, 30 days = PAID_RETENTION_GRACE_DAYS
            (lib/retention.ts; migration 007). Pinned by test/chords-switch-surfaces.test.mjs. */}
        Sources, stems and loops are deleted after 24 hours. With a subscription, the songs in your
        account are kept as a library while you subscribe, and for 30 days after it ends. When a song’s audio is
        deleted, your library keeps its title, BPM and key (never the audio) so you can make it again. Anyone holding the link to a
        job you start without an account can fetch its audio and stems, so don’t pass that link around. A job you start
        while signed in opens only for your account. More in the <a href="/privacy">privacy notice</a>.
      </p>
    ),
  },
  rights: {
    id: 'faq-rights',
    q: 'Can I use the stems in my own music?',
    a: (
      <p>
        It depends on the source audio. Splitting a song doesn’t change who owns it. If it’s yours, or you hold the
        rights, use it as you like. If it’s someone else’s recording, practising along to it is one thing; releasing
        anything made from it needs clearance first. We don’t grant rights and can’t clear a sample.
      </p>
    ),
  },
  youtube: {
    id: 'faq-youtube',
    q: 'Does it work with YouTube links?',
    a: YOUTUBE_INPUT_ENABLED ? (
      <p>
        Yes, with public videos on youtube.com or youtu.be, including Shorts and YouTube Music links. Playlists, private,
        age-restricted and live videos don’t work. If YouTube blocks a fetch, try again in a few minutes or upload the
        file. A song you add from a link uses 1 of your monthly songs.
      </p>
    ) : (
      <p>Not right now: YouTube links are paused. Upload the audio or video file instead.</p>
    ),
  },
  };
}

/** The home page's five (P7: "Home-page FAQ ≤ 5"). Everything is on /help. */
// DB-17 (lib/chords-claim.ts): with the chords switch off, the chords question leaves the home
// page (and /help: see helpSections).
export function homeFaq(chords: boolean = chordsLineShown()): readonly FaqEntry[] {
  const FAQ = faqEntries(chords);
  return chords ? [FAQ.account, FAQ.chords, FAQ.time, FAQ.files, FAQ.youtube] : [FAQ.account, FAQ.time, FAQ.files, FAQ.youtube];
}

/** /help, grouped. Every entry appears exactly once. */
// DB-17: with the chords switch off, "How good are the chords?" leaves /help as well — the
// question itself presents a chord track as part of what a new song gets. The pickup answer
// (#379 item 3) talks about the chords too, so it leaves with it.
export function helpSections(chords: boolean = chordsLineShown()): readonly { heading: string; entries: readonly FaqEntry[] }[] {
  const FAQ = faqEntries(chords);
  return [
    { heading: 'Getting started', entries: [FAQ.get, FAQ.account, FAQ.youtube, FAQ.browsers, FAQ.time] },
    { heading: 'Playing along', entries: chords ? [FAQ.chords, FAQ.pickup, FAQ.split, FAQ.tempo] : [FAQ.split, FAQ.tempo] },
    { heading: 'Your songs', entries: [FAQ.files, FAQ.rights] },
  ];
}

/** One question, as a native disclosure. The markup the landing tests read. */
export function FaqItem({ entry }: { entry: FaqEntry }) {
  return (
    <details id={entry.id}>
      <summary>{entry.q}</summary>
      {entry.a}
    </details>
  );
}
