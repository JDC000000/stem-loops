"""Klangio Chord-Recognition API client (PR-Y1.1).

Y1 decision record: ``claude/phase-2-y1-chord-model-decision.md`` v1.1 — Klangio
Startup tier is the 1-billing-cycle bridge while we train the own-model (V3-Y1.4+).
HARD CAP: 1 billing cycle. The ``chords_complete`` log event makes per-call cost
and latency visible to the dashboard; raise ``ChordQuotaExceeded`` surfaces 402
TERMINALLY (never retried — the spend-ceiling layer handles it).

API shape (base ``https://api.klang.io/``, auth header ``kl-api-key: <KLANGIO_API_KEY>``;
verified empirically against the live service 2026-11-05). It is an ASYNC job API:

  POST /chord-recognition?vocabulary={root|major-minor|full}
       (multipart, file field ``file``; ``vocabulary`` REQUIRED, omitted -> 422)
                                       -> {"job_id": "...", "status_endpoint_url": ...}
  GET  /job/<id>/status                -> {"status": IN_QUEUE|IN_PROGRESS|COMPLETED|FAILED,
                                          "error": "..." (FAILED only)}
  GET  /job/<id>/json                  -> [[start_sec, end_sec, harte_label], ...]  (bare array)

Flow: validate duration locally -> POST -> poll status (backoff) -> GET json.
Startup tier: 500 req/month (real money past that), 2 req/s, audio >5s and <=300s.
Both duration bounds are checked BEFORE the POST because a rejected request still
consumes quota. All calls pass through a process-wide 2 req/s throttle.

Rate limits (429) and transient 5xxs → exponential backoff + jitter, cap
60s, 5 retries. 402 → ``ChordQuotaExceeded`` (terminal). 4xx (not 402, 429) →
raised immediately — these are our bugs, retrying wastes quota.

Per-segment confidence: Klangio does NOT publish it (the result is bare
[start, end, label] triples; no key either, so ``ChordResult.key`` is None). We set
1.0 for every segment and leave a TODO for a heuristic in Y1.2; ``is_valid_harte_label`` still gates the
label contract regardless of the confidence source.
"""

from __future__ import annotations

import hashlib
import os
import random
import re
import threading
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

# Security audit §3 M6: Klangio's API key travels on every call. If
# KLANGIO_API_BASE is set to an http:// URL (CI typo, debugging stub,
# malicious env injection), the token would leave the process in clear on
# the wire. Fail fast at import time so no code path reaches _submit() with
# a dangerous base. The default is https so normal callers never trip this.
_API_BASE_RAW = os.environ.get("KLANGIO_API_BASE", "https://api.klang.io")
if not _API_BASE_RAW.startswith("https://"):
    raise ValueError(
        "KLANGIO_API_BASE must use https:// — an API-key-authenticated API over "
        f"plain http would leak the key in clear. Got: {_API_BASE_RAW[:8]!r}..."
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
# Klangio's hard per-file limits (Startup tier, measured 2026-11-05). We fail fast
# on files outside them rather than let the provider reject the request: a
# rejected request still costs quota, and quota is real money (500/mo, then $0.20).
MAX_AUDIO_SEC = float(os.environ.get("KLANGIO_MAX_AUDIO_SEC", "300"))
# Provider requires audio STRICTLY longer than this ("must be longer than 5 seconds").
MIN_AUDIO_SEC = float(os.environ.get("KLANGIO_MIN_AUDIO_SEC", "5"))
# Startup tier allows 2 req/s. Minimum spacing between ANY two requests issued by
# this process (the worker may run several recognize() calls on a thread pool).
MIN_REQUEST_INTERVAL_SEC = float(os.environ.get("KLANGIO_MIN_REQUEST_INTERVAL_SEC", "0.5"))

# ``vocabulary`` is REQUIRED by the API (omitted -> HTTP 422). Default ``full``:
# the product's factored quality x bass alphabet would be collapsed by
# ``major-minor`` (7ths and slash chords, ~1/3 of real chord tokens).
VALID_VOCABULARIES = ("root", "major-minor", "full")
DEFAULT_VOCABULARY = "full"
API_KEY_HEADER = "kl-api-key"
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_ERROR_MAX_CHARS = 200


_throttle_lock = threading.Lock()
_next_request_at = 0.0
# Bound at import so tests that patch ``time.sleep`` (to skip backoff) neither
# break nor are polluted by throttle waits.
_throttle_sleep = time.sleep


def _throttle() -> None:
    """Block until this process may issue another request (2 req/s ceiling).

    Slots are reserved under a lock and the wait happens outside it, so
    concurrent threads queue up 0.5s apart instead of bursting.
    """
    global _next_request_at  # noqa: PLW0603
    interval = MIN_REQUEST_INTERVAL_SEC
    if interval <= 0:
        return
    with _throttle_lock:
        now = time.monotonic()
        slot = max(now, _next_request_at)
        _next_request_at = slot + interval
    wait = slot - now
    if wait > 0:
        _throttle_sleep(wait)


def _resolve_vocabulary() -> str:
    vocab = os.environ.get("KLANGIO_VOCABULARY", DEFAULT_VOCABULARY).strip() or DEFAULT_VOCABULARY
    if vocab not in VALID_VOCABULARIES:
        raise ChordProviderError(
            f"KLANGIO_VOCABULARY={vocab[:32]!r} invalid; expected one of {VALID_VOCABULARIES}"
        )
    return vocab


def _audio_duration_sec(audio_path: Path) -> float:
    """Local duration probe. Fails closed: if we cannot measure it, do not spend."""
    try:
        import soundfile as sf  # noqa: PLC0415 — heavy native dep, keep import lazy

        return float(sf.info(str(audio_path)).duration)
    except Exception as exc:  # noqa: BLE001
        raise ChordProviderError(
            f"could not determine audio duration for {audio_path.name}: {type(exc).__name__}"
        ) from exc


def _check_duration_bounds(duration_sec: float) -> None:
    if duration_sec <= MIN_AUDIO_SEC:
        raise ChordProviderError(
            f"audio too short for Klangio: {duration_sec:.2f}s (must be > {MIN_AUDIO_SEC:g}s); "
            "no request sent"
        )
    if duration_sec > MAX_AUDIO_SEC:
        raise ChordProviderError(
            f"audio too long for Klangio: {duration_sec:.1f}s (max {MAX_AUDIO_SEC:g}s); "
            "no request sent"
        )


def _safe_upstream_error(raw: Any, api_key: str) -> str:
    """Bounded, printable, key-scrubbed form of Klangio's FAILED ``error`` string.

    The error is actionable ("Audio file must be longer than 5 seconds!") so we
    surface it, but it is still upstream text bound for Sentry: only the ``error``
    field is ever read, it is truncated, and the API key is scrubbed.
    """
    if not isinstance(raw, str):
        return "<none>"
    text = "".join(ch for ch in raw if ch.isprintable())[:_ERROR_MAX_CHARS]
    if api_key:
        text = text.replace(api_key, "[redacted]")
    return text


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

        # Validate everything locally BEFORE the first (billable) request.
        vocabulary = _resolve_vocabulary()
        _check_duration_bounds(_audio_duration_sec(audio_path))

        t0 = time.monotonic()
        headers = {API_KEY_HEADER: key}
        with httpx.Client(base_url=self.api_base, headers=headers) as client:
            job_id = self._submit(client, audio_path, stem, vocabulary)
            self._poll_until_complete(client, job_id, api_key=key)
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
    def _submit(
        self,
        client: httpx.Client,
        audio_path: Path,
        stem: StemKind,  # noqa: ARG002 — Klangio has no stem parameter; kept for the Protocol
        vocabulary: str = DEFAULT_VOCABULARY,
    ) -> str:
        # Read once: a retried POST must re-send the full body (an open file
        # handle would be at EOF on attempt 2).
        audio_bytes = audio_path.read_bytes()
        resp = _request_with_retry(
            client,
            method="POST",
            url="/chord-recognition",
            params={"vocabulary": vocabulary},
            files={"file": (audio_path.name, audio_bytes, "audio/wav")},
        )
        body = _parse_json(resp)
        job_id = body.get("job_id") if isinstance(body, dict) else None
        if not job_id or not _JOB_ID_RE.match(str(job_id)):
            # Fingerprint only — never echo the body (audit §3 M5).
            raise ChordProviderError(
                f"Klangio POST did not return a usable job_id {_body_fingerprint(resp.text)}"
            )
        return str(job_id)

    def _poll_until_complete(self, client: httpx.Client, job_id: str, *, api_key: str = "") -> None:
        deadline = time.monotonic() + POLL_DEADLINE_SEC
        while time.monotonic() < deadline:
            resp = _request_with_retry(client, method="GET", url=f"/job/{job_id}/status")
            body = _parse_json(resp)
            if not isinstance(body, dict):
                raise ChordProviderError(
                    f"Klangio job {job_id} status was not an object {_body_fingerprint(resp.text)}"
                )
            status = str(body.get("status") or "").upper()
            if status == "COMPLETED":
                return
            if status == "FAILED":
                # Only the documented ``error`` field is surfaced (bounded and
                # key-scrubbed); the rest of the body stays out of logs.
                detail = _safe_upstream_error(body.get("error"), api_key)
                raise ChordProviderError(f"Klangio job {job_id} terminal status=failed: {detail}")
            # IN_QUEUE / IN_PROGRESS / anything unrecognised: keep polling until
            # the deadline rather than abandon a job we already paid for.
            time.sleep(POLL_INTERVAL_SEC)
        raise ChordProviderError(
            f"Klangio job {job_id} did not complete within " f"{POLL_DEADLINE_SEC:.0f}s"
        )

    def _fetch_json(self, client: httpx.Client, job_id: str) -> list[Any]:
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
        _throttle()  # every attempt (including retries) counts against 2 req/s
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


def _parse_json(resp: httpx.Response) -> Any:
    """Decode a JSON body. The result is a bare ARRAY; submit/status are objects,
    so callers validate the shape they expect."""
    try:
        return resp.json()
    except ValueError as exc:
        # Redacted: body fingerprint only — pre-fix we inlined the first 200
        # chars, which could echo auth hints or user filenames into Sentry.
        raise ChordProviderError(
            f"Klangio response was not JSON (status={resp.status_code}) "
            f"{_body_fingerprint(resp.text)}"
        ) from exc


# --------------------------- response parsing ---------------------------
def _parse_klangio_response(payload: Any, *, model_ms: int) -> ChordResult:
    """Map Klangio's result array ``[[start, end, label], ...]`` onto ChordResult."""
    if not isinstance(payload, list):
        raise ChordProviderError(f"Klangio result was not a JSON array: {type(payload).__name__}")
    segments: list[ChordSegment] = []
    duration_sec = 0.0
    for row in payload:
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            continue
        try:
            start = float(row[0])
            end = float(row[1])
        except (TypeError, ValueError):
            continue
        label = str(row[2]).strip()
        if not is_valid_harte_label(label):
            # Unknown qualities (e.g. 'C:maj9') map to the X ("unrecognised")
            # bucket so downstream readers don't choke on the contract.
            label = "X"
        segments.append(
            ChordSegment(
                start_sec=start,
                end_sec=end,
                label=label,
                confidence=1.0,  # TODO Y1.2: Klangio publishes no confidence
            )
        )
        if end > duration_sec:
            duration_sec = end

    return ChordResult(
        segments=segments,
        key=None,  # the chord-recognition result carries no key
        provider="klangio",
        provider_version=PROVIDER_VERSION,
        duration_sec=duration_sec,
        model_ms=model_ms,
    )
