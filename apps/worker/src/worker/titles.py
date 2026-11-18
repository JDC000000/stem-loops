"""Song titles for ``jobs.title`` (design v1.4, P5.1).

``jobs.title`` has existed since migration 001 and was never written, so the library and
the player showed a YouTube URL (or a UUID) where a song name belongs. Two sources fill it,
for NEW songs only -- nothing here backfills an old row:

  * a YouTube link: the ``title`` field of the yt-dlp metadata call the worker ALREADY makes
    for the duration reading (``ytdlp_client.probe_metadata``) -- same request, no extra
    proxy traffic;
  * an upload: the file name the user picked, without its extension.

Both go through :func:`clean_title` before they are stored. A video title is text chosen by
a stranger, so it is treated as untrusted: control characters and the bidirectional-override
characters that can make a title display as something else are removed, whitespace is
collapsed, and the length is capped. React escapes it on the way out, so this is about what
a reader SEES, not about markup.

Display cleaning (stripping "(Official Video)", splitting "Artist - Song") is a separate,
display-only step in P5.1 and is not done here: the stored title is the cleaned RAW title.

``cleanup.py`` already blanks ``title`` when a job is swept, with the other identifying
fields, so a stored title lives exactly as long as the song.
"""

from __future__ import annotations

import os
import re
import unicodedata

# Long enough for any real song title; short enough that a hostile 100 kB "title" cannot
# reach the database or a list row.
TITLE_MAX_CHARS = 200

# Bidirectional controls (LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI, LRM/RLM, ALM) and invisible
# characters that carry no meaning in a title. ZWJ/ZWNJ (U+200C/U+200D) are deliberately
# kept: emoji sequences and several scripts (Persian, Indic) need them.
_INVISIBLE = re.compile("[‪-‮⁦-⁩‎‏؜​⁠﻿]")
_WS = re.compile(r"\s+")


def clean_title(raw: object, max_chars: int = TITLE_MAX_CHARS) -> str | None:
    """A storable title, or ``None`` when there is nothing worth storing.

    ``None`` for: a non-string, an empty or whitespace-only string, and yt-dlp's own "field
    absent" marker ``NA``.
    """
    if not isinstance(raw, str):
        return None
    text = unicodedata.normalize("NFC", raw)
    text = _INVISIBLE.sub("", text)
    # Every other control character (Cc: NUL, ESC, newlines, tabs, DEL...) becomes a space,
    # then all whitespace runs collapse to one.
    text = "".join(" " if unicodedata.category(ch) == "Cc" else ch for ch in text)
    text = _WS.sub(" ", text).strip()
    if not text or text == "NA":
        return None
    if len(text) > max_chars:
        text = text[: max_chars - 1].rstrip() + "…"
    return text


def upload_title(original_filename: object) -> str | None:
    """The title for an uploaded file: its name without folders or extension."""
    if not isinstance(original_filename, str):
        return None
    base = re.split(r"[\\/]", original_filename)[-1]
    stem, _ext = os.path.splitext(base)
    # ".mp3" alone has no stem; splitext returns it whole as the stem, which is not a title.
    if not stem or (stem.startswith(".") and not _ext):
        return None
    return clean_title(stem)
