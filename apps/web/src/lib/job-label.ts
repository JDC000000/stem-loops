// What to call a job in a list (e.g. /account "Recent jobs").
//
// `jobs.title` is only set by flows that know a human title; an upload job has
// title NULL and carries the name the user picked in `original_filename`
// (POST /api/jobs). Falling straight back to the job id showed users a UUID
// for every upload (W4 overnight browser journey j1, 2026-11-13). The job page
// itself already labels a job `original_filename ?? youtube_url` (JobView.tsx),
// so a list uses the same order, with the id only as a last resort.
//
// Pure and dependency-free so src/lib/job-label.test.mjs can load it directly.

export type JobLabelFields = {
  id: string;
  title?: string | null;
  original_filename?: string | null;
  youtube_url?: string | null;
};

const nonBlank = (s: string | null | undefined): string | null => {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t ? t : null;
};

export function jobLabel(j: JobLabelFields): string {
  return nonBlank(j.title) ?? nonBlank(j.original_filename) ?? nonBlank(j.youtube_url) ?? j.id;
}

// ─── the processing page's heading (QA A-04, 2026-11-18) ─────────────────────
// Before a link job has a title, the processing page put the RAW URL in a
// centred 2xl <h1> with no wrapping: "https://www.youtube.com/watch?v=…" ran
// off both edges at 390 px. Until the title is known the heading is now a
// short host/ID form ("youtube.com · dQw4w9WgXcQ"), never the URL itself, and
// never longer than SHORT_SOURCE_MAX characters. The title, once the worker
// has it, replaces it (the page re-polls the job).

/** The longest short host/ID form, in characters (an ellipsis included). */
export const SHORT_SOURCE_MAX = 40;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * A URL as "host · id": the host without "www."/"m.", then the YouTube video
 * id when there is one, else the first path segment. Bounded to
 * SHORT_SOURCE_MAX characters. Not a URL: the text itself, clipped.
 */
export function shortSource(raw: string): string {
  const s = raw.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    return clip(s, SHORT_SOURCE_MAX);
  }
  if (!u.hostname || !/^https?:$/.test(u.protocol)) return clip(s, SHORT_SOURCE_MAX);
  const host = u.hostname.toLowerCase().replace(/^(?:www|m)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.split('/')[1] || null;
  else if (u.pathname === '/watch') id = u.searchParams.get('v');
  else id = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1] ?? (u.pathname.split('/')[1] || null);
  const out = id ? `${host} · ${id}` : host;
  return clip(out, SHORT_SOURCE_MAX);
}

/**
 * The processing page's <h1>: the title when known, else the upload's file
 * name, else the link's short host/ID form, else "Your track". `isSource` is
 * true for the host/ID form, which the page draws smaller.
 */
export function processingHeading(j: Omit<JobLabelFields, 'id'>): { text: string; isSource: boolean } {
  const t = nonBlank(j.title) ?? nonBlank(j.original_filename);
  if (t) return { text: t, isSource: false };
  const url = nonBlank(j.youtube_url);
  if (url) return { text: shortSource(url), isSource: true };
  return { text: 'Your track', isSource: false };
}
