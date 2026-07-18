// QA fix (stem-loops-youtube-v2-prod-qa-report, P2/UX #3 + P3 #5): shared client+server
// YouTube URL validator, so the two never drift. The old inline regex
// (`^https?://(www\.|m\.)?(youtube\.com/watch\?|youtu\.be/)`) rejected real links users
// paste all the time — Shorts, YouTube Music, /live/, /embed/ — even though yt-dlp
// handles all of them fine; it was also "shallow": `youtu.be/` or `youtube.com/watch?`
// with NO id still matched, creating a job that was guaranteed to fail at download.
//
// This validates an actual 11-char video ID is present and returns the CANONICAL
// `https://www.youtube.com/watch?v=ID` form (also matches the TSD's original T8 intent
// to canonicalize + strip extraneous params before persisting/enqueuing).
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

export function canonicalizeYoutubeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();
  let id: string | null = null;

  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0] || null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const m = url.pathname.match(/^\/(shorts|live|embed)\/([^/]+)/);
      if (m) id = m[2];
    }
  } else {
    return null;
  }

  if (!id || !VIDEO_ID_RE.test(id)) return null;
  return `https://www.youtube.com/watch?v=${id}`;
}
