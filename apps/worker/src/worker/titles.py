"""Song titles for ``jobs.title`` (design v1.4, P5.1).

``jobs.title`` has existed since migration 001 and was never written, so the library and
the player showed a YouTube URL (or a UUID) where a song name belongs. Two sources fill it,
for NEW songs only -- nothing here backfills an old row:

  * a YouTube link: the ``title`` field of the yt-dlp metadata call the worker ALREADY makes
    for the duration reading (``ytdlp_client.probe_metadata``) -- same request, no extra
    proxy traffic;
  * an upload: the file name the user picked, without its extension.

Both go through :func:`clean_title` before they are stored. A video title is text chosen by
a stranger, so it is treated as untrusted: control characters, every invisible format character
(bidi overrides, tag characters, ...) except ZWJ/ZWNJ, and blank "filler" letters are removed,
whitespace is collapsed, the length is capped, and a title with nothing visible left is None. React escapes it on the way out, so this is about what
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

# Invisible characters (review round 2, SF-2). A list of known-bad code points kept letting new
# ones through (tag characters, the Hangul filler, the soft hyphen...), so the rule is by
# CATEGORY: every Unicode format character (Cf) is removed -- that covers the bidi controls
# (LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI, LRM/RLM, ALM), ZWSP, WJ, BOM, the soft hyphen U+00AD,
# U+2061-2064, U+180E, U+FFF9-FFFB and the tag characters U+E0001/U+E0020-E007F -- EXCEPT
# ZWNJ/ZWJ (U+200C/U+200D), which emoji sequences and several scripts (Persian, Indic) need.
_KEEP_CF = frozenset({"\u200c", "\u200d"})
# Not Cf, but they render as blank space without being whitespace to str.strip() or to
# jobLabel()'s trim, so a title made of them showed as an empty h1 or library row: the Hangul
# fillers (U+115F, U+1160, U+3164, U+FFA0) and the Braille blank (U+2800). The whole tag block
# U+E0000-E007F is named too, so an UNASSIGNED tag code point (category Cn) cannot get through.
_FILLERS = re.compile("[\u115f\u1160\u3164\uffa0\u2800\U000e0000-\U000e007f]")


def _strip_invisible(text: str) -> str:
    text = _FILLERS.sub("", text)
    return "".join(ch for ch in text if ch in _KEEP_CF or unicodedata.category(ch) != "Cf")


_WS = re.compile(r"\s+")


def clean_title(raw: object, max_chars: int = TITLE_MAX_CHARS) -> str | None:
    """A storable title, or ``None`` when there is nothing worth storing.

    ``None`` for: a non-string, an empty or whitespace-only string, and yt-dlp's own "field
    absent" marker ``NA``.
    """
    if not isinstance(raw, str):
        return None
    text = unicodedata.normalize("NFC", raw)
    text = _strip_invisible(text)
    # Every other control character (Cc: NUL, ESC, newlines, tabs, DEL...) becomes a space,
    # then all whitespace runs collapse to one.
    text = "".join(" " if unicodedata.category(ch) == "Cc" else ch for ch in text)
    text = _WS.sub(" ", text).strip()
    # Empty, or only joiners left (a ZWJ/ZWNJ alone shows nothing): None, so the UI uses its
    # existing fallback (the file name or the link; lib/job-label.ts) instead of a blank title.
    if not text.strip("".join(_KEEP_CF) + " ") or text == "NA":
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
