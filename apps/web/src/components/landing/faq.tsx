// The questions and answers, in ONE place (design v1.4, P7: "Home-page FAQ ≤ 5; the rest on
// a Help page"). The home page renders HOME_FAQ — five of them — and links to /help, which
// renders every entry. Each answer is written once, so the two pages cannot disagree.
//
// Copy rules (P7, "Copy rules for the whole site"): no implementation names (the separation
// model, its host, mono, sample rates) — the privacy notice names the outside services, as
// it must, and the answers point there.
import type { ReactNode } from 'react';
import { YOUTUBE_INPUT_ENABLED } from '@/lib/public-config';
import { CHORDS_LINE_SHOWN } from '@/lib/chords-claim';

export type FaqEntry = { id: string; q: string; a: ReactNode };

export const FAQ: Record<string, FaqEntry> = {
  get: {
    id: 'faq-get',
    q: 'What do I actually get?',
    a: (
      <p>
        A player, in your browser, with the song’s six stems on their own faders and a chord track running above them.
        Mute the guitar and play the guitar part; solo the bass to work it out; loop the chorus until it sticks.
      </p>
    ),
  },
  account: {
    id: 'faq-account',
    q: 'Do I need an account?',
    a: (
      <p>
        Not to start one. Running a job works signed out. The player asks you to sign in — that is where{' '}
        {CHORDS_LINE_SHOWN ? 'the stems and the chord track are shown' : 'the stems are shown'}. If you are new, you create an account on the <a href="/login">sign-in page</a>. A
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
        Chrome on a computer, which is what the player is built and tested against. On a phone the player loads lighter
        audio so all six stems fit in memory. Phone support is new, and other browsers are not tested yet.
      </p>
    ),
  },
  tempo: {
    id: 'faq-tempo',
    q: 'Can I slow a song down, or change its key?',
    a: (
      <p>
        Not yet. Playing a track slower without dropping its pitch is next, and a capo or key change follows it. Today
        the song plays at its own tempo in its own key.
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
  time: {
    id: 'faq-time',
    q: 'How long does it take?',
    a: (
      <p>
        Our 3:34 example song took about 1–3 minutes (0:51 to 3:07 across four runs on 9 October 2026). Longer tracks and
        a busy queue take longer. The job page shows each stage as it runs, with a timer.
      </p>
    ),
  },
  split: {
    id: 'faq-split',
    q: 'How clean is the split?',
    a: (
      <p>
        Not perfect. Dense passages can leave a little bleed from other instruments in a stem. The before-and-after on
        the home page is a 4-bar MP3 crop of the tool’s real output, so you can judge for yourself.
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
        {CHORDS_LINE_SHOWN
          ? 'Your link or file goes to our storage, and the audio goes to two outside services: one splits it into stems, one estimates the chords.'
          : 'Your link or file goes to our storage, and the audio goes to the outside services named in the privacy notice for processing.'}{' '}
        Sources, stems and loops are deleted after 24 hours. With a subscription, the songs in your
        account are kept as a library while you subscribe, and for 30 days after it ends. Anyone holding the link to a
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
        file. A linked song counts toward your monthly songs, just like an upload.
      </p>
    ) : (
      <p>Not right now: YouTube links are paused. Upload the audio or video file instead.</p>
    ),
  },
};

/** The home page's five (P7: "Home-page FAQ ≤ 5"). Everything is on /help. */
// DB-17 (lib/chords-claim.ts): with the chords switch off, the chords question leaves the home
// page (it stays on /help, which answers it honestly either way).
export const HOME_FAQ: readonly FaqEntry[] = CHORDS_LINE_SHOWN
  ? [FAQ.account, FAQ.chords, FAQ.time, FAQ.files, FAQ.youtube]
  : [FAQ.account, FAQ.time, FAQ.files, FAQ.youtube];

/** /help, grouped. Every entry appears exactly once. */
export const HELP_SECTIONS: readonly { heading: string; entries: readonly FaqEntry[] }[] = [
  { heading: 'Getting started', entries: [FAQ.get, FAQ.account, FAQ.youtube, FAQ.browsers, FAQ.time] },
  { heading: 'Playing along', entries: [FAQ.chords, FAQ.split, FAQ.tempo] },
  { heading: 'Your songs', entries: [FAQ.files, FAQ.rights] },
];

/** One question, as a native disclosure. The markup the landing tests read. */
export function FaqItem({ entry }: { entry: FaqEntry }) {
  return (
    <details id={entry.id}>
      <summary>{entry.q}</summary>
      {entry.a}
    </details>
  );
}
