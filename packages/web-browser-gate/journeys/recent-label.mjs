// J1's "Recent jobs" check, as a pure predicate so test/recent-label.test.mjs can pin it without
// a browser or a stack.
//
// Slice 1b (P5.1): the worker stores the upload's title as its file name WITHOUT the extension,
// and jobLabel() prefers the title over original_filename. So on /account the job must read
// "journey-song-40s-120bpm", never its id — and never "journey-song-40s-120bpm.mp3": that is
// original_filename, which is exactly what the label falls back to if the worker stops writing
// jobs.title. Refusing ".mp3" (review round 2, SF-4) is what makes this a CI guard on the title
// write end to end; before it, the fallback passed too.
export const UPLOAD_STEM = /journey-song/;

export function recentListsUploadByTitle(recent, jobId) {
  const text = String(recent ?? '');
  return UPLOAD_STEM.test(text) && !/\.mp3/i.test(text) && !(jobId && text.includes(jobId));
}
