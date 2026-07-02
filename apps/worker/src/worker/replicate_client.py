"""Idempotent Replicate client for htdemucs_6s stem separation (T11).

Idempotency (PRD draft-2 hardening): the Replicate prediction id is persisted on
the job row the moment it is created, and re-attached on any retry — so a retried
job never submits a second prediction and is never double-charged.

Stem-label rule (LOCKED): htdemucs_6s emits a 'piano' stem INTERNALLY ONLY. The
contract uses 'keys' everywhere (UI, DB, R2 filenames), so outputs are renamed
piano→keys here before they leave this module.

Live Replicate calls land in P2-12+; P2-11 exercises this with mocks only.
"""

import os
import time

import httpx
import psycopg

from .errors import SeparationFailedError
from .logger import log_structured

API = "https://api.replicate.com/v1"
# Separation poll ceiling. Kept UNDER the 60s Gate-2 e2e target (55s = ~5s headroom,
# not right at the edge) so a cold-start prediction that lands in the 45-60s band still
# completes instead of spuriously failing mid-audition. Overridable via REPLICATE_DEADLINE.
HARD_DEADLINE = int(os.environ.get("REPLICATE_DEADLINE", "55"))
POLL_INTERVAL = 2
# htdemucs_6s → contract mapping. 'piano' is internal-only; everything else uses 'keys'.
STEM_RENAME = {"piano": "keys"}
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
    with _db() as conn:
        conn.execute("UPDATE jobs SET replicate_prediction_id=%s WHERE id=%s", (pred_id, job_id))
        conn.commit()


def submit_or_reattach(job_id: str, audio_url: str) -> str:
    """Submit a new prediction or re-attach an existing one. Returns prediction_id."""
    existing = get_prediction_id(job_id)
    if existing:
        log_structured("INFO", "replicate_reattach", job_id=job_id, pred_id=existing)
        return existing
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
    set_prediction_id(job_id, pred_id)
    log_structured("INFO", "replicate_submitted", job_id=job_id, pred_id=pred_id)
    return pred_id


def poll_until_done(job_id: str, pred_id: str, progress_cb=None) -> tuple[dict, float]:
    """Poll a prediction until it succeeds/fails. Returns ({stem: url} (piano→keys), cost_usd)."""
    deadline = time.monotonic() + HARD_DEADLINE
    retries = 0
    while time.monotonic() < deadline:
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

    raise SeparationFailedError(f"Replicate deadline exceeded ({HARD_DEADLINE}s)")
