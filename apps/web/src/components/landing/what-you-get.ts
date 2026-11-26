// "What you get" (design v1.4, P7; home page diet, A4 2026-11-21): THREE one-line proof points,
// TRUE ON THE DAY IT SHIPS. It replaced a six-line list, which replaced an 8-row spec sheet.
//
// Every line is a fact about the product today:
//   - chords in time: see the DB-17 switch (lib/chords-claim.ts). With the switch off the chords
//     line is replaced by the phone line, so the list is always three lines and never a chord claim;
//   - six stems with a fader, mute and solo each: the mixer (components/play);
//   - loop a section, or several in a row: section runs shipped in Slice 1a (#288, P2);
//   - phones: the phone player shipped in #278/#288 and loads lighter audio (lib/play/device-support.ts).
// The length cap, the account rule and the phone/computer scope are stated by the tool itself
// (components/landing/ToolForm.tsx, its note under the button) and in the FAQ.

/** One line: a bold lead, then the rest of the sentence. */
export type WhatYouGetLine = { key: string; lead: string; rest: string };

const CHORDS: WhatYouGetLine = { key: 'chords', lead: 'Chords', rest: ' in time with the song, with the next one shown. Auto-detected, so trust your ear.' };
const STEMS: WhatYouGetLine = { key: 'stems', lead: '6 stems', rest: ' — drums, bass, guitar, keys, vocals, other. Turn your part down, mute it or solo it.' };
const LOOP: WhatYouGetLine = { key: 'loop', lead: 'Loop', rest: ' any section — or several in a row.' };
const PHONE: WhatYouGetLine = { key: 'phone', lead: 'On your phone', rest: ' or your computer. Phones load lighter audio so all six stems fit.' };

/** The three proof points for one value of the DB-17 chords switch (read by the server page). */
export function whatYouGet(chordsShown: boolean): readonly WhatYouGetLine[] {
  return chordsShown ? [CHORDS, STEMS, LOOP] : [STEMS, LOOP, PHONE];
}

/**
 * QW-4 (QA 2026-11-26): what the player's ⋯ (More) menu adds, TRUE TODAY. It replaced a
 * "Coming soon: slow a song down" line that went false when both shipped with no flag:
 *   - Speed (Beta): PLAYBACK_RATES = 1, 0.9, 0.75 with the pitch kept (lib/play/engine.ts,
 *     lib/play/stretch.ts; the "Speed Beta" group in components/play/PlayerScreen.tsx);
 *   - Capo / transpose: components/play/TransposeMenuItem.tsx. It moves the chord NAMES only
 *     (display, lib/play/transpose.ts) and shows only when the song has chords, so with the
 *     DB-17 chords switch off that half of the line is dropped.
 */
export const IN_THE_PLAYER_LEAD = 'In the player\u2019s \u22ef menu:';
export function inThePlayer(chordsShown: boolean): string {
  return chordsShown
    ? 'slow down to 90% or 75%, same pitch (Beta), or set a capo.'
    : 'slow down to 90% or 75%, same pitch (Beta).';
}
