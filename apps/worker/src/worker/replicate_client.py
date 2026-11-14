"""Idempotent Replicate client for htdemucs_6s stem separation (T11).

Idempotency (PRD draft-2 hardening): the Replicate prediction id is persisted on
the job row the moment it is created, and re-attached on any retry — so a retried
job never submits a second prediction and is never double-charged.

Stem-label rule (LOCKED): htdemucs_6s emits a 'piano' stem INTERNALLY ONLY. The
contract uses 'keys' everywhere (UI, DB, R2 filenames), so outputs are renamed
piano→keys here before they leave this module.

Live Replicate calls land in P2-12+; P2-11 exercises this with mocks only.

Spend safety (this module owns it, because pipeline.py only sees a successful return):
  * A prediction we abandon (poll budget exhausted, non-429 4xx on the poll) is CANCELLED on
    Replicate, otherwise it keeps running and billing for nothing. A transient poll failure
    (5xx / 429 / transport) is retried, never a reason to cancel on its own.
  * Whatever a prediction actually cost is written ONCE to job_events.detail.cost_usd (which
    the 24h spend ceiling sums) - on success, on failure/cancel and on abandonment - keyed by
    prediction id, so a reaper rerun can never add a second event for the same spend.
  * A POST is preceded by a durable 'pending:<ts>' marker in jobs.replicate_prediction_id, so
    a crash between POST and persisting the id can never silently trigger a second paid POST.
"""

import os
import re
import time
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

import httpx
import psycopg
from psycopg.types.json import Json

from .errors import SeparationFailedError
from .logger import log_structured


class SeparationTimeout(Exception):
    """Poll deadline hit while the Replicate prediction is STILL running — RETRYABLE.
    The prediction keeps executing server-side, so re-polling the same prediction_id
    (idempotent re-attach: no second prediction, no double charge) can still succeed.
    Distinct from SeparationFailedError, which is a terminal Replicate failure/cancel.

    Also raised when Replicate's poll GET keeps failing transiently (5xx / 429 / transport)
    for longer than POLL_TRANSIENT_BUDGET_S: we cannot see the prediction, but nothing says it
    failed, so it is re-polled rather than cancelled. failure_reason says which case it was."""

    def __init__(self, message: str, *, failure_reason: str = "poll_deadline"):
        super().__init__(message)
        self.failure_reason = failure_reason


API = "https://api.replicate.com/v1"
# Separation poll ceiling. Kept UNDER the 60s Gate-2 e2e target (55s = ~5s headroom,
# not right at the edge) so a cold-start prediction that lands in the 45-60s band still
# completes instead of spuriously failing mid-audition. Overridable via REPLICATE_DEADLINE.
HARD_DEADLINE = int(os.environ.get("REPLICATE_DEADLINE", "55"))
POLL_INTERVAL = 2
# Transient poll failures (GET /predictions/{id} -> 5xx, 429, or a transport error) are retried
# with exponential backoff 2, 4, 8, 8... s, and the counter resets after any successful poll.
# Prod 2026-11-14: Replicate 502s arrive in bursts of several seconds; the old one-retry rule
# cancelled two healthy predictions. 20 s of UNBROKEN failures (about 5 GETs on the backoff
# schedule) outlasts those bursts with margin while leaving most of the 55 s HARD_DEADLINE;
# past it the poll ends as a retryable SeparationTimeout (pipeline re-polls the SAME
# prediction), never as a terminal failure. Overridable via REPLICATE_POLL_TRANSIENT_BUDGET.
POLL_BACKOFF_BASE = 2.0
POLL_BACKOFF_CAP = 8.0
POLL_TRANSIENT_BUDGET_S = float(os.environ.get("REPLICATE_POLL_TRANSIENT_BUDGET", "20"))
# During the (up to HARD_DEADLINE-long) separation poll, bump jobs.updated_at so the
# orphan reaper (reaper.py) can tell a LIVE separation apart from a worker that died
# mid-job. Must be << REAPER_STALE_SECONDS (default 300s).
HEARTBEAT_SECONDS = int(os.environ.get("SEPARATION_HEARTBEAT_SECONDS", "20"))
# htdemucs_6s → contract mapping. 'piano' is internal-only; everything else uses 'keys'.
STEM_RENAME = {"piano": "keys"}
# Replicate version hash for ryan5453/demucs — the verified default (Gate-2 /
# upload-MVP spike). Non-secret; override via REPLICATE_MODEL_VERSION to bump it.
DEFAULT_DEMUCS_VERSION = "5a7041cc9b82e5a558fea6b3d7b12dea89625e89da33f0447bd727c2d0ab9e77"
MODEL_VERSION = os.environ.get("REPLICATE_MODEL_VERSION", DEFAULT_DEMUCS_VERSION)
# pipeline.py re-polls the SAME prediction after a SeparationTimeout up to this many times
# (same env var + default as pipeline.SEPARATION_MAX_ATTEMPTS). The prediction is only
# cancelled once that budget is spent, never between those polls.
SEPARATION_MAX_ATTEMPTS = int(os.environ.get("SEPARATION_MAX_ATTEMPTS", "3"))
# jobs.replicate_prediction_id value written BEFORE the POST (see submit_or_reattach).
PENDING_PREFIX = "pending:"
_TERMINAL = ("succeeded", "failed", "canceled")
_EPS = 1e-9
# pred_id -> poll-budget timeouts seen in this process.
_timeouts: dict[str, int] = {}
DEMUCS_MODEL = os.environ.get("REPLICATE_DEMUCS_MODEL", "htdemucs_6s")


# SL-B15 cost rate (USD per second of GPU prediction time). Was a hard-coded 0.0005.
# Source: https://replicate.com/pricing, row "Nvidia A100 (80GB) GPU / gpu-a100-large":
# "$0.001400 /sec, $5.04 /hr", fetched 2026-11-02. The model page
# https://replicate.com/ryan5453/demucs says it "runs on Nvidia A100 (40GB) GPU hardware"
# (fetched 2026-11-02); the pricing page lists no A100 40GB row, so the A100 list rate is
# used. Replicate's usage page (account) is the final check: override with
# REPLICATE_USD_PER_SECOND if it shows a different effective rate.
DEFAULT_REPLICATE_USD_PER_SECOND = 0.0014


def _load_usd_per_second() -> float:
    raw = os.environ.get("REPLICATE_USD_PER_SECOND")
    if raw is None or raw.strip() == "":
        return DEFAULT_REPLICATE_USD_PER_SECOND
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    if not value > 0:  # also rejects nan/inf-adjacent junk and negatives
        log_structured(
            "WARN", "replicate_rate_override_invalid", using=DEFAULT_REPLICATE_USD_PER_SECOND
        )
        return DEFAULT_REPLICATE_USD_PER_SECOND
    return value


REPLICATE_USD_PER_SECOND = _load_usd_per_second()


def prediction_cost_usd(predict_time_s: float) -> float:
    """Cost of one prediction from Replicate's metrics.predict_time (seconds)."""
    return predict_time_s * REPLICATE_USD_PER_SECOND


def _headers() -> dict:
    return {
        "Authorization": f"Token {os.environ['REPLICATE_API_TOKEN']}",
        "Content-Type": "application/json",
    }


def _db():
    return psycopg.connect(os.environ["DATABASE_URL"])


def get_prediction_id(job_id: str) -> str | None:
    with _db() as conn:
        row = conn.execute(
            "SELECT replicate_prediction_id FROM jobs WHERE id=%s", (job_id,)
        ).fetchone()
        return row[0] if row else None


def set_prediction_id(job_id: str, pred_id: str) -> None:
    with _db() as conn:
        conn.execute("UPDATE jobs SET replicate_prediction_id=%s WHERE id=%s", (pred_id, job_id))
        conn.commit()


def _heartbeat(job_id: str) -> None:
    """Best-effort liveness bump so the reaper doesn't treat a live separation as
    an orphan. Never let a heartbeat blip abort the separation."""
    try:
        with _db() as conn:
            conn.execute("UPDATE jobs SET updated_at=now() WHERE id=%s", (job_id,))
            conn.commit()
    except Exception as exc:  # noqa: BLE001
        log_structured("WARN", "separation_heartbeat_failed", job_id=job_id, error=str(exc)[:120])


def _parse_ts(value) -> datetime | None:
    """Replicate timestamps are ISO-8601 with up to 9 fractional digits and a 'Z'."""
    if not value or not isinstance(value, str):
        return None
    v = re.sub(r"(\.\d{6})\d+", r"\1", value.strip().replace("Z", "+00:00"))
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _spend_usd(pred: dict | None) -> float:
    """What a prediction has actually cost so far: Replicate's metrics.predict_time when it
    reports one, else wall-clock since it started running. A prediction that never left the
    queue (no started_at) has cost nothing."""
    if not pred:
        return 0.0
    pt = (pred.get("metrics") or {}).get("predict_time")
    if isinstance(pt, (int, float)) and pt > 0:
        return prediction_cost_usd(float(pt))
    started = _parse_ts(pred.get("started_at"))
    if started is None:
        return 0.0
    completed = _parse_ts(pred.get("completed_at")) or datetime.now(UTC)
    return prediction_cost_usd(max(0.0, (completed - started).total_seconds()))


def _record_cost_or_raise(
    job_id: str, pred_id: str, cost_usd: float, reason: str, phase: str
) -> float:
    with _db() as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"replicate_cost:{job_id}",))
        prior = conn.execute(
            "SELECT COALESCE(SUM((detail->>'cost_usd')::numeric), 0) FROM job_events "
            "WHERE job_id = %s AND stage = 'separating' AND detail->>'cost_usd' IS NOT NULL",
            (job_id,),
        ).fetchone()[0]
        delta = round(float(cost_usd) - float(prior), 6)
        if delta <= _EPS:
            conn.commit()
            return 0.0
        conn.execute(
            "INSERT INTO job_events(job_id, stage, phase, pct, detail) "
            "VALUES (%s, 'separating', %s, NULL, %s)",
            (
                job_id,
                phase,
                Json(
                    {
                        "cost_usd": delta,
                        "prediction_id": pred_id,
                        "reason": reason,
                        "total_cost_usd": round(float(cost_usd), 6),
                    }
                ),
            ),
        )
        conn.commit()
    log_structured(
        "INFO",
        "replicate_cost_recorded",
        job_id=job_id,
        pred_id=pred_id,
        cost_usd=delta,
        reason=reason,
    )
    return delta


def record_prediction_cost(
    job_id: str, pred_id: str, cost_usd: float, reason: str, phase: str = "failed"
) -> float:
    """Persist a prediction's spend to job_events ONCE per job. Returns the USD newly written.

    Idempotent: one job has exactly one prediction, and every cost event already written for
    the job (by an earlier run, an abandonment, or pipeline.py's own success event) is summed
    first; only the shortfall is inserted. A rerun therefore cannot double-count, and a spend
    that grows after an early estimate (a cancel that lands late) is topped up, not repeated.
    Serialised per job by an advisory lock. Best-effort: a DB blip is logged and returns 0.0
    (on a failure path a bookkeeping error must not mask the real one)."""
    try:
        return _record_cost_or_raise(job_id, pred_id, cost_usd, reason, phase)
    except Exception as exc:  # noqa: BLE001
        log_structured(
            "ERROR",
            "replicate_cost_record_failed",
            job_id=job_id,
            pred_id=pred_id,
            error=str(exc)[:160],
        )
        return 0.0


def _cancel_prediction(pred_id: str) -> dict | None:
    """POST /predictions/{id}/cancel. Returns the prediction JSON, or None if it failed
    (best-effort: the caller is already on a failure path)."""
    try:
        r = httpx.post(f"{API}/predictions/{pred_id}/cancel", headers=_headers(), timeout=15)
        r.raise_for_status()
        log_structured("WARN", "replicate_cancelled", pred_id=pred_id)
        return r.json()
    except Exception as exc:  # noqa: BLE001
        log_structured("ERROR", "replicate_cancel_failed", pred_id=pred_id, error=str(exc)[:160])
        return None


def _abandon(job_id: str, pred_id: str, reason: str, last_pred: dict | None) -> dict | None:
    """Stop paying for a prediction we are giving up on, and book what it cost.

    Returns the prediction JSON ONLY if cancelling lost the race and it had already succeeded
    (the caller should then use it instead of failing); otherwise None."""
    pred = last_pred
    if not pred or pred.get("status") not in _TERMINAL:
        cancelled = _cancel_prediction(pred_id)
        if cancelled is not None:
            if cancelled.get("status") == "succeeded":
                return cancelled
            pred = cancelled
    record_prediction_cost(job_id, pred_id, _spend_usd(pred), reason)
    return None


def _book_success(job_id: str, pred_id: str, pred: dict) -> float:
    """Success path: book the full cost durably (idempotent) and return what the caller must
    still persist. Normally 0.0 - the cost is already in job_events, so pipeline.py's own
    separating/completed event must not add it again. If the write fails the full amount is
    returned so that event still carries it."""
    cost = _spend_usd(pred)
    try:
        _record_cost_or_raise(job_id, pred_id, cost, "succeeded", "completed")
    except Exception as exc:  # noqa: BLE001 - no DB / outage: hand the cost to the caller
        log_structured("WARN", "replicate_cost_record_failed", job_id=job_id, error=str(exc)[:120])
        return cost
    return 0.0


def _claim_submission(job_id: str, marker: str) -> bool:
    with _db() as conn:
        row = conn.execute(
            "UPDATE jobs SET replicate_prediction_id=%s "
            "WHERE id=%s AND replicate_prediction_id IS NULL RETURNING id",
            (marker, job_id),
        ).fetchone()
        conn.commit()
        return row is not None


def _clear_marker(job_id: str, marker: str) -> None:
    with _db() as conn:
        conn.execute(
            "UPDATE jobs SET replicate_prediction_id=NULL WHERE id=%s AND replicate_prediction_id=%s",
            (job_id, marker),
        )
        conn.commit()


def _resolve_pending(job_id: str, audio_url: str, marker: str) -> str:
    """A previous attempt wrote the marker and may or may not have reached Replicate's POST.
    Look for the prediction it would have created and adopt it; if there is not exactly one
    candidate FAIL CLOSED - a second paid prediction is worse than a failed job."""
    since = _parse_ts(marker[len(PENDING_PREFIX) :])
    want_path = urlsplit(audio_url).path
    matches: list[str] = []
    try:
        r = httpx.get(f"{API}/predictions", headers=_headers(), timeout=30)
        r.raise_for_status()
        for p in r.json().get("results", []):
            created = _parse_ts(p.get("created_at"))
            if since and created and (created - since).total_seconds() < -5:
                continue
            if p.get("version") != MODEL_VERSION:
                continue
            if urlsplit(str((p.get("input") or {}).get("audio", ""))).path != want_path:
                continue
            matches.append(p["id"])
    except Exception as exc:  # noqa: BLE001
        log_structured(
            "ERROR", "replicate_pending_lookup_failed", job_id=job_id, error=str(exc)[:160]
        )
        matches = []
    if len(matches) == 1:
        set_prediction_id(job_id, matches[0])
        log_structured("WARN", "replicate_pending_adopted", job_id=job_id, pred_id=matches[0])
        return matches[0]
    log_structured(
        "ERROR",
        "replicate_pending_unresolved",
        job_id=job_id,
        marker=marker,
        candidates=len(matches),
    )
    raise SeparationFailedError(
        f"a Replicate submission for this job may already exist (marker {marker}, "
        f"{len(matches)} candidates); refusing to submit and pay twice"
    )


def submit_or_reattach(job_id: str, audio_url: str) -> str:
    """Submit a new prediction or re-attach an existing one. Returns prediction_id."""
    for _ in range(3):
        existing = get_prediction_id(job_id)
        if existing and existing.startswith(PENDING_PREFIX):
            return _resolve_pending(job_id, audio_url, existing)
        if existing:
            log_structured("INFO", "replicate_reattach", job_id=job_id, pred_id=existing)
            return existing
        # Durable intent BEFORE the paid call; the conditional UPDATE also arbitrates two
        # workers racing on the same job. Whoever loses re-reads and takes the branches above.
        marker = f"{PENDING_PREFIX}{datetime.now(UTC).isoformat()}"
        if _claim_submission(job_id, marker):
            break
    else:
        raise SeparationFailedError("could not claim Replicate submission for job")
    try:
        r = httpx.post(
            f"{API}/predictions",
            json={
                "version": MODEL_VERSION,
                "input": {
                    "audio": audio_url,
                    "model": DEMUCS_MODEL,  # htdemucs_6s → emits a 'piano' stem (→ keys)
                    "stem": "none",  # separate all stems
                    "output_format": "wav",
                },
            },
            headers=_headers(),
            timeout=30,
        )
        r.raise_for_status()
        pred_id = r.json()["id"]
    except (httpx.ConnectError, httpx.HTTPStatusError) as exc:
        # Provably not created (never connected / 4xx): safe to let a retry submit again.
        # A timeout, 5xx or any ambiguous failure KEEPS the marker so the retry fails closed.
        if isinstance(exc, httpx.ConnectError) or exc.response.status_code < 500:
            _clear_marker(job_id, marker)
        raise
    set_prediction_id(job_id, pred_id)
    log_structured("INFO", "replicate_submitted", job_id=job_id, pred_id=pred_id)
    return pred_id


def _poll_budget_spent(pred_id: str, pred: dict | None) -> bool:
    """True once this prediction has used its whole retry budget (HARD_DEADLINE x
    SEPARATION_MAX_ATTEMPTS). Counts timeouts seen in-process AND uses Replicate's own
    created_at, so a reaper rerun in a fresh process does not get a fresh budget."""
    n = _timeouts[pred_id] = _timeouts.get(pred_id, 0) + 1
    if n >= SEPARATION_MAX_ATTEMPTS:
        return True
    created = _parse_ts((pred or {}).get("created_at"))
    if created is not None:
        return (
            datetime.now(UTC) - created
        ).total_seconds() >= HARD_DEADLINE * SEPARATION_MAX_ATTEMPTS
    return False


def _is_transient_status(code: int) -> bool:
    """5xx and 429 on a poll GET say nothing about the prediction itself: retry, don't cancel."""
    return code == 429 or code >= 500


def _retry_after_s(resp) -> float | None:
    """Seconds from a Retry-After header (delta-seconds or HTTP-date), else None."""
    headers = getattr(resp, "headers", None) or {}
    raw = headers.get("Retry-After") or headers.get("retry-after")
    if not raw:
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        try:
            when = parsedate_to_datetime(str(raw))
        except (TypeError, ValueError, IndexError):
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        value = (when - datetime.now(UTC)).total_seconds()
    return max(0.0, value)


def poll_until_done(job_id: str, pred_id: str, progress_cb=None) -> tuple[dict, float]:
    """Poll a prediction until it succeeds/fails. Returns ({stem: url} (piano→keys), cost_usd).

    cost_usd is the spend NOT YET persisted to job_events (see record_prediction_cost): the
    cost itself is booked here, once, so callers that also emit it (pipeline.py) add 0.0 rather
    than a duplicate. Abandoning the prediction cancels it on Replicate.

    A poll GET that fails transiently (5xx, 429, transport) is retried with backoff; an unbroken
    run longer than POLL_TRANSIENT_BUDGET_S ends this poll as a retryable SeparationTimeout,
    exactly like the deadline. A non-429 4xx is terminal (cancel + SeparationFailedError)."""
    deadline = time.monotonic() + HARD_DEADLINE
    last_hb = time.monotonic()
    transient_n = 0  # consecutive transient failures in the CURRENT run; reset on success
    transient_since: float | None = None
    pred: dict | None = None
    while time.monotonic() < deadline:
        if time.monotonic() - last_hb >= HEARTBEAT_SECONDS:
            _heartbeat(job_id)
            last_hb = time.monotonic()
        transient: str | None = None
        retry_after: float | None = None
        try:
            r = httpx.get(f"{API}/predictions/{pred_id}", headers=_headers(), timeout=15)
            r.raise_for_status()
            pred = r.json()
        except httpx.HTTPStatusError as e:
            code = e.response.status_code
            if _is_transient_status(code):
                transient = f"poll_http_{code}"
                if code == 429:
                    retry_after = _retry_after_s(e.response)
            else:
                reason = f"poll_http_{code}"
                won = _abandon(job_id, pred_id, reason, pred)
                if won is None:
                    raise SeparationFailedError(
                        f"Replicate HTTP {code}", failure_reason=reason
                    ) from e
                pred = won
        except httpx.TransportError as e:
            transient = "poll_transport_error"
            log_structured(
                "WARN", "replicate_poll_transport_error", pred_id=pred_id, error=str(e)[:120]
            )

        if transient is not None:
            now = time.monotonic()
            transient_n += 1
            if transient_since is None:
                transient_since = now
            run_s = now - transient_since
            if run_s >= POLL_TRANSIENT_BUDGET_S:
                log_structured(
                    "WARN",
                    "replicate_poll_transient_exhausted",
                    job_id=job_id,
                    pred_id=pred_id,
                    reason=transient,
                    consecutive=transient_n,
                    run_s=round(run_s, 1),
                )
                break
            backoff = min(POLL_BACKOFF_BASE * 2 ** (transient_n - 1), POLL_BACKOFF_CAP)
            wait = retry_after if retry_after is not None else backoff
            wait = max(0.0, min(wait, deadline - now))
            log_structured(
                "WARN",
                "replicate_poll_transient_retry",
                job_id=job_id,
                pred_id=pred_id,
                reason=transient,
                consecutive=transient_n,
                wait_s=round(wait, 2),
                retry_after_s=retry_after,
            )
            time.sleep(wait)
            continue
        if transient_n:
            log_structured(
                "INFO",
                "replicate_poll_recovered",
                job_id=job_id,
                pred_id=pred_id,
                after_failures=transient_n,
            )
            transient_n = 0
            transient_since = None

        status = pred.get("status")
        if progress_cb and status == "processing":
            elapsed = time.monotonic() - (deadline - HARD_DEADLINE)
            pct = int(15 + min(elapsed / HARD_DEADLINE, 1.0) * 55)
            progress_cb(job_id, pct)

        if status == "succeeded":
            outputs = pred.get("output", {}) or {}
            predict_time = pred.get("metrics", {}).get("predict_time", 0) or 0
            cost = prediction_cost_usd(predict_time)
            log_structured(
                "INFO",
                "separation_complete",
                job_id=job_id,
                cost_usd=round(cost, 4),
                latency_ms=int(predict_time * 1000),
            )
            _timeouts.pop(pred_id, None)
            return {STEM_RENAME.get(k, k): v for k, v in outputs.items()}, round(
                _book_success(job_id, pred_id, pred), 4
            )
        if status in ("failed", "canceled"):
            # Replicate bills a failed run for the time it ran: book it before raising.
            record_prediction_cost(job_id, pred_id, _spend_usd(pred), f"prediction_{status}")
            _timeouts.pop(pred_id, None)
            raise SeparationFailedError(
                str(pred.get("error", "unknown")), failure_reason=f"prediction_{status}"
            )
        time.sleep(POLL_INTERVAL)

    # Deadline hit (or the poll GET kept failing transiently) and the prediction was not seen to
    # fail. Retryable while the retry budget lasts; once it is spent the prediction is
    # CANCELLED so it stops billing. A transient outage spends the budget like a slow run does,
    # so a long Replicate outage still ends in a cancel + terminal failure, just not on attempt 1.
    end_reason = "poll_transient_exhausted" if transient_n else "poll_deadline"
    if _poll_budget_spent(pred_id, pred):
        _timeouts.pop(pred_id, None)
        won = _abandon(job_id, pred_id, "poll_budget_exhausted", pred)
        if won is not None:  # cancel lost the race: it finished after all
            outputs = won.get("output", {}) or {}
            return {STEM_RENAME.get(k, k): v for k, v in outputs.items()}, round(
                _book_success(job_id, pred_id, won), 4
            )
        raise SeparationFailedError(
            f"separation exceeded its time budget ({end_reason}); prediction {pred_id} cancelled",
            failure_reason="poll_budget_exhausted",
        )
    raise SeparationTimeout(
        f"poll ended ({end_reason}) after up to {HARD_DEADLINE}s; prediction still running",
        failure_reason=end_reason,
    )
