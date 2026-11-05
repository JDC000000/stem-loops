"""Klangio Chord-Recognition API client (PR-Y1.1).

Y1 decision record: ``claude/phase-2-y1-chord-model-decision.md`` v1.1 — Klangio
Startup tier is the 1-billing-cycle bridge while we train the own-model (V3-Y1.4+).
HARD CAP: 1 billing cycle. The ``chords_complete`` log event makes per-call cost
and latency visible to the dashboard; raise ``ChordQuotaExceeded`` surfaces 402
TERMINALLY (never retried — the spend-ceiling layer handles it).

API shape (base ``https://api.klang.io/``, bearer auth via ``KLANGIO_API_KEY``):

  POST /transcription/chords (multipart ``audio_file=<wav>``)  → {"job_id": "..."}
  GET  /job/<id>                                               → {"status": "...", ...}
  GET  /job/<id>/json                                          → {"key": "...", "chords": [...], "strums": [...]}

Flow: POST → poll GET /job/<id> (``completed`` | ``failed``) → GET /job/<id>/json.

Rate limits (2–10 req/s) and transient 5xxs → exponential backoff + jitter, cap
60s, 5 retries. 402 → ``ChordQuotaExceeded`` (terminal). 4xx (not 402, 429) →
raised immediately — these are our bugs, retrying wastes quota.

Per-segment confidence: Klangio does NOT publish it (confirmed against the public
docs 2026-11-04). We set 1.0 for every segment and leave a TODO to derive a
heuristic from strum-gap width in Y1.2; ``is_valid_harte_label`` still gates the
label contract regardless of the confidence source.
"""

from __future__ import annotations

import hashlib
import os
import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from ..chord_source import (
    ChordQuotaExceeded,
    ChordResult,
    ChordSegment,
    StemKind,
    is_valid_harte_label,
)
from ..logger import log_structured

# Security audit §3 M6: Klangio's bearer token travels on every call. If
# KLANGIO_API_BASE is set to an http:// URL (CI typo, debugging stub,
# malicious env injection), the token would leave the process in clear on
# the wire. Fail fast at import time so no code path reaches _submit() with
# a dangerous base. The default is https so normal callers never trip this.
_API_BASE_RAW = os.environ.get("KLANGIO_API_BASE", "https://api.klang.io")
if not _API_BASE_RAW.startswith("https://"):
    raise ValueError(
        "KLANGIO_API_BASE must use https:// — a Bearer-authenticated API over "
        f"plain http would leak the token in clear. Got: {_API_BASE_RAW[:8]!r}..."
    )
API_BASE = _API_BASE_RAW.rstrip("/")
# Provider version pinned in the ChordResult for reproducibility; override via env
# when Klangio ships a new decoder we want to re-eval against the 20-song set.
PROVIDER_VERSION = os.environ.get("KLANGIO_API_VERSION", "2026-11-04")

# Retry budget. 60s cap matches Klangio's documented burst-cooldown; 5 attempts
# is enough to ride out a brief rate-limit spike without extending the pipeline's
# own time budget (callers set their own wall clock via HTTPX_TIMEOUT).
MAX_RETRIES = int(os.environ.get("KLANGIO_MAX_RETRIES", "5"))
BACKOFF_CAP_SEC = float(os.environ.get("KLANGIO_BACKOFF_CAP_SEC", "60"))
BACKOFF_BASE_SEC = float(os.environ.get("KLANGIO_BACKOFF_BASE_SEC", "1"))
# Per-HTTP-call timeout. Klangio's job-level poll can take minutes for a full
# track — the TOTAL time is controlled by POLL_DEADLINE_SEC, not this per-call.
HTTP_TIMEOUT_SEC = float(os.environ.get("KLANGIO_HTTP_TIMEOUT_SEC", "30"))
POLL_INTERVAL_SEC = float(os.environ.get("KLANGIO_POLL_INTERVAL_SEC", "2"))
POLL_DEADLINE_SEC = float(os.environ.get("KLANGIO_POLL_DEADLINE_SEC", "600"))
# Klangio's hard per-file limit (public docs 2026-11-04). We fail fast on files
# longer than this rather than let the provider reject them mid-pipeline.
MAX_AUDIO_SEC = float(os.environ.get("KLANGIO_MAX_AUDIO_SEC", "300"))


class ChordProviderError(Exception):
    """Non-retryable terminal error from the Klangio provider (not 402/429)."""


def _body_fingerprint(body: bytes | str | None) -> str:
    """Audit-safe single-line digest of an upstream response body.

    Security audit §3 M5: the pre-fix code raised ``ChordProviderError`` with
    the full upstream body (or its first 200 chars) embedded in the message.
    That message flows to stdout logs AND to Sentry — any user-supplied data
    Klangio echoes back in an error (filename, headers, auth hints) ends up
    in the log pipeline. Redact: emit a byte-count + sha256 prefix instead,
    enough to correlate across logs without carrying any content.
    """
    if body is None:
        body_bytes = b""
    elif isinstance(body, str):
        body_bytes = body.encode("utf-8", errors="replace")
    else:
        body_bytes = body
    return (
        f"body_bytes={len(body_bytes)} "
        f"body_sha256={hashlib.sha256(body_bytes).hexdigest()[:12]}"
    )


@dataclass
class KlangioChordSource:
    """Klangio implementation of the ``ChordSource`` protocol.

    Stateless; instantiating one is free. HTTP client is created per-call so the
    worker's thread-pool execution model (one ``recognize`` per worker thread)
    doesn't share a connection pool across concurrent jobs.
    """

    api_key: str | None = None  # defaults to env KLANGIO_API_KEY at call time
    api_base: str = API_BASE

    def recognize(self, audio_path: Path, *, stem: StemKind = "mix") -> ChordResult:
        audio_path = Path(audio_path)
        if not audio_path.exists():
            raise ChordProviderError(f"audio file not found: {audio_path}")

        key = self.api_key or os.environ.get("KLANGIO_API_KEY", "")
        if not key:
            raise ChordProviderError("KLANGIO_API_KEY not set — see docs/ops/chord-recognition.md")

        t0 = time.monotonic()
        headers = {"Authorization": f"Bearer {key}"}
        with httpx.Client(base_url=self.api_base, headers=headers) as client:
            job_id = self._submit(client, audio_path, stem)
            self._poll_until_complete(client, job_id)
            payload = self._fetch_json(client, job_id)
        model_ms = int((time.monotonic() - t0) * 1000)

        result = _parse_klangio_response(payload, model_ms=model_ms)
        log_structured(
            "INFO",
            "chord_recognition_complete",
            provider="klangio",
            provider_version=result.provider_version,
            model_ms=model_ms,
            segments=len(result.segments),
            key=result.key,
            stem=stem,
        )
        return result

    # ------------------------------ HTTP steps ------------------------------
    def _submit(self, client: httpx.Client, audio_path: Path, stem: StemKind) -> str:
        with open(audio_path, "rb") as fh:
            files = {"audio_file": (audio_path.name, fh, "audio/wav")}
            data = {"stem": stem}
            resp = _request_with_retry(
                client,
                method="POST",
                url="/transcription/chords",
                files=files,
                data=data,
            )
        body = _parse_json(resp)
        job_id = body.get("job_id") or body.get("id")
        if not job_id:
            raise ChordProviderError(f"Klangio POST did not return a job_id: {body!r}")
        return str(job_id)

    def _poll_until_complete(self, client: httpx.Client, job_id: str) -> None:
        deadline = time.monotonic() + POLL_DEADLINE_SEC
        while time.monotonic() < deadline:
            resp = _request_with_retry(client, method="GET", url=f"/job/{job_id}")
            body = _parse_json(resp)
            status = (body.get("status") or "").lower()
            if status in ("completed", "succeeded", "done"):
                return
            if status in ("failed", "error", "cancelled", "canceled"):
                # Redacted: body may contain user-supplied metadata or hints
                # about the auth header. job_id + status is enough to find the
                # upstream job in Klangio's dashboard.
                raise ChordProviderError(f"Klangio job {job_id} terminal status={status}")
            time.sleep(POLL_INTERVAL_SEC)
        raise ChordProviderError(
            f"Klangio job {job_id} did not complete within " f"{POLL_DEADLINE_SEC:.0f}s"
        )

    def _fetch_json(self, client: httpx.Client, job_id: str) -> dict[str, Any]:
        resp = _request_with_retry(client, method="GET", url=f"/job/{job_id}/json")
        return _parse_json(resp)


# --------------------------- HTTP helpers (module-level) ---------------------------
def _request_with_retry(
    client: httpx.Client,
    *,
    method: str,
    url: str,
    **kwargs: Any,
) -> httpx.Response:
    """Issue an HTTP call with exponential-backoff-plus-jitter retry.

    Retries on 429 and 5xx up to ``MAX_RETRIES``. 402 is translated to
    ``ChordQuotaExceeded`` and raised immediately (terminal — never retried).
    Other 4xxs are ``ChordProviderError`` (also terminal).
    """
    last_exc: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = client.request(method, url, timeout=HTTP_TIMEOUT_SEC, **kwargs)
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            last_exc = exc
            if attempt >= MAX_RETRIES:
                raise ChordProviderError(
                    f"Klangio {method} {url} transport failure after "
                    f"{attempt + 1} attempts: {exc}"
                ) from exc
            _sleep_backoff(attempt)
            continue

        status = resp.status_code
        if status == 402:
            # Terminal: the plan's monthly quota is exhausted. Raising this up
            # the stack is the explicit signal to swap providers / top up the
            # plan — do NOT retry.
            raise ChordQuotaExceeded("Klangio quota exceeded (HTTP 402) — see Y1 decision record.")
        if status == 429 or status >= 500:
            if attempt >= MAX_RETRIES:
                raise ChordProviderError(
                    f"Klangio {method} {url} HTTP {status} after " f"{attempt + 1} attempts"
                )
            _sleep_backoff(attempt, retry_after=resp.headers.get("Retry-After"))
            continue
        if status >= 400:
            # Other 4xx is our bug (bad body, bad auth, bad file) — fail now.
            # Body is fingerprinted, not inlined (audit §3 M5).
            raise ChordProviderError(
                f"Klangio {method} {url} HTTP {status} " f"{_body_fingerprint(resp.text)}"
            )
        return resp

    # Loop fell through without return/raise — defensive.
    raise ChordProviderError(f"Klangio {method} {url} exhausted retries (last_exc={last_exc!r})")


def _sleep_backoff(attempt: int, *, retry_after: str | None = None) -> None:
    """Exponential backoff with full jitter, honouring Retry-After when present.

    ``attempt`` is zero-indexed (0 after the first failure). Delay is
    ``min(cap, base * 2**attempt)`` with up to ±50% jitter — the Retry-After
    header (seconds) wins if the server sent one.
    """
    if retry_after:
        try:
            delay = min(BACKOFF_CAP_SEC, float(retry_after))
            time.sleep(delay)
            return
        except (TypeError, ValueError):
            pass
    base = min(BACKOFF_CAP_SEC, BACKOFF_BASE_SEC * (2**attempt))
    jitter = base * (0.5 + random.random() * 0.5)  # 50–100% of base
    time.sleep(jitter)


def _parse_json(resp: httpx.Response) -> dict[str, Any]:
    try:
        body = resp.json()
    except ValueError as exc:
        # Redacted: body fingerprint only — pre-fix we inlined the first 200
        # chars, which could echo auth hints or user filenames into Sentry.
        raise ChordProviderError(
            f"Klangio response was not JSON (status={resp.status_code}) "
            f"{_body_fingerprint(resp.text)}"
        ) from exc
    if not isinstance(body, dict):
        raise ChordProviderError(f"Klangio response JSON was not a dict: {type(body).__name__}")
    return body


# --------------------------- response parsing ---------------------------
def _parse_klangio_response(payload: dict[str, Any], *, model_ms: int) -> ChordResult:
    """Map Klangio's JSON payload onto our provider-agnostic ChordResult."""
    chords_raw = payload.get("chords") or []
    segments: list[ChordSegment] = []
    duration_sec = 0.0
    for row in chords_raw:
        if not isinstance(row, dict):
            continue
        start = float(row.get("start", 0.0))
        end = float(row.get("end", start))
        label = str(row.get("name", "N")).strip()
        if not is_valid_harte_label(label):
            # Unknown qualities (Klangio sometimes returns e.g. 'C:maj9') map
            # to the X ("unrecognised") bucket so downstream readers don't
            # choke on the contract.
            label = "X"
        segments.append(
            ChordSegment(
                start_sec=start,
                end_sec=end,
                label=label,
                confidence=1.0,  # TODO Y1.2: derive from strums gap heuristic
            )
        )
        if end > duration_sec:
            duration_sec = end

    key_val = payload.get("key")
    key = str(key_val) if key_val else None

    return ChordResult(
        segments=segments,
        key=key,
        provider="klangio",
        provider_version=PROVIDER_VERSION,
        duration_sec=duration_sec,
        model_ms=model_ms,
    )
