"""Idempotent Replicate client for htdemucs_6s stem separation (T11).

Idempotency (PRD draft-2 hardening): the Replicate prediction id is persisted on
the job row the moment it is created, and re-attached on any retry — so a retried
job never submits a second prediction and is never double-charged.

That guarantee used to be check-then-act (SELECT; if empty POST; UPDATE), which
holds for a SEQUENTIAL retry but not for two workers on one job — exactly what a
reaper re-queue of a merely-slow worker produces (hardening review H8/H1). Both
could read "no prediction yet" and both submit, double-billing, with the DB
keeping only the last write and the other prediction running untracked.

The claim is now atomic (H8): a worker writes a `claiming:<uuid>` token with
`UPDATE … WHERE replicate_prediction_id IS NULL` and only POSTs to Replicate if
that write won the row. A worker that loses the race never POSTs — it re-reads
and re-attaches to the winner's prediction. A claim that is never resolved (the
claimer died mid-submit) is taken over after CLAIM_TAKEOVER_SECONDS, which is
deliberately longer than the submit timeout so a slow claimer is never overtaken.

Stem-label rule (LOCKED): htdemucs_6s emits a 'piano' stem INTERNALLY ONLY. The
contract uses 'keys' everywhere (UI, DB, R2 filenames), so outputs are renamed
piano→keys here before they leave this module.

Live Replicate calls land in P2-12+; P2-11 exercises this with mocks only.
"""

import os
import time
import uuid

import httpx
import psycopg

from .errors import SeparationFailedError
from .job_state import heartbeat
from .logger import log_structured


class SeparationTimeout(Exception):
    """Poll deadline hit while the Replicate prediction is STILL running — RETRYABLE.
    The prediction keeps executing server-side, so re-polling the same prediction_id
    (idempotent re-attach: no second prediction, no double charge) can still succeed.
    Distinct from SeparationFailedError, which is a terminal Replicate failure/cancel."""


API = "https://api.replicate.com/v1"
# Separation poll ceiling. Kept UNDER the 60s Gate-2 e2e target (55s = ~5s headroom,
# not right at the edge) so a cold-start prediction that lands in the 45-60s band still
# completes instead of spuriously failing mid-audition. Overridable via REPLICATE_DEADLINE.
HARD_DEADLINE = int(os.environ.get("REPLICATE_DEADLINE", "55"))
POLL_INTERVAL = 2
# During the (up to HARD_DEADLINE-long) separation poll, bump jobs.updated_at so the
# orphan reaper (reaper.py) can tell a LIVE separation apart from a worker that died
# mid-job. Must be << REAPER_STALE_SECONDS (default 300s).
HEARTBEAT_SECONDS = int(os.environ.get("SEPARATION_HEARTBEAT_SECONDS", "20"))
# htdemucs_6s → contract mapping. 'piano' is internal-only; everything else uses 'keys'.
STEM_RENAME = {"piano": "keys"}
# Timeout on the submit POST itself. The takeover window below must exceed it.
SUBMIT_TIMEOUT = int(os.environ.get("REPLICATE_SUBMIT_TIMEOUT", "30"))
# A claim token parks the row while its owner is mid-POST. It is never a real
# prediction id, and poll_until_done never sees one.
CLAIM_PREFIX = "claiming:"
# How long to wait for the claim holder to publish its real prediction id before
# assuming it died mid-submit and taking the claim over. > SUBMIT_TIMEOUT so a
# merely-slow claimer is never overtaken (that would re-introduce a double submit).
CLAIM_TAKEOVER_SECONDS = int(os.environ.get("REPLICATE_CLAIM_TAKEOVER_SECONDS", "45"))
CLAIM_POLL_INTERVAL = 1.0
# Replicate version hash for ryan5453/demucs — the verified default (Gate-2 /
# upload-MVP spike). Non-secret; override via REPLICATE_MODEL_VERSION to bump it.
DEFAULT_DEMUCS_VERSION = "5a7041cc9b82e5a558fea6b3d7b12dea89625e89da33f0447bd727c2d0ab9e77"
MODEL_VERSION = os.environ.get("REPLICATE_MODEL_VERSION", DEFAULT_DEMUCS_VERSION)
DEMUCS_MODEL = os.environ.get("REPLICATE_DEMUCS_MODEL", "htdemucs_6s")


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
    """Unconditional write — kept for operator/CLI use only. The pipeline path must
    use the atomic claim helpers below; an unguarded write is what H8 was about."""
    with _db() as conn:
        conn.execute("UPDATE jobs SET replicate_prediction_id=%s WHERE id=%s", (pred_id, job_id))
        conn.commit()


def _heartbeat(job_id: str) -> None:
    """Best-effort liveness bump so the reaper doesn't treat a live separation as an
    orphan. Shares one implementation with the extract/upload stages (job_state.py)
    so every stage looks identical to the reaper."""
    heartbeat(job_id)


def _claim_slot(job_id: str, token: str, previous: str | None = None) -> bool:
    """Atomically take the prediction slot. With `previous=None` this only wins on a
    virgin row (replicate_prediction_id IS NULL); otherwise it takes over one specific
    stale claim token. Returns True if THIS worker now owns the right to submit."""
    with _db() as conn:
        if previous is None:
            cur = conn.execute(
                "UPDATE jobs SET replicate_prediction_id=%s "
                "WHERE id=%s AND replicate_prediction_id IS NULL",
                (token, job_id),
            )
        else:
            cur = conn.execute(
                "UPDATE jobs SET replicate_prediction_id=%s "
                "WHERE id=%s AND replicate_prediction_id=%s",
                (token, job_id, previous),
            )
        conn.commit()
        return cur.rowcount == 1


def _release_slot(job_id: str, token: str) -> None:
    """Hand the slot back after a failed submit so a retry isn't blocked by our
    dead claim. Scoped to our own token so it can never clear someone else's id."""
    try:
        with _db() as conn:
            conn.execute(
                "UPDATE jobs SET replicate_prediction_id=NULL "
                "WHERE id=%s AND replicate_prediction_id=%s",
                (job_id, token),
            )
            conn.commit()
    except Exception as exc:  # noqa: BLE001 — best effort; the takeover path covers it
        log_structured(
            "WARN", "replicate_claim_release_failed", job_id=job_id, error=str(exc)[:120]
        )


def _publish_prediction(job_id: str, token: str, pred_id: str) -> str:
    """Replace our claim token with the real prediction id. If the token is gone
    somebody took the claim over mid-submit; converge on whatever is stored so both
    workers poll ONE prediction, and log loudly because ours is now an untracked cost."""
    with _db() as conn:
        cur = conn.execute(
            "UPDATE jobs SET replicate_prediction_id=%s WHERE id=%s AND replicate_prediction_id=%s",
            (pred_id, job_id, token),
        )
        conn.commit()
        if cur.rowcount == 1:
            return pred_id
    winner = get_prediction_id(job_id)
    log_structured(
        "ERROR",
        "replicate_claim_lost_after_submit",
        job_id=job_id,
        orphaned_pred_id=pred_id,
        winner_pred_id=winner,
    )
    return winner or pred_id


def _submit(job_id: str, token: str, audio_url: str) -> str:
    """POST a new prediction. Only ever called by the worker holding the claim."""
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
            timeout=SUBMIT_TIMEOUT,
        )
        r.raise_for_status()
        pred_id = r.json()["id"]
    except Exception:
        _release_slot(job_id, token)
        raise
    pred_id = _publish_prediction(job_id, token, pred_id)
    log_structured("INFO", "replicate_submitted", job_id=job_id, pred_id=pred_id)
    return pred_id


def submit_or_reattach(job_id: str, audio_url: str) -> str:
    """Submit a new prediction or re-attach an existing one. Returns prediction_id.

    Exactly one prediction is ever created per job, even with two workers racing on
    the same row (H8) — see the module docstring for why check-then-act wasn't enough.
    """
    observed_claim: str | None = None
    takeover_at = 0.0
    while True:
        existing = get_prediction_id(job_id)
        if existing and not existing.startswith(CLAIM_PREFIX):
            log_structured("INFO", "replicate_reattach", job_id=job_id, pred_id=existing)
            return existing

        if existing is None:
            token = f"{CLAIM_PREFIX}{uuid.uuid4()}"
            if _claim_slot(job_id, token):
                return _submit(job_id, token, audio_url)
            continue  # lost the race — re-read and follow the winner

        # Someone else holds the claim but hasn't published a prediction id yet.
        if existing != observed_claim:
            observed_claim = existing
            takeover_at = time.monotonic() + CLAIM_TAKEOVER_SECONDS
            log_structured("INFO", "replicate_claim_wait", job_id=job_id, claim=existing)
        if time.monotonic() >= takeover_at:
            token = f"{CLAIM_PREFIX}{uuid.uuid4()}"
            if _claim_slot(job_id, token, previous=existing):
                log_structured(
                    "WARN", "replicate_claim_takeover", job_id=job_id, stale_claim=existing
                )
                return _submit(job_id, token, audio_url)
            continue  # the holder resolved it first — re-read
        time.sleep(CLAIM_POLL_INTERVAL)


def poll_until_done(job_id: str, pred_id: str, progress_cb=None) -> tuple[dict, float]:
    """Poll a prediction until it succeeds/fails. Returns ({stem: url} (piano→keys), cost_usd)."""
    deadline = time.monotonic() + HARD_DEADLINE
    last_hb = time.monotonic()
    retries = 0
    while time.monotonic() < deadline:
        if time.monotonic() - last_hb >= HEARTBEAT_SECONDS:
            _heartbeat(job_id)
            last_hb = time.monotonic()
        try:
            r = httpx.get(f"{API}/predictions/{pred_id}", headers=_headers(), timeout=15)
            r.raise_for_status()
            pred = r.json()
        except httpx.HTTPStatusError as e:
            if e.response.status_code >= 500 and retries < 1:
                retries += 1
                time.sleep(POLL_INTERVAL)
                continue
            raise SeparationFailedError(f"Replicate HTTP {e.response.status_code}") from e

        status = pred.get("status")
        if progress_cb and status == "processing":
            elapsed = time.monotonic() - (deadline - HARD_DEADLINE)
            pct = int(15 + min(elapsed / HARD_DEADLINE, 1.0) * 55)
            progress_cb(job_id, pct)

        if status == "succeeded":
            outputs = pred.get("output", {}) or {}
            predict_time = pred.get("metrics", {}).get("predict_time", 0) or 0
            cost = predict_time * 0.0005
            log_structured(
                "INFO",
                "separation_complete",
                job_id=job_id,
                cost_usd=round(cost, 4),
                latency_ms=int(predict_time * 1000),
            )
            return {STEM_RENAME.get(k, k): v for k, v in outputs.items()}, round(cost, 4)
        if status in ("failed", "canceled"):
            raise SeparationFailedError(str(pred.get("error", "unknown")))
        time.sleep(POLL_INTERVAL)

    # Deadline hit but the prediction is still 'processing' (not failed) — retryable.
    raise SeparationTimeout(f"poll deadline {HARD_DEADLINE}s exceeded; prediction still running")
