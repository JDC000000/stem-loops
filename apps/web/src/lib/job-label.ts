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
