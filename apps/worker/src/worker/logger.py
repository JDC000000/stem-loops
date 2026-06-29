"""Structured JSON logging with secret redaction (PRD §6.2).

Phase 1 minimal version: `log_structured(level, event, **fields)` emits one JSON
line with `job_id` as the primary correlation key. All string values are scrubbed
of cookie/token/bearer/session patterns before they are written, so no secret or
YouTube auth material can leak into logs or `job_events.detail` (P2-5/9 harden
this further). Stderr captured from subprocesses must be passed through `redact()`
and truncated before persisting.
"""

from __future__ import annotations

import json
import re
import sys

_REDACT_RE = re.compile(r"(cookie|token|bearer|session|authorization)[=:]\s*\S+", re.IGNORECASE)


def redact(text: str) -> str:
    return _REDACT_RE.sub(r"\1=[REDACTED]", text)


def _scrub(value):
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {k: _scrub(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_scrub(v) for v in value]
    return value


def log_structured(level: str, event: str, **fields) -> None:
    """Emit one structured JSON log line to stdout (job_id-correlated, redacted)."""
    record = {"level": level, "event": event, **{k: _scrub(v) for k, v in fields.items()}}
    sys.stdout.write(json.dumps(record, default=str) + "\n")
    sys.stdout.flush()
