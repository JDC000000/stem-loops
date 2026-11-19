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

Subprocess stderr must be passed through `redact_secrets()` and is additionally
capped at 4KB before it is persisted.
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

# Pass 2: any token-ish word that carries a secret keyword in its name.
_KEYWORD_WORD_RE = re.compile(
    r"(?i)[A-Za-z0-9._%/+-]*(?:token|secret|password|cookie|credential|apikey)[A-Za-z0-9._%/+-]*"
)


# Pass 0 (QA-61 review m-3): URL userinfo. PROXY_URL is `http://user:pass@host:port`, and the
# sticky form appends `_session-<id>_lifetime-2m` to the password; neither carries a keyword
# pass 2 would catch. Any `scheme://<userinfo>@` loses its userinfo, and so does a scheme-less
# `user:pass@host` (host must look like one: a dotted name or name:port, as in
# sentry_config._BARE_USERINFO, so `12:30@noon` is left alone).
_URL_USERINFO_RE = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/?#@'\"<>]+@")
_BARE_USERINFO_RE = re.compile(
    r"(?<![\w/:.@-])[^\s/:@'\"()\[\]]+:[^\s/@'\"()\[\]]+@(?=[\w-]+(?:\.[\w-]+)+|[\w.-]+:\d+)"
)


def redact_secrets(text: str) -> str:
    text = _URL_USERINFO_RE.sub(lambda m: m.group(1) + "[REDACTED]@", text)
    text = _BARE_USERINFO_RE.sub("[REDACTED]@", text)
    text = _PREFIX_RE.sub(lambda m: m.group(1) + "[REDACTED]", text)
    text = _KEYWORD_WORD_RE.sub("[REDACTED]", text)
    return text


def log_structured(level: str, event: str, **fields: Any) -> None:
    detail = json.dumps(fields, default=str)
    if len(detail.encode()) > MAX_DETAIL:
        detail = detail[:MAX_DETAIL] + "…"
    safe = redact_secrets(detail)
    record = json.dumps({"level": level, "event": event, "detail": safe})
    print(record, file=sys.stderr, flush=True)
