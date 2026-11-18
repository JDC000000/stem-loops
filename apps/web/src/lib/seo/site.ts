// SEO-04. Imports use relative paths WITH the .ts extension so `node --experimental-strip-types`
// can load this module straight from a test (node does not resolve the `@/` alias).
import { MAX_TRACK_SEC } from '../play/types.ts';
import { CHORDS_LINE_SHOWN } from '../chords-claim.ts';

export const SITE_URL = 'https://stem-loops.com';
export const SITE_NAME = 'stem-loops';
// DB-17 (lib/chords-claim.ts): v4 draws four chord names over the mixer, so it is a chord claim
// in its own right. With the switch off every page shares v3 instead (stems and a boxed loop, no
// chords), and OG_ALT below describes whichever image is in use.
export const OG_IMAGE = CHORDS_LINE_SHOWN ? '/og-image-v4.png' : '/og-image-v3.png';
export const OG_ALT = CHORDS_LINE_SHOWN
  ? 'Four chord names, Gm, E flat, B flat and F, above six mixer channels for drums, bass, guitar, keys, vocals and other, with the guitar fader pulled down and muted, under the headline Paste a song. Play along.'
  : 'Waveforms for four stems, drums, bass, vocals and guitar, with a four-bar loop boxed, under the headline Paste a song. Get bar-length loops.';
export const MAX_TRACK_MIN = Math.floor(MAX_TRACK_SEC / 60);
// DB-17 (lib/chords-claim.ts): no chord claim when the switch is off.
export const ENTITY_ONE_LINER = CHORDS_LINE_SHOWN
  ? 'stem-loops is a browser play-along tool: add a song and it opens in a player with six stems on faders, a chord track and section loops.'
  : 'stem-loops is a browser play-along tool: add a song and it opens in a player with six stems on faders and section loops.';
// The site-wide default <meta name="description"> (app/layout.tsx), for any route that sets none.
// DB-17: no chord claim when the switch is off.
export const SITE_DESCRIPTION = CHORDS_LINE_SHOWN
  ? `Split a song into six stems with faders and a chord track, and play along. Uses the first ${MAX_TRACK_MIN} minutes of any song, on a computer or a phone.`
  : `Split a song into six stems with faders, and play along. Uses the first ${MAX_TRACK_MIN} minutes of any song, on a computer or a phone.`;
// Source of truth for the figures below: 24 hours = RETENTION_HOURS (lib/retention.ts; jobs.expires_at
// default, migration 007); 30 days = PAID_RETENTION_GRACE_DAYS and the '30 days' interval in
// JOB_RETAINED_UNTIL_SQL (lib/retention.ts = worker cleanup.py RETAINED_UNTIL_SQL). Pinned by
// test/chords-switch-surfaces.test.mjs ("numeric claims").
export const ENTITY_LIMITS =
  `It is built and tested in Chrome on a computer and loads lighter audio on phones, uses the first ${MAX_TRACK_MIN} minutes of any song and, on the Free plan, deletes files after 24 hours ` +
  '(Pro and Studio keep a song library while subscribed, plus 30 days). ' +
  'You need an account to open the player, and the rights to the audio you add.';
// Filled only when each profile exists and returns 200 (SEO-22). Never list a profile that does not exist.
export const SAME_AS: string[] = [];
