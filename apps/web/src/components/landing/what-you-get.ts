// "What you get" (design v1.4, P7): the home page's capabilities block, ~70 words, TRUE ON
// THE DAY IT SHIPS. It replaced an 8-row spec sheet of ~260 words.
//
// Every line is a fact about the product today:
//   - six stems with a mute each: the mixer (components/play);
//   - chords in time: see CHORDS_LINE_SHOWN (lib/chords-claim.ts);
//   - loop a section, or several in a row: section runs shipped in Slice 1a (#288, P2);
//   - the first MAX_TRACK_MIN minutes: the trim the worker and the player both enforce;
//   - Chrome on a computer, phones with lighter audio, phone support new;
//   - an account to PLAY (not to start): /jobs/[id] redirects a signed-out visitor.
//     Signed-out demo play is Slice 2; until it ships, this line stays.
import { MAX_TRACK_SEC } from '@/lib/play/types';

const MAX_TRACK_MIN = Math.floor(MAX_TRACK_SEC / 60);

// DB-17: the switch lives in lib/chords-claim.ts, the ONE place it is decided. Setting it to
// false drops this list's Chords line AND every other chord claim on the home page.
import { CHORDS_LINE_SHOWN } from '@/lib/chords-claim';
export { CHORDS_LINE_SHOWN };

/** One line: a bold lead, then the rest of the sentence. */
export type WhatYouGetLine = { key: string; lead: string; rest: string };

const ALL: readonly (WhatYouGetLine & { shown?: boolean })[] = [
  { key: 'stems', lead: '6 stems', rest: ' — drums, bass, guitar, keys, vocals, other. Mute any of them.' },
  { key: 'chords', lead: 'Chords', rest: ' in time with the song. Auto-detected, so trust your ear.', shown: CHORDS_LINE_SHOWN },
  { key: 'loop', lead: 'Loop', rest: ' any section — or several in a row.' },
  { key: 'length', lead: `First ${MAX_TRACK_MIN} minutes`, rest: ' of each song.' },
  { key: 'device', lead: 'Best in Chrome on a computer.', rest: ' Phones work too, with lighter audio; phone support is new.' },
  { key: 'account', lead: 'Free account', rest: ' needed to play.' },
];

export const WHAT_YOU_GET: readonly WhatYouGetLine[] = ALL.filter((l) => l.shown !== false).map(({ key, lead, rest }) => ({ key, lead, rest }));

/** Built-next, stated as such: never offered as something you can do today. */
export const COMING_SOON = 'Slow a song down without changing its pitch.';
