"""Typed error taxonomy (PRD §6.2) — single source of truth for all worker errors.

Every user-facing failure is one of these 9 typed classes. Each carries an
``error_code`` and a plain-English ``user_message`` (message + what-to-do-next) —
never a stack trace or raw stderr. The optional ``detail`` is for server-side
logging only and is NEVER surfaced to the client.

RATE_LIMITED is intentionally absent here: it is an admission-control decision
made on the web side before a job exists, not a worker pipeline error.
"""

from __future__ import annotations

from typing import Optional


class StemLoopsError(Exception):
    error_code: str = "INTERNAL_ERROR"
    user_message: str = "Something went wrong on our end. We've logged it — please try again."

    def __init__(self, detail: Optional[str] = None):
        self.detail = detail
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


class DownloadInvalidUrlError(StemLoopsError):
    error_code = "DOWNLOAD_INVALID_URL"
    user_message = (
        "That doesn't look like a YouTube link. Paste a full youtube.com or youtu.be URL."
    )


class DownloadAgeRestrictedError(StemLoopsError):
    error_code = "DOWNLOAD_AGE_RESTRICTED"
    user_message = "This video is age-restricted and can't be processed."


class DownloadPrivateError(StemLoopsError):
    error_code = "DOWNLOAD_PRIVATE"
    user_message = "This video is private or unavailable."


class SeparationFailedError(StemLoopsError):
    error_code = "SEPARATION_FAILED"
    user_message = "Stem separation failed for this track. Try a different song."


class ExtractionFailedError(StemLoopsError):
    error_code = "EXTRACTION_FAILED"
    user_message = "We couldn't find clean loops in this audio (it may be too short or beatless)."


class UploadFailedError(StemLoopsError):
    error_code = "UPLOAD_FAILED"
    user_message = "We separated your stems but couldn't save them. Please retry."


class UploadInvalidError(StemLoopsError):
    error_code = "UPLOAD_INVALID"
    user_message = (
        "That file type isn't supported. Upload an audio or video file "
        "(mp3, wav, m4a, flac, ogg, aac, or mp4/mov)."
    )


class UploadTooLargeError(StemLoopsError):
    error_code = "UPLOAD_TOO_LARGE"
    user_message = "That file is too large. The maximum upload size is 200 MB."


class InternalError(StemLoopsError):
    error_code = "INTERNAL_ERROR"
    user_message = "Something went wrong on our end. We've logged it — please try again."


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
    InternalError,
]

ALL_ERROR_CODES = {cls.error_code for cls in _ALL_ERROR_CLASSES}
ERROR_CLASS_BY_CODE = {cls.error_code: cls for cls in _ALL_ERROR_CLASSES}
