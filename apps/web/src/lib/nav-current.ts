// Which site-nav item is "current" for a path (components/chrome/SignedInNav.tsx). Pure and
// client-safe so the rules can be unit-tested without rendering the bar.
//
// Set lists (#322; Phase B, B2 follow-up) have no item of their own: the phone bar is three
// items by design (A4: Play · Songs · Account), and a set list is a list of songs from the
// song library. So /sets and /sets/<id> mark "Song library" (Songs on a phone) as current.

/** `p` is `root` itself or a page under it (`/sets/x`, never `/setsx`). */
export function isAtOrUnder(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

/** The pages the "Song library" item is current on: the library and the set-list pages. */
export function isSongLibraryPath(p: string): boolean {
  return p === '/history' || isAtOrUnder(p, '/sets');
}
