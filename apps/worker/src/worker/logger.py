"""Structured JSON logger with secret redaction and a detail-size cap (PRD §6.2).

`log_structured(level, event, **fields)` emits one JSON line to stderr with the
fields nested under `detail`. Redaction passes run before anything is written,
so no token/cookie/secret can leak into logs or `job_events.detail` (PRD §6.1):

  0. URL userinfo — `scheme://user:pass@host` and bare `user:pass@host` lose `user:pass`
     (a proxy URL's credentials carry no keyword for pass 2 to find).
  1. Prefixed secrets — `Bearer X`, `token=X`, `Set-Cookie: X`, `Authorization: X`,
     `session_cookie=X`, `api_key=X`, `password=X` → value replaced with [REDACTED].
  2. Keyword tokens — any whitespace-delimited word that itself contains a
     secret-indicating keyword (token/secret/password/cookie/credential/apikey)
     is replaced wholesale. This catches bare high-entropy values that carry the
     keyword in their name even without a prefix.

Subprocess stderr must be passed through `redact_secrets()` (or `redact_tail()`, which
redacts before it cuts) and the detail is additionally capped at 4KB AFTER redaction.
"""

from __future__ import annotations

import json
import re
import sys
from typing import Any

MAX_DETAIL = 4096

# Pass 1: prefix=value pairs. The value run stops at whitespace.
_PREFIX_RE = re.compile(
    r"(?i)\b("
    r"bearer\s+|"
    r"token[=:\s]+|"
    r"set-cookie:\s*|"
    r"authorization:\s*|"
    r"session[_-]?cookie[=:\s]*|"
    r"cookie:\s*|"
    r"api[_-]?key[=:\s]+|"
    r"password[=:\s]+"
    r")\S+"
)

# Pass 2: any token-ish word that carries a secret keyword in its name. Matched as whole
# runs and then tested for a keyword (QA-65): the old single pattern
# `[..]*(?:keyword)[..]*` backtracked quadratically on a long keyword-free run (5 KB of
# base64-ish stderr took ~1-2 s). Same result: the whole run is replaced.
_WORD_RUN_RE = re.compile(r"[A-Za-z0-9._%/+-]+")
_SECRET_KEYWORD_RE = re.compile(r"(?i)token|secret|password|cookie|credential|apikey")


def _redact_keyword_run(m: re.Match) -> str:
    return "[REDACTED]" if _SECRET_KEYWORD_RE.search(m.group(0)) else m.group(0)


# Pass 0 (QA-61 review m-3, hardened QA-65 / review R-3): URL userinfo. PROXY_URL is
# `http://user:pass@host:port`, and the sticky form appends `_session-<id>_lifetime-2m` to the
# password; neither carries a keyword pass 2 would catch. Any `scheme://<userinfo>@` loses its
# userinfo, and so does a scheme-less `user:pass@host` (host must look like one: a dotted name,
# name:port or a bracketed IPv6 literal, as in sentry_config._BARE_USERINFO, so `12:30@noon` is
# left alone). Hardening:
#   * a raw `@` inside the password: the userinfo run is greedy and may contain `@`, so the
#     match ends at the LAST `@` before the host (`usr:hun@ter2@host` loses `usr:hun@ter2`);
#   * a backslash escape inside the run (`\"`, `\\`, `\uXXXX`) is part of it: log_structured
#     redacts a JSON dump, where a `"` in a password arrives as `\"`. An UNescaped quote still
#     ends the run (that is the end of a JSON string);
#   * scheme-less `user:pass@[::1]:port`.
_USERINFO_CHAR = r"(?:\\.|[^\s/?#'\"<>\\])"
_URL_USERINFO_RE = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)" + _USERINFO_CHAR + r"+@")
_HOST_AHEAD = r"(?=\[[0-9A-Fa-f:.]+\](?::\d+)?|[\w-]+(?:\.[\w-]+)+|[\w.-]+:\d+)"
_BARE_USERINFO_RE = re.compile(
    r"(?<![\w/:.@\\-])"
    r"(?:\\.|[^\s/:'\"()\[\]\\])+"  # user (may hold a raw @)
    r":(?:\\.|[^\s/'\"()\[\]\\])+"  # password (may hold raw @ and :), greedy
    r"@" + _HOST_AHEAD
)

# How much text before the kept tail redact_tail() redacts too, so a secret that straddles the
# cut is still seen whole by the patterns before the cut drops its head.
_TAIL_MARGIN = 4096


def redact_secrets(text: str) -> str:
    text = _URL_USERINFO_RE.sub(lambda m: m.group(1) + "[REDACTED]@", text)
    text = _BARE_USERINFO_RE.sub("[REDACTED]@", text)
    text = _PREFIX_RE.sub(lambda m: m.group(1) + "[REDACTED]", text)
    text = _WORD_RUN_RE.sub(_redact_keyword_run, text)
    return text


def redact_tail(text: str, limit: int) -> str:
    """The last ``limit`` characters of ``text`` with secrets redacted, redacting BEFORE the
    cut (QA-65, review R-3). Cutting first can land mid-password and leave a fragment with no
    `user:` or `@` for any pattern to recognise. Only the last ``limit + _TAIL_MARGIN`` chars are
    scanned (bounded work on huge stderr); a fragment at the start of that window is dropped
    by the final cut unless one secret is longer than the margin."""
    window = text[-(limit + _TAIL_MARGIN) :]
    return redact_secrets(window)[-limit:]


def log_structured(level: str, event: str, **fields: Any) -> None:
    detail = json.dumps(fields, default=str)
    # Redact BEFORE capping (QA-65): a cap that lands mid-password would leave a fragment
    # the patterns cannot see. Only the head that can survive the cap, plus a margin, is
    # scanned, so a huge detail costs bounded work; a fragment at the end of that window is
    # dropped by the cap unless one secret is longer than the margin.
    window = detail[: MAX_DETAIL + _TAIL_MARGIN]
    safe = redact_secrets(window)
    if len(window) < len(detail) or len(safe.encode()) > MAX_DETAIL:
        safe = safe[:MAX_DETAIL] + "…"
    record = json.dumps({"level": level, "event": event, "detail": safe})
    print(record, file=sys.stderr, flush=True)
