// The three demo songs (design v1.5 P3.1 / v1.5 decisions table): Jon's own recordings, by
// The Royal Sundowners; rights recorded in docs/legal/demo-songs-rights.md (DB-16).
//
// CLIENT-SAFE: no ids that grant anything, no I/O. The home page's static poster renders
// from this list, so the page makes no database call until a visitor taps Play (P4.2).
//
// `idPrefix` is the first 8 hex digits of the prod job id, as recorded in LEDGER-17 and
// TSD-V3-DELTA §12.11 (the full UUIDs are not written in any repo document). The server
// resolves a slug to a job ONLY among `is_demo` rows (lib/demo-songs.ts), so a prefix can
// never select an ordinary job. BPM and key are the values Jon confirmed (2026-11-17) and
// that the prod rows now carry; the player shows the row's own values, these are for the
// poster only.
export interface DemoSong {
  readonly slug: string;
  readonly idPrefix: string;
  readonly title: string;
  readonly artist: string;
  readonly bpm: number;
  readonly musicalKey: string;
}

export const DEMO_ARTIST = 'The Royal Sundowners';

export const DEMO_SONGS: readonly DemoSong[] = [
  { slug: 'lucky-ticket', idPrefix: '9c5ba587', title: 'Lucky Ticket', artist: DEMO_ARTIST, bpm: 102, musicalKey: 'A major' },
  { slug: 'im-asking-you', idPrefix: '32f99278', title: 'I’m Asking You', artist: DEMO_ARTIST, bpm: 128, musicalKey: 'A minor' },
  { slug: 'offline', idPrefix: '3d43d743', title: 'Offline', artist: DEMO_ARTIST, bpm: 95, musicalKey: 'G major' },
];

/** The demo route for a slug: signed-out friendly, shareable. */
export function demoHref(slug: string): string {
  return `/demo/${encodeURIComponent(slug)}`;
}

export function demoBySlug(slug: string): DemoSong | null {
  return DEMO_SONGS.find((d) => d.slug === slug) ?? null;
}

/** The catalog entry whose id prefix matches a job id, if any. */
export function demoForJobId(jobId: string): DemoSong | null {
  const id = jobId.toLowerCase();
  return DEMO_SONGS.find((d) => id.startsWith(`${d.idPrefix}-`)) ?? null;
}
