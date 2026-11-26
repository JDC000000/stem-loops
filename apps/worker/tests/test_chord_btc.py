"""BTC chord provider scaffold (DR-D1 option A). No torch: the model runner is a fake.

Covers: factory selection (lazy import), ChordResult / play.chords.json shape the web loader
accepts, label normalisation (all 170 BTC classes + invalid labels), segment cleaning, the
missing/unpinned/mismatched weights error path, and the pipeline hook skipping the Klangio
ledger + quota for btc while still using them for klangio (regression).
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from dataclasses import asdict
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from tests.test_pipeline_chord_hook import _make_stems, _write_wav
from worker import pipeline
from worker.chord_providers import btc
from worker.chord_providers.btc import (
    BtcChordSource,
    BtcWeightsMissing,
    btc_vocabulary,
    clean_segments,
    normalize_btc_label,
    verify_weights,
)
from worker.chord_source import ChordResult, get_chord_source, is_valid_harte_label

GOLDEN = Path(__file__).resolve().parents[3] / "fixtures" / "contracts" / "play-chords.golden.json"
FAKE_SHA = "ab" * 32


def _fake_runner(rows):
    calls: list[Path] = []

    def run(path: Path):
        calls.append(path)
        return rows

    run.calls = calls  # type: ignore[attr-defined]
    return run


@pytest.fixture
def wav(tmp_path: Path) -> Path:
    p = tmp_path / "harmonic_mix.wav"
    _write_wav(p, 220.0, secs=2.0)
    return p


# ----------------------------- factory -----------------------------
def test_factory_selects_btc_explicitly_and_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    assert isinstance(get_chord_source("btc"), BtcChordSource)
    monkeypatch.setenv("CHORDS_PROVIDER", "btc")
    assert isinstance(get_chord_source(), BtcChordSource)


def test_factory_default_is_still_klangio(monkeypatch: pytest.MonkeyPatch) -> None:
    from worker.chord_providers.klangio import KlangioChordSource

    monkeypatch.delenv("CHORDS_PROVIDER", raising=False)
    assert isinstance(get_chord_source(), KlangioChordSource)


def test_btc_module_never_imports_torch() -> None:
    assert "torch" not in sys.modules
    get_chord_source("btc")
    assert "torch" not in sys.modules


# ----------------------------- result shape -----------------------------
def test_fake_runner_produces_valid_chord_result(wav: Path) -> None:
    runner = _fake_runner(
        [(0.0, 0.5, "C"), (0.5, 1.0, "A:min"), (1.0, 2.0, "G:7"), (2.0, 9.0, "N")]
    )
    res = BtcChordSource(runner, provider_version=FAKE_SHA).recognize(wav, ledger=None)
    assert isinstance(res, ChordResult)
    assert runner.calls == [wav]
    assert res.provider == "btc" and res.provider_version == FAKE_SHA
    assert res.key is None
    assert res.duration_sec == pytest.approx(2.0, abs=0.01)
    assert [s.label for s in res.segments] == [
        "C:maj",
        "A:min",
        "G:7",
    ]  # N past the end clamped away
    for s in res.segments:
        assert is_valid_harte_label(s.label) and s.confidence == 1.0
        assert 0.0 <= s.start_sec < s.end_sec <= res.duration_sec


def test_play_chords_json_matches_golden_shape_and_loader_rules(wav: Path) -> None:
    """Same top-level and segment keys as the committed golden the web contract test feeds the
    real loader; every segment passes the loader's filter (finite start/end, non-empty label)."""
    res = BtcChordSource(_fake_runner([(0.0, 1.0, "D:min7"), (1.0, 2.0, "F#:hdim7")])).recognize(
        wav
    )
    payload = json.loads(json.dumps(asdict(res)))
    golden = json.loads(GOLDEN.read_text())["payload"]
    assert set(payload) == set(golden)
    assert set(payload["segments"][0]) == set(golden["segments"][0])
    for row in payload["segments"]:
        assert math.isfinite(row["start_sec"]) and math.isfinite(row["end_sec"])
        assert isinstance(row["label"], str) and row["label"]
        assert row["end_sec"] >= row["start_sec"]
    assert payload["provider"] == "btc"


def test_ledger_is_ignored(wav: Path) -> None:
    ledger = MagicMock()
    BtcChordSource(_fake_runner([(0.0, 1.0, "C")])).recognize(wav, ledger=ledger)
    assert ledger.mock_calls == []


def test_missing_audio_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        BtcChordSource(_fake_runner([])).recognize(tmp_path / "nope.wav")


# ----------------------------- labels -----------------------------
def test_vocabulary_is_170_classes_and_all_normalise_to_valid_harte() -> None:
    vocab = btc_vocabulary()
    assert len(vocab) == 170 and vocab[168:] == ["X", "N"]
    assert vocab[0] == "C:min" and vocab[1] == "C" and vocab[14] == "C#:min"
    mapped = [normalize_btc_label(v) for v in vocab]
    assert all(is_valid_harte_label(m) for m in mapped)
    assert "X" not in mapped[:168], "no lossy mapping: every BTC quality is in the Harte set"
    assert len(set(mapped[:168])) == 168


@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("C", "C:maj"),
        ("c#:min7", "C#:min7"),
        ("Db:maj7", "Db:maj7"),
        ("A:minor", "A:min"),
        ("G:7/3", "G:7/3"),
        ("N", "N"),
        ("", "N"),
        ("X", "X"),
        ("C:weird", "X"),
        ("H:maj", "X"),
        ("C:maj/Q", "X"),
        ("Cb#:maj", "X"),
        (None, "X"),
        (42, "X"),
    ],
)
def test_invalid_labels_are_mapped_never_shipped(raw: object, want: str) -> None:
    out = normalize_btc_label(raw)
    assert out == want
    assert is_valid_harte_label(out)


# ----------------------------- segments -----------------------------
def test_clean_segments_sorts_merges_trims_and_drops() -> None:
    rows = [
        (1.0, 2.0, "C"),
        (0.0, 1.0, "C"),  # out of order, same label adjacent -> merged with the next
        (2.0, 2.0, "G"),  # zero length
        (1.5, 3.0, "G"),  # overlaps previous -> trimmed to start at 2.0
        (float("nan"), 4.0, "F"),  # non-finite
        (-1.0, 0.0, "A"),  # ends at 0 after clamp -> dropped
        (3.0, 99.0, "A:min"),  # clamped to duration
        (50.0, 60.0, "D"),  # entirely past the end
    ]
    segs = clean_segments(rows, duration_sec=5.0)
    assert [(s.start_sec, s.end_sec, s.label) for s in segs] == [
        (0.0, 2.0, "C:maj"),
        (2.0, 3.0, "G:maj"),
        (3.0, 5.0, "A:min"),
    ]


def test_clean_segments_without_duration_keeps_ends() -> None:
    segs = clean_segments([(0.0, 1.0, "C"), (1.0, 2.5, "G")], duration_sec=None)
    assert segs[-1].end_sec == 2.5


# ----------------------------- weights -----------------------------
def test_selected_without_weights_raises_clear_error(
    wav: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BTC_WEIGHTS_PATH", str(tmp_path / "missing.pt"))
    with pytest.raises(BtcWeightsMissing, match="not pinned"):
        get_chord_source("btc").recognize(wav)
    monkeypatch.setattr(btc, "BTC_WEIGHTS_SHA256", FAKE_SHA)
    with pytest.raises(BtcWeightsMissing, match="not found"):
        btc._default_runner()


def test_verify_weights_ok_mismatch_and_unpinned(tmp_path: Path) -> None:
    w = tmp_path / "w.pt"
    w.write_bytes(b"not really weights")
    sha = hashlib.sha256(b"not really weights").hexdigest()
    assert verify_weights(w, sha) == sha
    assert verify_weights(w, sha.upper()) == sha
    with pytest.raises(BtcWeightsMissing, match="mismatch"):
        verify_weights(w, FAKE_SHA)
    with pytest.raises(BtcWeightsMissing, match="not pinned"):
        verify_weights(w, "")


def test_verified_weights_still_hit_the_todo_stub(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    w = tmp_path / "w.pt"
    w.write_bytes(b"x")
    monkeypatch.setenv("BTC_WEIGHTS_PATH", str(w))
    monkeypatch.setattr(btc, "BTC_WEIGHTS_SHA256", hashlib.sha256(b"x").hexdigest())
    with pytest.raises(NotImplementedError, match="TODO\\(D1a\\)"):
        btc._default_runner()


# ----------------------------- pipeline hook -----------------------------
def _run_hook(provider: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.setenv("CHORDS_PROVIDER", provider)
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")
    stems = _make_stems(tmp_path)
    r2 = MagicMock()
    r2.get_object.side_effect = Exception("NoSuchKey")
    ledger_cls = MagicMock(name="_KlangioJobLedger")
    with (
        patch("worker.storage.r2_uploader._r2", return_value=r2),
        patch.object(pipeline, "_existing_play_chords", return_value=False),
        patch.object(pipeline, "_KlangioJobLedger", ledger_cls),
        patch("worker.chord_providers.klangio._reserve_quota") as quota,
    ):
        outcome = pipeline._maybe_run_chord_recognition("job-btc", stems, list(stems))
    body = json.loads(r2.put_object.call_args.kwargs["Body"]) if r2.put_object.called else None
    return outcome, body, ledger_cls, quota


def test_pipeline_btc_skips_klangio_ledger_and_quota(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner = _fake_runner([(0.0, 0.1, "C"), (0.1, 0.2, "G")])
    monkeypatch.setattr(btc, "_default_runner", lambda: runner)
    outcome, body, ledger_cls, quota = _run_hook("btc", tmp_path, monkeypatch)
    assert len(runner.calls) == 1
    ledger_cls.assert_not_called()
    quota.assert_not_called()
    assert body["provider"] == "btc"
    assert [s["label"] for s in body["segments"]] == ["C:maj", "G:maj"]
    assert outcome == pipeline._chords_ok()


def test_pipeline_btc_passes_ledger_none(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = MagicMock()
    fake.recognize.return_value = ChordResult(provider="btc")
    with patch("worker.chord_source.get_chord_source", return_value=fake):
        _run_hook("btc", tmp_path, monkeypatch)
    assert fake.recognize.call_args.kwargs["ledger"] is None


def test_pipeline_klangio_still_gets_the_ledger(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: klangio behaviour is unchanged (ledger built for this job and passed)."""
    fake = MagicMock()
    fake.recognize.return_value = ChordResult(provider="klangio")
    with patch("worker.chord_source.get_chord_source", return_value=fake):
        _, _, ledger_cls, _ = _run_hook("klangio", tmp_path, monkeypatch)
    ledger_cls.assert_called_once_with("job-btc")
    assert fake.recognize.call_args.kwargs["ledger"] is ledger_cls.return_value


def test_pipeline_btc_without_weights_tombstones_not_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("BTC_WEIGHTS_PATH", str(tmp_path / "missing.pt"))
    outcome, body, ledger_cls, quota = _run_hook("btc", tmp_path, monkeypatch)
    assert body == {"status": "unavailable", "reason": "provider_failed"}
    ledger_cls.assert_not_called()
    quota.assert_not_called()
    assert outcome is not None and outcome != pipeline._chords_ok()


def test_pipeline_btc_keeps_the_duration_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runner = _fake_runner([(0.0, 0.1, "C")])
    monkeypatch.setattr(btc, "_default_runner", lambda: runner)
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: 301.0)
    _, body, _, _ = _run_hook("btc", tmp_path, monkeypatch)
    assert runner.calls == []
    assert body["reason"] == "too_long"
