// A song's thumbnail (design v1.4, P5.1: "Thumbnail now, free").
//
// The video id is DERIVED from the stored canonical `youtube_url` — no network call and no
// database write. `jobs.video_id` is empty on recent rows, so it is used only when it is
// present and well-formed. Uploads have no thumbnail.
//
// The URL is built only from an id that has passed the 11-character YouTube id pattern, so
// nothing from the database can steer the image request anywhere but i.ytimg.com. The CSP's
// img-src must allow that origin (test/csp-headers.test.mjs pins it).
//
// Pure and dependency-free apart from youtube-url.ts, so the tests load it directly.
import { canonicalizeYoutubeUrl } from './youtube-url.ts';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** The one origin song thumbnails are loaded from. */
export const YT_THUMB_ORIGIN = 'https://i.ytimg.com';

/** The 11-character video id of a YouTube link, or null. */
export function youtubeVideoId(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  const canonical = canonicalizeYoutubeUrl(url);
  if (!canonical) return null;
  const id = new URL(canonical).searchParams.get('v');
  return id && VIDEO_ID_RE.test(id) ? id : null;
}

export type ThumbFields = { video_id?: string | null; youtube_url?: string | null };

/** `https://i.ytimg.com/vi/<id>/mqdefault.jpg` (320x180) for a linked song, else null. */
export function songThumbnailUrl(j: ThumbFields): string | null {
  const stored = typeof j.video_id === 'string' && VIDEO_ID_RE.test(j.video_id) ? j.video_id : null;
  const id = stored ?? youtubeVideoId(j.youtube_url);
  return id ? `${YT_THUMB_ORIGIN}/vi/${id}/mqdefault.jpg` : null;
}
