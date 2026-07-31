"""P2-11: a retry re-attaches the existing prediction (no second POST, no double charge).

Hardening H8 extends this from "a sequential retry doesn't double-submit" to "two
CONCURRENT workers on the same job row don't double-submit" — the situation a reaper
re-queue of a merely-slow worker actually creates. The claim on the prediction slot is
atomic, so only the worker that wins the row ever POSTs to Replicate.
"""

from unittest.mock import MagicMock, patch

import pytest

from worker import replicate_client
from worker.replicate_client import CLAIM_PREFIX, STEM_RENAME, submit_or_reattach


@pytest.fixture(autouse=True)
def _fake_replicate_token(monkeypatch):
    """_headers() reads the token from the env; these tests never reach the network."""
    monkeypatch.setenv("REPLICATE_API_TOKEN", "FAKE_TEST_TOKEN")


def _post_returning(pred_id: str) -> MagicMock:
    resp = MagicMock()
    resp.json.return_value = {"id": pred_id}
    return MagicMock(return_value=resp)


def test_retry_reattaches_no_double_post():
    with (
        patch("worker.replicate_client.get_prediction_id", return_value="pred-existing"),
        patch("worker.replicate_client.httpx.post") as mock_post,
    ):
        pred_id = submit_or_reattach("job-1", "https://r2.example.com/audio.wav")
    assert pred_id == "pred-existing"
    mock_post.assert_not_called()


def test_winner_claims_then_submits_exactly_once():
    post = _post_returning("pred-new")
    with (
        patch("worker.replicate_client.get_prediction_id", return_value=None),
        patch("worker.replicate_client._claim_slot", return_value=True) as claim,
        patch("worker.replicate_client._publish_prediction", side_effect=lambda j, t, p: p),
        patch("worker.replicate_client.httpx.post", post),
    ):
        pred_id = submit_or_reattach("job-1", "https://r2.example.com/audio.wav")
    assert pred_id == "pred-new"
    assert post.call_count == 1
    # The slot is claimed BEFORE the POST — that ordering is the whole fix.
    assert claim.call_args.args[1].startswith(CLAIM_PREFIX)


def test_loser_of_the_claim_never_posts_and_reattaches_winner():
    """The H8 race: worker B loses the atomic claim, so it must follow worker A's
    prediction instead of submitting (and billing for) a second one."""
    reads = iter([None, "pred-from-worker-a"])
    post = MagicMock()
    with (
        patch("worker.replicate_client.get_prediction_id", side_effect=lambda _j: next(reads)),
        patch("worker.replicate_client._claim_slot", return_value=False),
        patch("worker.replicate_client.httpx.post", post),
    ):
        pred_id = submit_or_reattach("job-1", "https://r2.example.com/audio.wav")
    assert pred_id == "pred-from-worker-a"
    post.assert_not_called()


def test_waits_for_an_unresolved_claim_instead_of_submitting():
    """A claim token means another worker is mid-POST — wait for its real id."""
    reads = iter([f"{CLAIM_PREFIX}abc", f"{CLAIM_PREFIX}abc", "pred-from-worker-a"])
    post = MagicMock()
    with (
        patch("worker.replicate_client.get_prediction_id", side_effect=lambda _j: next(reads)),
        patch("worker.replicate_client.time.sleep"),
        patch("worker.replicate_client.httpx.post", post),
    ):
        pred_id = submit_or_reattach("job-1", "https://r2.example.com/audio.wav")
    assert pred_id == "pred-from-worker-a"
    post.assert_not_called()


def test_stale_claim_is_taken_over_so_a_job_cannot_wedge():
    """If the claim holder dies mid-submit the token would park the row forever.
    After the takeover window another worker steals the claim and submits."""
    post = _post_returning("pred-taken-over")
    with (
        patch("worker.replicate_client.get_prediction_id", return_value=f"{CLAIM_PREFIX}dead"),
        patch("worker.replicate_client.CLAIM_TAKEOVER_SECONDS", 0),
        patch("worker.replicate_client._claim_slot", return_value=True) as claim,
        patch("worker.replicate_client._publish_prediction", side_effect=lambda j, t, p: p),
        patch("worker.replicate_client.httpx.post", post),
    ):
        pred_id = submit_or_reattach("job-1", "https://r2.example.com/audio.wav")
    assert pred_id == "pred-taken-over"
    assert claim.call_args.kwargs["previous"] == f"{CLAIM_PREFIX}dead"


def test_takeover_window_cannot_overtake_a_slow_but_live_submit():
    """Guards the invariant that makes takeover safe: the window must be longer than
    the submit timeout, otherwise a slow claimer gets overtaken and double-submits."""
    assert replicate_client.CLAIM_TAKEOVER_SECONDS > replicate_client.SUBMIT_TIMEOUT


def test_failed_submit_releases_the_claim():
    """A dead claim must not wedge the job — the slot goes back to NULL so the next
    attempt (reaper re-queue or separation retry) can claim it cleanly."""
    with (
        patch("worker.replicate_client.get_prediction_id", return_value=None),
        patch("worker.replicate_client._claim_slot", return_value=True),
        patch("worker.replicate_client._release_slot") as release,
        patch("worker.replicate_client.httpx.post", side_effect=RuntimeError("replicate 500")),
    ):
        with pytest.raises(RuntimeError):
            submit_or_reattach("job-1", "https://r2.example.com/audio.wav")
    release.assert_called_once()


def test_keys_piano_mapping():
    assert STEM_RENAME.get("piano") == "keys"
