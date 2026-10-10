// Shared upload validation — accepted formats + size cap (V2 primary input).
// The worker ffmpeg-normalizes any accepted container to WAV before separation,
// so audio AND video files are supported.

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB — real songs (esp. uncompressed WAV/FLAC) run 40-100+ MB

// ext → content-type. Audio + common video containers (audio is extracted).
export const ACCEPTED_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

export const ACCEPT_ATTR = Object.keys(ACCEPTED_TYPES)
  .map((e) => `.${e}`)
  .join(',');

export function extOf(filename: string): string {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

export type UploadValidation =
  | { ok: true; ext: string; contentType: string }
  | { ok: false; error_code: 'UPLOAD_INVALID' | 'UPLOAD_TOO_LARGE'; message: string };

export function validateUpload(filename: string, size: number): UploadValidation {
  const ext = extOf(filename);
  if (!ext || !(ext in ACCEPTED_TYPES)) {
    return {
      ok: false,
      error_code: 'UPLOAD_INVALID',
      message: 'Unsupported file type. Upload an audio or video file (mp3, wav, m4a, flac, ogg, mp4, mov).',
    };
  }
  if (!size || size <= 0) {
    return { ok: false, error_code: 'UPLOAD_INVALID', message: 'That file appears to be empty.' };
  }
  if (size > MAX_UPLOAD_BYTES) {
    return { ok: false, error_code: 'UPLOAD_TOO_LARGE', message: 'That file is too large. Maximum is 200 MB.' };
  }
  return { ok: true, ext, contentType: ACCEPTED_TYPES[ext] };
}

/**
 * The only upload key POST /api/uploads ever issues: `{jobId}/_input.{ext}` with a lowercase
 * jobId and an accepted extension. POST /api/jobs requires an EXACT match, so a client can't
 * point a job at another object ('../', extra segments, uppercase, odd extensions). The
 * retention sweep deletes a job's files by the `{jobId}/` prefix, so this also guarantees
 * the source file is always swept with the job.
 */
export function isValidUploadKey(jobId: string, uploadKey: string): boolean {
  const m = /^([^/]+)\/_input\.([a-z0-9]+)$/.exec(uploadKey);
  return !!m && m[1] === jobId.toLowerCase() && Object.prototype.hasOwnProperty.call(ACCEPTED_TYPES, m[2]);
}
