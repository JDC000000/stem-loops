"""Hardening H8 against a real Postgres: exactly one prediction per job.

test_replicate_idempotency.py covers the control flow with mocks; this covers the
SQL that actually enforces the claim, because the failure mode here is money —
two workers submitting the same job bills Replicate twice.

Runs against DATABASE_URL when set; skips cleanly otherwise.
"""

import os
import uuid
from unittest.mock import MagicMock, patch

import psycopg
import pytest

from worker.replicate_client import (
    CLAIM_PREFIX,
    _claim_slot,
    _publish_prediction,
    _release_slot,
    get_prediction_id,
    submit_or_reattach,
)

DB = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DB, reason="DATABASE_URL not set")

_CREATED: list[str] = []


@pytest.fixture(autouse=True)
def _job():
    job_id = str(uuid.uuid4())
    _CREATED.append(job_id)
    with psycopg.connect(DB) as c:
        c.execute(
            """
            INSERT INTO jobs(id, youtube_url, requested_stems, loop_length_bars,
                             status, client_ip_hash, client_fingerprint)
            VALUES(%s,%s,%s,%s,'separating','test','test')
            """,
            (job_id, "https://www.youtube.com/watch?v=00000000000", ["drums"], 4),
        )
        c.commit()
    yield job_id
    with psycopg.connect(DB) as c:
        c.execute("DELETE FROM jobs WHERE id = ANY(%s)", (_CREATED,))
        c.commit()
    _CREATED.clear()


def test_only_one_of_two_racing_workers_wins_the_slot(_job):
    assert _claim_slot(_job, f"{CLAIM_PREFIX}worker-a") is True
    assert _claim_slot(_job, f"{CLAIM_PREFIX}worker-b") is False


def test_loser_reattaches_to_the_winners_prediction_without_posting(_job):
    """End-to-end through the real SQL: worker A claims and publishes, worker B
    (which lost) must return A's prediction id and never call Replicate."""
    token_a = f"{CLAIM_PREFIX}worker-a"
    assert _claim_slot(_job, token_a) is True
    assert _publish_prediction(_job, token_a, "pred-A") == "pred-A"

    with patch("worker.replicate_client.httpx.post", side_effect=AssertionError("double submit!")):
        assert submit_or_reattach(_job, "https://r2/audio.wav") == "pred-A"


def test_publish_replaces_only_our_own_token(_job):
    """If someone took the claim over mid-submit, publishing must not clobber it."""
    _claim_slot(_job, f"{CLAIM_PREFIX}thief")
    result = _publish_prediction(_job, f"{CLAIM_PREFIX}ours", "pred-ours")
    assert get_prediction_id(_job) == f"{CLAIM_PREFIX}thief"
    # The thief is still mid-submit, so the stored value is a claim token, not a
    # prediction. Polling that would 404 — our own prediction is real and running.
    assert result == "pred-ours"


def test_publish_converges_on_a_real_winner(_job):
    """When the thief HAS published, both workers must poll the same prediction."""
    _claim_slot(_job, f"{CLAIM_PREFIX}thief")
    _publish_prediction(_job, f"{CLAIM_PREFIX}thief", "pred-thief")
    assert _publish_prediction(_job, f"{CLAIM_PREFIX}ours", "pred-ours") == "pred-thief"


def test_released_slot_can_be_claimed_again(_job):
    """A failed submit must not wedge the job behind a dead claim."""
    token = f"{CLAIM_PREFIX}died-mid-submit"
    assert _claim_slot(_job, token) is True
    _release_slot(_job, token)
    assert get_prediction_id(_job) is None
    assert _claim_slot(_job, f"{CLAIM_PREFIX}next-worker") is True


def test_release_cannot_clear_someone_elses_prediction(_job):
    _claim_slot(_job, f"{CLAIM_PREFIX}a")
    _publish_prediction(_job, f"{CLAIM_PREFIX}a", "pred-A")
    _release_slot(_job, f"{CLAIM_PREFIX}b")  # a different worker's stale token
    assert get_prediction_id(_job) == "pred-A"


def test_stale_claim_is_taken_over_and_submitted_once(_job):
    """The claim holder died mid-submit; after the window another worker takes over."""
    _claim_slot(_job, f"{CLAIM_PREFIX}dead")
    resp = MagicMock()
    resp.json.return_value = {"id": "pred-recovered"}
    with (
        patch("worker.replicate_client.CLAIM_TAKEOVER_SECONDS", 0),
        patch("worker.replicate_client.httpx.post", return_value=resp) as post,
        patch.dict(os.environ, {"REPLICATE_API_TOKEN": "FAKE_TEST_TOKEN"}),
    ):
        assert submit_or_reattach(_job, "https://r2/audio.wav") == "pred-recovered"
    assert post.call_count == 1
    assert get_prediction_id(_job) == "pred-recovered"
