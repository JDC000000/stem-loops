"""Typed error taxonomy (PRD §6.2) — single source of truth for all worker errors.

Every user-facing failure is one of these 9 typed classes. Each carries an
``error_code`` and a plain-English ``user_message`` (message + what-to-do-next) —
never a stack trace or raw stderr. The optional ``detail`` is for server-side
logging only and is NEVER surfaced to the client.

RATE_LIMITED is intentionally absent here: it is an admission-control decision
made on the web side before a job exists, not a worker pipeline error.
"""

from __future__ import annotations


class StemLoopsError(Exception):
    error_code: str = "INTERNAL_ERROR"
    user_message: str = "Something went wrong on our end. We've logged it — please try again."

    # Short machine-readable cause (e.g. 'poll_http_502', 'poll_budget_exhausted'), the same
    # string written to job_events.detail.reason. Server-side only: used as a Sentry tag,
    # never shown to the user. None when the raiser has nothing more specific than the code.
    failure_reason: str | None = None

    def __init__(self, detail: str | None = None, *, failure_reason: str | None = None):
        self.detail = detail
        if failure_reason is not None:
            self.failure_reason = failure_reason
        super().__init__(detail or self.user_message)


class DownloadBlockedError(StemLoopsError):
    error_code = "DOWNLOAD_BLOCKED"
    user_message = (
        "YouTube is temporarily blocking automated access for this video. "
        "Try again in a few minutes."
    )


class DownloadTimeoutError(StemLoopsError):
    error_code = "DOWNLOAD_TIMEOUT"
    user_message = "We couldn't reach that video in time. Check the link and try again."


class FetchPausedError(DownloadBlockedError):
    """SL21 kill switch (fetch_global / fetch_youtube) is engaged: no outbound fetch is made.
    Same error_code as its parent (still one of the typed classes); the message keeps the
    drop-a-file path in front of the user."""

    user_message = "YouTube links are paused right now. Upload the audio file instead."


class DownloadInvalidUrlError(StemLoopsError):
    error_code = "DOWNLOAD_INVALID_URL"
    user_message = (
        "That doesn't look like a YouTube link. Paste a full youtube.com or youtu.be link."
    )


class LiveStreamNotSupportedError(DownloadInvalidUrlError):
    """R2 addendum: a 24/7 live stream (e.g. lofi radio) has no fixed end — yt-dlp would
    otherwise try to download it indefinitely. Same error_code as its parent (still one of
    the 9 typed classes, no taxonomy expansion) with an accurate message: unlike a bad URL,
    the link IS a valid YouTube URL, it's just unsupported content."""

    user_message = "Live streams aren't supported. Paste a link to a regular (non-live) video."


class DownloadAgeRestrictedError(StemLoopsError):
    error_code = "DOWNLOAD_AGE_RESTRICTED"
    user_message = "This video is age-restricted, so we can't use it."


class DownloadPrivateError(StemLoopsError):
    error_code = "DOWNLOAD_PRIVATE"
    user_message = "This video is private or unavailable."


class VideoBlocklistedError(DownloadPrivateError):
    """SL21 blocklist hit (takedown / rightsholder / manual): refused before any fetch.
    Same error_code as DOWNLOAD_PRIVATE; the message is deliberately neutral."""

    user_message = "This video isn't available here. You can upload your own audio file instead."


class SeparationFailedError(StemLoopsError):
    error_code = "SEPARATION_FAILED"
    user_message = "Stem separation failed for this track. Try a different song."


class ExtractionFailedError(StemLoopsError):
    error_code = "EXTRACTION_FAILED"
    user_message = (
        "This track is too short or has no steady beat. Try a longer track with a clear beat."
    )


class UploadFailedError(StemLoopsError):
    error_code = "UPLOAD_FAILED"
    user_message = "We separated your stems but couldn't save them. Add the track again to retry."


class UploadInvalidError(StemLoopsError):
    error_code = "UPLOAD_INVALID"
    user_message = (
        "We couldn't read that file. Upload an audio or video file, "
        "such as mp3, wav, m4a, flac or mp4."
    )


class UploadTooLargeError(StemLoopsError):
    error_code = "UPLOAD_TOO_LARGE"
    user_message = "That file is too large. The maximum upload size is 200 MB."


def _human_limit(max_seconds: float) -> str:
    """``300.0`` -> ``"5 minutes"``; ``60.0`` -> ``"1 minute"``; ``30.0`` -> ``"30 seconds"``."""
    minutes = max_seconds / 60.0
    if minutes < 1:
        return f"{max_seconds:g} seconds"
    return f"{minutes:g} minute" + ("" if minutes == 1 else "s")


class UploadTooLongError(StemLoopsError):
    """Upload exceeds the worker's duration cap (``MAX_UPLOAD_DURATION_SEC``).

    NO LONGER RAISED FOR LENGTH (2026-11-14). Jon: a song over 5 minutes "should still be
    converted to a play along" -- both input paths now TRIM to the first
    ``MAX_UPLOAD_DURATION_SEC`` seconds instead of refusing (pipeline._prepare_upload_source,
    pipeline._trim_link_source). The class and its ``UPLOAD_TOO_LONG`` code stay defined:
    jobs failed before the change still carry the code, and the web error-copy map renders
    it. The message is built from the cap in force so a tuned env var never goes stale.
    """

    error_code = "UPLOAD_TOO_LONG"
    user_message = "That track is too long. Trim it to a shorter length and upload it again."
    # The with-a-limit wording. A subclass overrides only the SENTENCE; the number is always
    # formatted by _human_limit from the cap in force, so no subclass can reintroduce a
    # hard-coded figure here.
    limit_template = (
        "That track is too long. The maximum length is {limit}. Trim it and upload it again."
    )

    def __init__(self, detail: str | None = None, *, max_seconds: float | None = None):
        super().__init__(detail)
        self.max_seconds = max_seconds
        if max_seconds is not None:
            self.user_message = self.limit_template.format(limit=_human_limit(max_seconds))


class LinkTooLongError(UploadTooLongError):
    """A LINKED video longer than the same duration ceiling the upload path enforces.

    Same ``error_code`` as its parent -- still one of the typed classes, no taxonomy
    expansion -- following the FetchPausedError / LiveStreamNotSupportedError /
    VideoBlocklistedError precedent above. Only the wording differs: there is nothing to
    "trim and upload again" when the input was a URL, so the message offers the two things
    the user can actually do.

    NO LONGER RAISED (2026-11-14): a long linked video is trimmed to its first
    ``MAX_UPLOAD_DURATION_SEC`` seconds (``pipeline._trim_link_source``), not refused. Kept,
    like its parent, for rows failed before the change and for the error-copy map.
    """

    user_message = (
        "That video is too long. Pick a shorter one, or trim the audio "
        "and upload the file instead."
    )
    limit_template = (
        "That video is too long. The maximum length is {limit}. "
        "Pick a shorter one, or trim the audio and upload the file instead."
    )


class InternalError(StemLoopsError):
    error_code = "INTERNAL_ERROR"
    user_message = "Something went wrong on our end. We've logged it — please try again."


class LinkUnmeasurableError(InternalError):
    """A fetched link track that could not be trimmed to, or shown to be within, the cap.

    Same ``error_code`` as its parent (no taxonomy expansion; the FetchPausedError precedent).
    Raised by ``pipeline._trim_link_source`` BEFORE the file is staged or handed to
    Replicate: if ffmpeg cannot cut the file, or the cut cannot be measured, we cannot show
    Replicate is handed at most ``MAX_UPLOAD_DURATION_SEC`` seconds, so nothing is handed on.
    """

    user_message = (
        "We couldn't read the audio in that video, so we didn't process it. "
        "Try another link, or upload the audio file instead."
    )


_ALL_ERROR_CLASSES = [
    DownloadBlockedError,
    DownloadTimeoutError,
    DownloadInvalidUrlError,
    DownloadAgeRestrictedError,
    DownloadPrivateError,
    SeparationFailedError,
    ExtractionFailedError,
    UploadFailedError,
    UploadInvalidError,
    UploadTooLargeError,
    UploadTooLongError,
    InternalError,
]

ALL_ERROR_CODES = {cls.error_code for cls in _ALL_ERROR_CLASSES}
ERROR_CLASS_BY_CODE = {cls.error_code: cls for cls in _ALL_ERROR_CLASSES}
