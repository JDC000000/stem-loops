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

SPEND SAFETY (Startup tier is real money: 500 incl., then $0.20/request):

* The submit POST is NEVER retried. Klangio documents no idempotency key and
  exposes no job-list endpoint (checked against the OpenAPI spec and docs
  2026-11-05), so a retry after a lost response could create a second billed
  job and nothing could detect it. A failed submit surfaces to the caller.
  Only the idempotent GETs (status / result) are retried: 429 and transient 5xx
  → exponential backoff + jitter, cap 60s, 5 retries.
* Every submit is counted against a monthly allowance (``_QuotaStore``) BEFORE
  the POST is sent, with the cycle anchored on the billing day (default the 5th).
  A warning is logged from 80% of the allowance; at ``KLANGIO_MONTHLY_CAP``
  (default 500) further submits are refused with ``ChordQuotaExceeded`` instead
  of silently incurring overage. Attempts are never refunded: a rejected or
  ambiguous request may still have consumed quota.

402 → ``ChordQuotaExceeded`` (terminal). 4xx (not 402, 429) → raised
immediately — these are our bugs, retrying wastes quota.

Per-segment confidence: Klangio does NOT publish it (the result is bare
[start, end, label] triples; no key either, so ``ChordResult.key`` is None). We set
1.0 for every segment and leave a TODO for a heuristic in Y1.2; ``is_valid_harte_label`` still gates the
label contract regardless of the confidence source.
"""

from __future__ import annotations

import hashlib
import json
import math
import mimetypes
import os
import random
import re
import tempfile
import threading
import time
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Protocol

try:  # POSIX only; the worker runs on Linux. Absent on Windows dev boxes.
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

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

# ---- spend protection ----
# Startup tier: 500 included requests per billing cycle, $0.20 each beyond.
# The cap defaults to the included allowance: pre-revenue, a failed transcription
# is better than a surprise invoice. Raise it deliberately to accept overage.
MONTHLY_CAP_DEFAULT = 500
# Billing cycle renews on this day of the month (subscription renewed 2026-11-05).
BILLING_DAY_DEFAULT = 5
# Log a loud warning once usage reaches this fraction of the cap.
WARN_FRACTION_DEFAULT = 0.8

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


_AUDIO_MIME = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
}


def _audio_mime(audio_path: Path) -> str:
    """MIME type from the file extension (not hardcoded audio/wav)."""
    suffix = audio_path.suffix.lower()
    if suffix in _AUDIO_MIME:
        return _AUDIO_MIME[suffix]
    guessed, _ = mimetypes.guess_type(audio_path.name)
    return guessed or "application/octet-stream"


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


# ------------------------------ quota accounting ------------------------------
def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        # Fail closed: a typo in a spend-control variable must not silently
        # disable the control.
        raise ChordProviderError(f"{name}={raw[:16]!r} is not an integer") from exc


def _env_fraction(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ChordProviderError(f"{name}={raw[:16]!r} is not a number") from exc
    if not 0 < value <= 1:
        raise ChordProviderError(f"{name}={raw[:16]!r} must be in (0, 1]")
    return value


def _utcnow() -> datetime:
    return datetime.now(UTC)


def billing_cycle_start(today: date, billing_day: int = BILLING_DAY_DEFAULT) -> date:
    """First day of the billing cycle containing ``today``.

    With billing day 5: 2026-11-05..2026-12-04 -> 2026-11-05; 2026-11-04 -> 2026-10-05.
    The day is clamped to 1..28 so every month has it.
    """
    day = max(1, min(28, billing_day))
    if today.day >= day:
        return date(today.year, today.month, day)
    year, month = (today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1)
    return date(year, month, day)


class _QuotaStore(Protocol):
    """Atomic per-cycle request counter.

    ``reserve`` must, as one atomic step, reset the count if ``cycle`` differs from
    the stored cycle, refuse if the count is already ``>= cap``, otherwise
    increment. ``_PostgresQuotaStore`` does this in one SQL statement; the file
    store does it under ``flock``. See docs/ops/chord-recognition.md.
    """

    def reserve(self, cycle: str, cap: int) -> tuple[int, bool]:
        """Return ``(count, granted)``; when refused, ``count`` is the unchanged total."""
        ...


class FileQuotaStore:
    """JSON counter file guarded by ``flock`` (safe across processes on ONE host).

    LIMITS, stated plainly: it is per-machine, and on Fly without a volume the
    root filesystem is wiped on every deploy/restart, resetting the count to zero.
    Point ``KLANGIO_QUOTA_FILE`` at a persistent volume (apps/worker/fly.toml mounts
    one) for the count to survive deploys; a volume is still per-machine, so that is
    durability, not cross-instance correctness. ``_PostgresQuotaStore`` is the real
    fix and is preferred whenever ``DATABASE_URL`` is set. The ``klangio_quota`` log
    lines are the durable record either way.
    """

    def __init__(self, path: Path) -> None:
        self.path = path

    def reserve(self, cycle: str, cap: int) -> tuple[int, bool]:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(str(self.path) + ".lock", "a+") as lock:
                if fcntl is not None:
                    fcntl.flock(lock, fcntl.LOCK_EX)
                count = self._read(cycle)
                if count >= cap:
                    return count, False
                count += 1
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps({"cycle": cycle, "count": count}))
                os.replace(tmp, self.path)
                return count, True
        except OSError as exc:
            # Fail closed: if we cannot account for spend, we do not spend.
            raise ChordProviderError(
                f"Klangio quota file unusable ({type(exc).__name__}); refusing to spend"
            ) from exc

    def _read(self, cycle: str) -> int:
        if not self.path.exists():
            return 0
        try:
            data = json.loads(self.path.read_text())
            stored_cycle, count = data["cycle"], int(data["count"])
        except (ValueError, KeyError, TypeError) as exc:
            raise ChordProviderError(
                f"Klangio quota file {self.path.name} is corrupt; refusing to spend "
                "(fix or delete it after checking the dashboard count)"
            ) from exc
        return count if stored_cycle == cycle else 0  # new billing cycle -> reset


# One statement, no read-then-write. A returned row means the slot was granted;
# no row means the cycle is at the cap. ``ON CONFLICT DO UPDATE`` locks the
# conflicting row, so a concurrent reserver waits and then re-evaluates the WHERE
# against the committed count (READ COMMITTED) instead of both taking the last
# slot. ``WHERE %(cap)s > 0`` is needed because the first INSERT of a cycle never
# evaluates the DO UPDATE ... WHERE: without it a cap of 0 would admit one request.
_RESERVE_SQL = """
INSERT INTO public.klangio_usage (cycle_start, count)
SELECT %(cycle)s::date, 1
WHERE %(cap)s::int > 0
ON CONFLICT (cycle_start) DO UPDATE
  SET count = klangio_usage.count + 1, updated_at = now()
  WHERE klangio_usage.count < %(cap)s::int
RETURNING count
"""
_PEEK_SQL = "SELECT count FROM public.klangio_usage WHERE cycle_start = %(cycle)s::date"
_PG_CONNECT_TIMEOUT_SEC = 5


class _PostgresQuotaStore:
    """Durable, cross-instance counter in ``public.klangio_usage`` (migration 028).

    Survives deploys and is shared by every worker instance. Fails closed: any
    database error raises ``ChordProviderError`` and no request is sent.
    """

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    def reserve(self, cycle: str, cap: int) -> tuple[int, bool]:
        import psycopg  # noqa: PLC0415 — only needed when this store is selected

        params = {"cycle": cycle, "cap": cap}
        try:
            # autocommit: the single statement is its own transaction, so the row
            # lock is released the moment the increment is durable.
            with psycopg.connect(
                self._dsn, autocommit=True, connect_timeout=_PG_CONNECT_TIMEOUT_SEC
            ) as conn:
                row = conn.execute(_RESERVE_SQL, params).fetchone()
                if row is not None:
                    return int(row[0]), True
                # Refused. The peek is informational only (for the message/log).
                peek = conn.execute(_PEEK_SQL, params).fetchone()
                return (int(peek[0]) if peek else 0), False
        except psycopg.Error as exc:
            # Fail closed: if we cannot account for spend, we do not spend.
            raise ChordProviderError(
                f"Klangio quota database unusable ({type(exc).__name__}); refusing to spend"
            ) from exc


def _default_quota_store() -> _QuotaStore:
    """Pick the counter backend from config.

    ``KLANGIO_QUOTA_BACKEND``: ``postgres`` | ``file`` | unset/``auto``. Auto uses
    Postgres when ``DATABASE_URL`` is set, else the file store (local/dev).
    """
    backend = os.environ.get("KLANGIO_QUOTA_BACKEND", "").strip().lower() or "auto"
    if backend not in ("auto", "postgres", "file"):
        raise ChordProviderError(
            f"KLANGIO_QUOTA_BACKEND={backend[:16]!r} invalid; expected auto|postgres|file"
        )
    dsn = os.environ.get("DATABASE_URL", "").strip()
    if backend == "postgres" and not dsn:
        # Fail closed rather than silently fall back to a counter that resets.
        raise ChordProviderError("KLANGIO_QUOTA_BACKEND=postgres but DATABASE_URL is not set")
    if backend == "postgres" or (backend == "auto" and dsn):
        return _PostgresQuotaStore(dsn)
    path = os.environ.get("KLANGIO_QUOTA_FILE", "").strip() or str(
        Path(tempfile.gettempdir()) / "klangio_quota.json"
    )
    return FileQuotaStore(Path(path))


def _reserve_quota(store: _QuotaStore) -> None:
    """Count one billable submit against the cycle allowance, or refuse.

    Called immediately before the POST. Raises ``ChordQuotaExceeded`` at the cap
    (no request is sent) and logs a warning from the warn threshold upward.
    """
    cap = _env_int("KLANGIO_MONTHLY_CAP", MONTHLY_CAP_DEFAULT)
    warn_at = _env_fraction("KLANGIO_WARN_FRACTION", WARN_FRACTION_DEFAULT)
    billing_day = _env_int("KLANGIO_BILLING_DAY", BILLING_DAY_DEFAULT)
    cycle = billing_cycle_start(_utcnow().date(), billing_day).isoformat()

    count, granted = store.reserve(cycle, cap)
    if not granted:
        log_structured(
            "ERROR",
            "klangio_quota",
            outcome="refused_at_cap",
            count=count,
            cap=cap,
            cycle_start=cycle,
        )
        raise ChordQuotaExceeded(
            f"Klangio monthly cap reached ({count}/{cap}, cycle from {cycle}); request not sent. "
            "Raise KLANGIO_MONTHLY_CAP to accept overage ($0.20/request)."
        )
    near = count >= warn_at * cap
    log_structured(
        "WARNING" if near else "INFO",
        "klangio_quota",
        outcome="reserved",
        count=count,
        cap=cap,
        cycle_start=cycle,
        pct=round(100 * count / cap, 1) if cap else None,
        near_cap=near,
    )


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
    quota_store: _QuotaStore | None = None  # defaults per _default_quota_store() (env-configured)

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
        # Read once up front (bytes, not an open handle).
        audio_bytes = audio_path.read_bytes()
        # Count BEFORE sending: if the response is lost we may still have paid.
        _reserve_quota(self.quota_store or _default_quota_store())
        resp = _request_with_retry(
            client,
            method="POST",
            url="/chord-recognition",
            retry=False,  # no idempotency key exists: a retry could double-bill
            params={"vocabulary": vocabulary},
            files={"file": (audio_path.name, audio_bytes, _audio_mime(audio_path))},
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
    retry: bool = True,
    **kwargs: Any,
) -> httpx.Response:
    """Issue an HTTP call with exponential-backoff-plus-jitter retry.

    Retries on 429, 5xx and transport errors up to ``MAX_RETRIES`` — but only when
    ``retry`` is true. The billable submit POST passes ``retry=False``: exactly one
    attempt, any failure surfaces to the caller. 402 is translated to
    ``ChordQuotaExceeded`` and raised immediately (terminal — never retried).
    Other 4xxs are ``ChordProviderError`` (also terminal).
    """
    last_exc: Exception | None = None
    max_retries = MAX_RETRIES if retry else 0
    for attempt in range(max_retries + 1):
        _throttle()  # every attempt (including retries) counts against 2 req/s
        try:
            resp = client.request(method, url, timeout=HTTP_TIMEOUT_SEC, **kwargs)
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            last_exc = exc
            if attempt >= max_retries:
                raise ChordProviderError(
                    f"Klangio {method} {url} transport failure after "
                    f"{attempt + 1} attempt(s): {exc}"
                    + ("" if retry else " (not retried: a billed job may exist)")
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
            if attempt >= max_retries:
                raise ChordProviderError(
                    f"Klangio {method} {url} HTTP {status} after "
                    f"{attempt + 1} attempt(s)"
                    + ("" if retry else " (not retried: a billed job may exist)")
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
# Parse policy (see docs/ops/chord-recognition.md "Response parsing policy").
# Pre-revenue, ~10 users, a wasted request costs $0.20 that is already spent: we
# keep every row we can PROVE is sane and drop the rest, loudly. A dropped row
# leaves an honest gap on the timeline (timestamps are absolute, so later chords
# do not slide); a repaired-by-guessing row would be a confident wrong chord.
# Only a response with rows but ZERO survivors raises, since an empty track from
# a non-empty answer is a total silent failure.
X_FRACTION_WARN = 0.30  # >=30% X labels logs at WARNING (bad stem / vocab mismatch)
_BAD_SAMPLE_MAX = 5


def _coerce_time(value: Any) -> float | None:
    """Finite float or None. Rejects bool (True is not 1.0 seconds), NaN and +-Inf.

    Python's ``json`` accepts bare ``NaN`` / ``Infinity`` on parse, so they can arrive;
    serialised back with ``json.dumps`` they become invalid JSON (``allow_nan``).
    """
    if isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _parse_klangio_response(payload: Any, *, model_ms: int) -> ChordResult:
    """Map Klangio's result array ``[[start, end, label], ...]`` onto ChordResult.

    Per-row policy: drop (counted by reason) rows that are not a 3+ element list,
    have a non-finite/non-numeric start or end, a negative end, or ``end <= start``.
    Repair (counted): a slightly negative start is clamped to 0; out-of-order rows are
    sorted by start; an overlap is resolved by trimming the earlier segment's end to
    the later segment's start (a later row with the same start as its predecessor is
    dropped as a duplicate). Unrecognised labels become ``X`` (counted, not dropped).
    """
    if not isinstance(payload, list):
        raise ChordProviderError(f"Klangio result was not a JSON array: {type(payload).__name__}")
    dropped: dict[str, int] = {}
    bad_samples: list[str] = []

    def drop(reason: str, row: Any) -> None:
        dropped[reason] = dropped.get(reason, 0) + 1
        if len(bad_samples) < _BAD_SAMPLE_MAX:
            bad_samples.append(repr(row)[:60])

    x_labels = 0
    x_examples: list[str] = []
    repaired = {"clamped_negative_start": 0, "reordered": 0, "overlap_trimmed": 0}
    parsed: list[tuple[float, float, str]] = []
    for row in payload:
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            drop("bad_shape", row)
            continue
        start = _coerce_time(row[0])
        end = _coerce_time(row[1])
        if start is None or end is None:
            drop("non_numeric_or_non_finite_time", row)
            continue
        if end <= 0:
            drop("negative_end", row)
            continue
        if end <= start:
            drop("end_not_after_start", row)
            continue
        if start < 0:
            start = 0.0
            repaired["clamped_negative_start"] += 1
        label = str(row[2]).strip()
        if not is_valid_harte_label(label):
            # Unknown qualities (e.g. 'C:maj99', 'N.C.') map to the X ("unrecognised")
            # bucket so downstream readers don't choke on the contract.
            x_labels += 1
            if len(x_examples) < _BAD_SAMPLE_MAX:
                x_examples.append(label[:24])
            label = "X"
        parsed.append((start, end, label))

    if any(parsed[i][0] > parsed[i + 1][0] for i in range(len(parsed) - 1)):
        parsed.sort(key=lambda t: t[0])  # stable: ties keep wire order
        repaired["reordered"] = 1

    segments: list[ChordSegment] = []
    for start, end, label in parsed:
        if segments:
            prev = segments[-1]
            if start < prev.end_sec:
                if start <= prev.start_sec:
                    drop("duplicate_start", [start, end, label])
                    continue
                segments[-1] = replace(prev, end_sec=start)
                repaired["overlap_trimmed"] += 1
        segments.append(
            ChordSegment(
                start_sec=start,
                end_sec=end,
                label=label,
                confidence=1.0,  # TODO Y1.2: Klangio publishes no confidence
            )
        )

    n_dropped = sum(dropped.values())
    n_repaired = sum(repaired.values())
    x_fraction = round(x_labels / len(segments), 3) if segments else 0.0
    noisy = bool(n_dropped or n_repaired or x_fraction >= X_FRACTION_WARN)
    log_structured(
        "WARNING" if noisy else "INFO",
        "klangio_parse_summary",
        rows_total=len(payload),
        rows_kept=len(segments),
        rows_dropped_malformed=n_dropped,
        dropped_by_reason=dropped,
        labels_mapped_to_x=x_labels,
        x_fraction=x_fraction,
        segments_repaired=n_repaired,
        repaired_by_kind=repaired,
        bad_row_samples=bad_samples,
        x_label_samples=x_examples,
    )
    if payload and not segments:
        raise ChordProviderError(
            f"Klangio returned {len(payload)} rows but none were usable "
            f"(dropped_by_reason={dropped})"
        )

    return ChordResult(
        segments=segments,
        key=None,  # the chord-recognition result carries no key
        provider="klangio",
        provider_version=PROVIDER_VERSION,
        duration_sec=max((seg.end_sec for seg in segments), default=0.0),
        model_ms=model_ms,
    )
