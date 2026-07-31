"""Structured JSON logger with secret redaction and a detail-size cap (PRD §6.2).

`log_structured(level, event, **fields)` emits one JSON line to stderr with the
fields nested under `detail`. Three redaction passes run before anything is written,
so no token/cookie/secret can leak into logs or `job_events.detail` (PRD §6.1):

  1. URL credentials — the `scheme://user:pass@host` userinfo segment of ANY URL
     is masked. This is the shape PROXY_URL uses (residential proxy, live in prod),
     and yt-dlp echoes the full proxy URL in stderr on a proxy connect/auth failure,
     which is then logged. Nothing about that shape is keyword-prefixed, so passes
     2 and 3 do not see it (hardening review C4).
  2. Prefixed secrets — `Bearer X`, `token=X`, `Set-Cookie: X`, `Authorization: X`,
     `session_cookie=X`, `api_key=X`, `password=X` → value replaced with [REDACTED].
  3. Keyword tokens — any whitespace-delimited word that itself contains a
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

# Pass 1: the userinfo segment of any URL — http://user:pass@host, including the
# same shape inside a JSON-escaped string. Deliberately generic (no keyword
# required): PROXY_URL credentials carry no secret-indicating keyword at all.
# The run excludes '/', whitespace and quotes so it can never cross a path
# segment or a JSON string boundary, and the host after '@' is left intact.
_URL_USERINFO_RE = re.compile(r"://[^/\s@\"']+@")

# Pass 2: prefix=value pairs. The value run stops at whitespace.
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

# Pass 3: any token-ish word that carries a secret keyword in its name.
_KEYWORD_WORD_RE = re.compile(
    r"(?i)[A-Za-z0-9._%/+-]*(?:token|secret|password|cookie|credential|apikey)[A-Za-z0-9._%/+-]*"
)


def redact_secrets(text: str) -> str:
    # URL credentials first: a proxy password can legitimately contain a word the
    # later passes would rewrite mid-string, which would leave the rest exposed.
    text = _URL_USERINFO_RE.sub("://[REDACTED]@", text)
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
