// Shared upload validation — accepted formats + size cap (V2 primary input).
// The worker ffmpeg-normalizes any accepted container to WAV before separation,
// so audio AND video files are supported.

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

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
    return { ok: false, error_code: 'UPLOAD_TOO_LARGE', message: 'That file is too large. Maximum is 50 MB.' };
  }
  return { ok: true, ext, contentType: ACCEPTED_TYPES[ext] };
}
