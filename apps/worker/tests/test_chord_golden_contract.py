"""Golden contract for ``jobs/<id>/play.chords.json`` (issue #141, item 3).

The artifact is written here (``pipeline._maybe_run_chord_recognition``) and read by
``apps/web/src/chord/play-chords-loader.ts``. Each side used to test itself against its own
hand-written JSON, so renaming ``start_sec`` or the R2 key on one side left both green.

This test drives the REAL hook (real ``upload_play_chords``, real ``json.dumps(asdict(...))``),
captures the exact bytes and key handed to R2, and compares them with the committed golden
``fixtures/contracts/play-chords.golden.json``. The web test
(``apps/web/test/play-chords-contract.test.mjs``) feeds that SAME file through the real loader
and ``playChordsR2Key``. Change a field name / the key on either side and one of the two fails.

Regenerate (only for a deliberate contract change, then fix the web loader to match):
    UPDATE_GOLDEN=1 python -m pytest tests/test_chord_golden_contract.py
"""

from __future__ import annotations

import json
import os
from dataclasses import fields
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from tests.test_pipeline_chord_hook import _make_stems
from worker import pipeline
from worker.chord_source import ChordResult, ChordSegment

GOLDEN = Path(__file__).resolve().parents[3] / "fixtures" / "contracts" / "play-chords.golden.json"
JOB_ID = "11111111-2222-4333-8444-555555555555"

# Every field set to a NON-default, distinguishable value so a dropped / renamed field shows up.
RESULT = ChordResult(
    segments=[
        ChordSegment(start_sec=0.0, end_sec=1.6, label="C:maj", confidence=1.0),
        ChordSegment(start_sec=1.6, end_sec=3.2, label="F#:min7", confidence=0.9),
        ChordSegment(start_sec=3.2, end_sec=4.8, label="G:7/5", confidence=0.5),
    ],
    key="C:major",
    provider="klangio",
    provider_version="golden-v1",
    duration_sec=4.8,
    model_ms=123,
)


def _capture_upload(result: ChordResult, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    # CI sets STUB_MODE=true; this hook is called directly, but be explicit that we want real paths.
    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "golden-bucket")
    stems = _make_stems(tmp_path)
    provider = MagicMock()
    provider.recognize.return_value = result
    r2 = MagicMock()
    with (
        patch("worker.chord_source.get_chord_source", return_value=provider),
        patch("worker.storage.r2_uploader._r2", return_value=r2),
    ):
        pipeline._maybe_run_chord_recognition(JOB_ID, stems, list(stems))
    provider.recognize.assert_called_once()
    r2.put_object.assert_called_once()
    return r2.put_object.call_args.kwargs


def _golden_doc(kwargs: dict) -> dict:
    return {
        "job_id": JOB_ID,
        "r2_key": kwargs["Key"],
        "payload": json.loads(kwargs["Body"].decode("utf-8")),
    }


def test_uploaded_artifact_matches_the_golden_the_web_loader_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    kwargs = _capture_upload(RESULT, tmp_path, monkeypatch)
    actual = _golden_doc(kwargs)
    if os.environ.get("UPDATE_GOLDEN"):
        GOLDEN.write_text(json.dumps(actual, indent=2) + "\n")
    assert GOLDEN.exists(), "golden missing - run with UPDATE_GOLDEN=1"
    golden = json.loads(GOLDEN.read_text())
    assert actual == golden, (
        "worker's play.chords.json no longer matches the committed golden. If the contract change "
        "is deliberate, regenerate with UPDATE_GOLDEN=1 AND update apps/web play-chords-loader.ts."
    )


def test_every_chord_result_field_reaches_the_wire(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A new ChordResult field must be a conscious decision, not silently absent from the golden."""
    kwargs = _capture_upload(RESULT, tmp_path, monkeypatch)
    payload = json.loads(kwargs["Body"].decode("utf-8"))
    assert set(payload) == {f.name for f in fields(ChordResult)}
    golden = json.loads(GOLDEN.read_text())["payload"]
    assert set(golden) == set(payload)


def test_zero_segment_result_is_uploaded_and_counts_as_done(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The legitimate zero-segment artifact is what _existing_play_chords must accept (no re-bill)."""
    empty = ChordResult(
        segments=[], key=None, provider="klangio", provider_version="v", duration_sec=3.0
    )
    kwargs = _capture_upload(empty, tmp_path, monkeypatch)
    assert kwargs["Key"] == json.loads(GOLDEN.read_text())["r2_key"]
    body = kwargs["Body"]

    class _R2:
        def get_object(self, Bucket: str, Key: str) -> dict:  # noqa: N803
            assert Key == kwargs["Key"]
            return {"Body": MagicMock(read=lambda: body)}

    with (
        patch("worker.storage.r2_uploader._r2", return_value=_R2()),
        patch.dict(os.environ, {"R2_BUCKET_NAME": "golden-bucket"}),
    ):
        assert pipeline._existing_play_chords(JOB_ID) is True
