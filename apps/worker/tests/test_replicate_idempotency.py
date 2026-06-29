"""P2-11: a retry re-attaches the existing prediction (no second POST, no double charge)."""

from unittest.mock import patch

from worker.replicate_client import STEM_RENAME, submit_or_reattach


def test_retry_reattaches_no_double_post():
    with (
        patch("worker.replicate_client.get_prediction_id", return_value="pred-existing"),
        patch("worker.replicate_client.httpx.post") as mock_post,
    ):
        pred_id = submit_or_reattach("job-1", "https://r2.example.com/audio.wav")
    assert pred_id == "pred-existing"
    mock_post.assert_not_called()


def test_keys_piano_mapping():
    assert STEM_RENAME.get("piano") == "keys"
