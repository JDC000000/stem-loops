"""Typed error taxonomy (PRD §6.2).

Phase 1 minimal version: the StemLoopsError base + the canonical error codes and
their user-facing copy. Phase 2 (P2-4) expands the per-stage raising sites. Every
user-facing failure carries a plain-English message + what-to-do-next — never a
stack trace or raw stderr.
"""

from __future__ import annotations

# code -> (message, what-to-do-next). Single source of truth for user-facing copy.
ERROR_COPY: dict[str, tuple[str, str]] = {
    "DOWNLOAD_BLOCKED": (
        "YouTube is temporarily blocking automated access for this video.",
        "Try again in a few minutes.",
    ),
    "DOWNLOAD_TIMEOUT": ("We couldn't reach that video in time.", "Check the link and try again."),
    "DOWNLOAD_INVALID_URL": (
        "That doesn't look like a YouTube link.",
        "Paste a full youtube.com or youtu.be URL.",
    ),
    "DOWNLOAD_AGE_RESTRICTED": ("This video is age-restricted and can't be processed.", ""),
    "DOWNLOAD_PRIVATE": ("This video is private or unavailable.", ""),
    "SEPARATION_FAILED": ("Stem separation failed for this track.", "Try a different song."),
    "EXTRACTION_FAILED": (
        "We couldn't find clean loops in this audio (it may be too short or beatless).",
        "",
    ),
    "UPLOAD_FAILED": ("We separated your stems but couldn't save them.", "Please retry."),
    "RATE_LIMITED": ("We're busy or you've hit the limit.", "Wait a moment and try again."),
    "INTERNAL_ERROR": ("Something went wrong on our end. We've logged it.", "Please try again."),
}

ERROR_CODES = frozenset(ERROR_COPY)
INTERNAL_ERROR = "INTERNAL_ERROR"


class StemLoopsError(Exception):
    """A typed, user-safe pipeline error.

    `error_code` is one of ERROR_CODES; `user_message` is the plain-English copy
    surfaced to the user. The original cause (if any) is kept on `__cause__` for
    server-side logging only — it is never sent to the client.
    """

    def __init__(self, error_code: str, user_message: str | None = None):
        if error_code not in ERROR_CODES:
            error_code = INTERNAL_ERROR
        self.error_code = error_code
        msg, action = ERROR_COPY[error_code]
        self.user_message = user_message or (f"{msg} {action}".strip())
        super().__init__(f"{error_code}: {self.user_message}")
