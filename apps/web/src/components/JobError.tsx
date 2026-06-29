// User-facing error copy, keyed by the typed error taxonomy (PRD §6.2).
// Rendered from this static map only — never interpolated from server state,
// never a stack trace. Mirrors apps/worker/src/worker/errors.py ERROR_COPY.
const ERROR_COPY: Record<string, { message: string; action: string }> = {
  DOWNLOAD_BLOCKED: { message: 'YouTube is temporarily blocking automated access for this video.', action: 'Try again in a few minutes.' },
  DOWNLOAD_TIMEOUT: { message: "We couldn't reach that video in time.", action: 'Check the link and try again.' },
  DOWNLOAD_INVALID_URL: { message: "That doesn't look like a YouTube link.", action: 'Paste a full youtube.com or youtu.be URL.' },
  DOWNLOAD_AGE_RESTRICTED: { message: "This video is age-restricted and can't be processed.", action: '' },
  DOWNLOAD_PRIVATE: { message: 'This video is private or unavailable.', action: '' },
  SEPARATION_FAILED: { message: 'Stem separation failed for this track.', action: 'Try a different song.' },
  EXTRACTION_FAILED: { message: "We couldn't find clean loops in this audio (it may be too short or beatless).", action: '' },
  UPLOAD_FAILED: { message: "We separated your stems but couldn't save them.", action: 'Please retry.' },
  RATE_LIMITED: { message: "We're busy or you've hit the limit.", action: 'Wait a moment and try again.' },
  INTERNAL_ERROR: { message: "Something went wrong on our end. We've logged it.", action: 'Please try again.' },
};

export function JobError({ errorCode }: { errorCode: string }) {
  const copy = ERROR_COPY[errorCode] ?? ERROR_COPY.INTERNAL_ERROR;
  return (
    <div role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p style={{ color: 'var(--status-failed)', fontSize: 18, fontWeight: 600, margin: 0 }}>
        {copy.message}
      </p>
      {copy.action && <p style={{ color: 'var(--text-muted)', margin: 0 }}>{copy.action}</p>}
      <a href="/" style={{ color: 'var(--accent)', minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
        Try another URL
      </a>
    </div>
  );
}
