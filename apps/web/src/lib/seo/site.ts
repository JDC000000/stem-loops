// SEO-04. Imports use relative paths WITH the .ts extension so `node --experimental-strip-types`
// can load this module straight from a test (node does not resolve the `@/` alias).
import { MAX_TRACK_SEC } from '../play/types.ts';

export const SITE_URL = 'https://stem-loops.com';
export const SITE_NAME = 'stem-loops';
export const OG_IMAGE = '/og-image-v4.png';
export const MAX_TRACK_MIN = Math.floor(MAX_TRACK_SEC / 60);
export const ENTITY_ONE_LINER =
  'stem-loops is a browser play-along tool: add a song and it opens in a player with six stems on faders, a chord track and section loops.';
export const ENTITY_LIMITS =
  `It runs in Chrome on the desktop, uses the first ${MAX_TRACK_MIN} minutes of any song and deletes files after 24 hours. ` +
  'You need an account to open the player, and the rights to the audio you add.';
// Filled only when each profile exists and returns 200 (SEO-22). Never list a profile that does not exist.
export const SAME_AS: string[] = [];
