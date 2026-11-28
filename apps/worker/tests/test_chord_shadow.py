"""B4 chord shadow-compare: BTC beside Klangio, agreement numbers only on job_events.

Covered:
  * the pure-Python MajMin / sevenths comparator on exact fixtures;
  * the ``CHORDS_SHADOW_BTC`` flag (default off, only ``1`` / ``true``);
  * the hook: flag off -> no shadow; flag on + Klangio ok -> agreement dict, ZERO extra
    Klangio calls; BTC raising / timing out -> chords outcome and artifact unchanged;
    Klangio failed / not the active provider / reused artifact -> no shadow;
  * the orchestrator: flag off -> the exact old hook call and detail; flag on -> the
    agreement rides on the existing extracting/completed row (no new row);
  * the real child process (missing input, timeout kill) and, if the weights are present,
    a real BTC run.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import struct
import subprocess
import wave
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from tests.test_beatless_finishes_done import JOB, _drive
from worker import chord_shadow as cs
from worker import pipeline
from worker.chord_source import ChordResult, ChordSegment

# ------------------------------------------------------------------ comparator


def _seq(*items):
    return [(s, e, lab) for s, e, lab in items]


def test_identical_sequences_agree_fully():
    ref = _seq((0, 2, "C:maj"), (2, 4, "A:min"), (4, 6, "G:7"))
    assert cs.majmin_agreement(ref, ref) == 1.0
    assert cs.sevenths_agreement(ref, ref) == 1.0


def test_disjoint_sequences_agree_not_at_all():
    ref = _seq((0, 2, "C:maj"), (2, 4, "A:min"))
    est = _seq((0, 2, "D:min"), (2, 4, "E:maj"))
    assert cs.majmin_agreement(ref, est) == 0.0


def test_half_overlap_is_one_half():
    ref = _seq((0, 4, "C:maj"))
    est = _seq((0, 2, "C:maj"), (2, 4, "F:maj"))
    assert cs.majmin_agreement(ref, est) == 0.5


def test_time_weighting_uses_durations_not_segment_counts():
    ref = _seq((0, 1, "C:maj"), (1, 4, "G:maj"))
    est = _seq((0, 1, "D:maj"), (1, 4, "G:maj"))
    assert cs.majmin_agreement(ref, est) == pytest.approx(0.75)


def test_no_chord_matches_no_chord_and_not_a_chord():
    ref = _seq((0, 2, "N"), (2, 4, "C:maj"))
    assert cs.majmin_agreement(ref, _seq((0, 2, "N"), (2, 4, "C:maj"))) == 1.0
    assert cs.majmin_agreement(ref, _seq((0, 4, "C:maj"))) == 0.5


def test_estimate_gaps_count_as_no_chord():
    ref = _seq((0, 2, "N"), (2, 4, "C:maj"))
    # BTC silent on [0,2): counts as N, which matches the reference's N.
    assert cs.majmin_agreement(ref, _seq((2, 4, "C:maj"))) == 1.0
    # BTC silent on [2,4): N vs C:maj is a miss.
    assert cs.majmin_agreement(_seq((0, 4, "C:maj")), _seq((0, 2, "C:maj"))) == 0.5


def test_estimate_outside_the_reference_span_is_ignored():
    ref = _seq((1, 3, "C:maj"))
    est = _seq((0, 1, "F:maj"), (1, 3, "C:maj"), (3, 9, "F:maj"))
    assert cs.majmin_agreement(ref, est) == 1.0


def test_unscorable_reference_time_is_excluded():
    # dim / sus / X reference time is out of the denominator (mir_eval majmin).
    ref = _seq((0, 2, "B:dim"), (2, 4, "C:maj"), (4, 6, "X"), (6, 8, "D:sus4"))
    est = _seq((0, 8, "C:maj"))
    assert cs.majmin_agreement(ref, est) == 1.0
    assert cs.majmin_agreement(_seq((0, 2, "B:dim")), est) is None
    assert cs.majmin_agreement([], est) is None


def test_estimate_x_or_unscorable_never_matches():
    ref = _seq((0, 2, "C:maj"))
    assert cs.majmin_agreement(ref, _seq((0, 2, "X"))) == 0.0
    assert cs.majmin_agreement(ref, _seq((0, 2, "C:sus4"))) == 0.0
    assert cs.majmin_agreement(ref, _seq((0, 2, "garbage"))) == 0.0


def test_majmin_reduces_sevenths_and_ignores_inversions_and_spelling():
    ref = _seq((0, 1, "G:7"), (1, 2, "C:maj/3"), (2, 3, "C#:min7"), (3, 4, "C"))
    est = _seq((0, 1, "G:maj"), (1, 2, "C:maj"), (2, 3, "Db:min"), (3, 4, "C:maj"))
    assert cs.majmin_agreement(ref, est) == 1.0
    # Sevenths keeps the extension: G:7 vs G:maj and C#:min7 vs Db:min are misses.
    assert cs.sevenths_agreement(ref, est) == 0.5


def test_sevenths_folds_upper_extensions_and_excludes_sixths():
    assert cs.sevenths_agreement(_seq((0, 1, "G:9")), _seq((0, 1, "G:7"))) == 1.0
    assert cs.sevenths_agreement(_seq((0, 1, "C:maj9")), _seq((0, 1, "C:maj7"))) == 1.0
    assert cs.sevenths_agreement(_seq((0, 1, "C:maj6")), _seq((0, 1, "C:maj"))) is None
    assert cs.majmin_agreement(_seq((0, 1, "C:maj6")), _seq((0, 1, "C:maj"))) == 1.0


def test_zero_length_and_unsorted_segments_are_tolerated():
    ref = [(2, 4, "A:min"), (0, 2, "C:maj"), (1, 1, "F:maj")]
    assert cs.majmin_agreement(ref, _seq((0, 2, "C:maj"), (2, 4, "A:min"))) == 1.0


# ------------------------------------------------------------------ flag


@pytest.mark.parametrize("raw", [None, "", "0", "false", "yes", "on", "2", "truthy"])
def test_flag_is_off_unless_literal_one_or_true(raw, monkeypatch):
    if raw is None:
        monkeypatch.delenv("CHORDS_SHADOW_BTC", raising=False)
    else:
        monkeypatch.setenv("CHORDS_SHADOW_BTC", raw)
    assert pipeline._chords_shadow_enabled() is False


@pytest.mark.parametrize("raw", ["1", "true", "TRUE", " True "])
def test_flag_on_values(raw, monkeypatch):
    monkeypatch.setenv("CHORDS_SHADOW_BTC", raw)
    assert pipeline._chords_shadow_enabled() is True


# ------------------------------------------------------------------ shadow_compare


def _klangio(segments=None, version="2026-11-04") -> ChordResult:
    segs = segments or [
        ChordSegment(start_sec=0.0, end_sec=2.0, label="C:maj", confidence=1.0),
        ChordSegment(start_sec=2.0, end_sec=4.0, label="G:7", confidence=1.0),
    ]
    return ChordResult(
        segments=segs,
        key="C:major",
        provider="klangio",
        provider_version=version,
        duration_sec=4.0,
        model_ms=1,
    )


def _btc_data(segments=((0.0, 2.0, "C:maj"), (2.0, 4.0, "G:maj"))):
    return {"segments": [list(s) for s in segments], "provider_version": "btc-x", "model_ms": 7}


PAYLOAD_KEYS = {
    "ok",
    "majmin",
    "sevenths",
    "btc_ms",
    "btc_model_ms",
    "duration_sec",
    "klangio_version",
    "btc_version",
}


def test_payload_has_numbers_and_versions_only():
    out = cs.shadow_compare("j", "/a.wav", _klangio(), 4.0, runner=lambda *_a: _btc_data())
    p = out["chords_shadow"]
    assert set(out) == {"chords_shadow"} and set(p) == PAYLOAD_KEYS
    assert p["ok"] is True and p["majmin"] == 1.0 and p["sevenths"] == 0.5
    assert p["duration_sec"] == 4.0 and p["btc_model_ms"] == 7
    assert p["klangio_version"] == "2026-11-04" and p["btc_version"] == "btc-x"
    blob = json.dumps(out)
    for label in ("C:maj", "G:7", "G:maj", "/a.wav", '"j"'):
        assert label not in blob


def test_failure_reports_the_error_class_only():
    def boom(*_a):
        raise RuntimeError("secret path /tmp/user-song.wav")

    out = cs.shadow_compare("j", "/a.wav", _klangio(), 4.0, runner=boom)
    assert out == {"chords_shadow": {"ok": False, "error_class": "RuntimeError"}}


def test_timeout_is_swallowed():
    def slow(*_a):
        raise subprocess.TimeoutExpired(cmd="btc", timeout=60)

    out = cs.shadow_compare("j", "/a.wav", _klangio(), 4.0, runner=slow)
    assert out == {"chords_shadow": {"ok": False, "error_class": "TimeoutExpired"}}


def test_child_error_class_is_passed_through():
    def child(*_a):
        raise cs.BtcShadowChildFailed("BtcWeightsMissing")

    out = cs.shadow_compare("j", "/a.wav", _klangio(), 4.0, runner=child)
    assert out["chords_shadow"]["error_class"] == "BtcWeightsMissing"


def test_over_duration_cap_is_skipped_without_running_btc():
    runner = MagicMock()
    assert (
        cs.shadow_compare("j", "/a.wav", _klangio(), cs.SHADOW_MAX_AUDIO_SEC + 1, runner=runner)
        is None
    )
    runner.assert_not_called()
    # exactly at the cap still runs
    runner.return_value = _btc_data()
    assert cs.shadow_compare("j", "/a.wav", _klangio(), cs.SHADOW_MAX_AUDIO_SEC, runner=runner)
    runner.assert_called_once_with("/a.wav", cs.SHADOW_TIMEOUT_SEC)


def test_unknown_duration_falls_back_to_the_klangio_result():
    out = cs.shadow_compare("j", "/a.wav", _klangio(), None, runner=lambda *_a: _btc_data())
    assert out["chords_shadow"]["duration_sec"] == 4.0


def test_bounds_are_sane():
    assert 10 <= cs.SHADOW_TIMEOUT_SEC <= 120
    assert cs.SHADOW_MAX_AUDIO_SEC >= 300


# ------------------------------------------------------------------ the hook


@pytest.fixture
def hook(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    uploads: list[bytes] = []

    def upload(job_id, body):
        uploads.append(body)
        return f"jobs/{job_id}/play.chords.json"

    monkeypatch.setattr(pipeline, "upload_play_chords", upload)
    monkeypatch.setattr(pipeline, "_existing_play_chords", lambda _j: False)
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: 4.0)
    audio = tmp_path / "harmonic_mix.wav"
    audio.write_bytes(b"x")
    monkeypatch.setattr(pipeline, "_choose_chord_input", lambda *_a, **_k: ("mix", str(audio)))
    provider = MagicMock()
    provider.recognize.return_value = _klangio()
    btc_calls: list[tuple] = []

    def btc(audio_path, timeout_sec):
        btc_calls.append((audio_path, timeout_sec))
        return _btc_data()

    monkeypatch.setattr(cs, "run_btc_child", btc)

    def run(shadow_out=None):
        with patch("worker.chord_source.get_chord_source", return_value=provider):
            if shadow_out is None:
                return pipeline._maybe_run_chord_recognition(JOB, {"keys": str(audio)}, ["keys"])
            return pipeline._maybe_run_chord_recognition(
                JOB, {"keys": str(audio)}, ["keys"], shadow_out=shadow_out
            )

    run.provider = provider  # type: ignore[attr-defined]
    run.btc_calls = btc_calls  # type: ignore[attr-defined]
    run.audio = str(audio)  # type: ignore[attr-defined]
    return run, uploads


def test_hook_without_shadow_out_runs_no_shadow(hook):
    run, uploads = hook
    assert run() == {"chords": "ok", "reason": None}
    assert run.btc_calls == []
    assert run.provider.recognize.call_count == 1


def test_hook_with_shadow_runs_btc_on_the_same_input_and_never_klangio_again(hook):
    run, uploads = hook
    baseline = run()
    base_body = uploads[-1]
    calls_before = run.provider.recognize.call_count
    shadow: dict = {}
    assert run(shadow) == baseline
    assert run.provider.recognize.call_count == calls_before + 1, "one Klangio call per run"
    assert run.btc_calls == [(run.audio, cs.SHADOW_TIMEOUT_SEC)]
    assert uploads[-1] == base_body, "play.chords.json stays Klangio's"
    assert shadow["chords_shadow"]["ok"] is True
    assert shadow["chords_shadow"]["majmin"] == 1.0


def test_shadow_runs_after_the_klangio_call_not_instead_of_it(hook, monkeypatch):
    run, _ = hook
    order: list[str] = []
    run.provider.recognize.side_effect = lambda *a, **k: order.append("klangio") or _klangio()
    monkeypatch.setattr(cs, "run_btc_child", lambda *a: order.append("btc") or _btc_data())
    run({})
    assert order == ["klangio", "btc"]


@pytest.mark.parametrize(
    "exc",
    [RuntimeError("x"), subprocess.TimeoutExpired("btc", 60), MemoryError(), ValueError()],
)
def test_btc_failure_leaves_the_job_result_identical(hook, monkeypatch, exc):
    run, uploads = hook
    baseline = run()
    base_body = uploads[-1]

    def boom(*_a):
        raise exc

    monkeypatch.setattr(cs, "run_btc_child", boom)
    shadow: dict = {}
    assert run(shadow) == baseline
    assert uploads[-1] == base_body
    assert shadow == {"chords_shadow": {"ok": False, "error_class": type(exc).__name__}}


def test_even_a_broken_shadow_module_cannot_fail_the_hook(hook, monkeypatch):
    run, _ = hook

    def explode(*_a, **_k):
        raise RuntimeError("bug in shadow_compare itself")

    monkeypatch.setattr(cs, "shadow_compare", explode)
    shadow: dict = {}
    assert run(shadow) == {"chords": "ok", "reason": None}
    assert shadow == {}


def test_klangio_failure_means_no_shadow(hook):
    run, _ = hook
    run.provider.recognize.side_effect = RuntimeError("klangio down")
    shadow: dict = {}
    assert run(shadow)["chords"] == "unavailable"
    assert run.btc_calls == [] and shadow == {}


def test_reused_artifact_means_no_shadow_and_no_klangio(hook, monkeypatch):
    run, _ = hook
    monkeypatch.setattr(pipeline, "_existing_play_chords", lambda _j: True)
    shadow: dict = {}
    assert run(shadow) == {"chords": "ok", "reason": None}
    run.provider.recognize.assert_not_called()
    assert run.btc_calls == [] and shadow == {}


def test_btc_as_active_provider_means_no_shadow(hook, monkeypatch):
    run, _ = hook
    monkeypatch.setenv("CHORDS_PROVIDER", "btc")
    run.provider.recognize.return_value = ChordResult(
        segments=[ChordSegment(0.0, 1.0, "C:maj", 1.0)], provider="btc", duration_sec=1.0
    )
    shadow: dict = {}
    run(shadow)
    assert run.btc_calls == [] and shadow == {}


def test_non_klangio_result_means_no_shadow(hook):
    run, _ = hook
    run.provider.recognize.return_value = ChordResult(
        segments=[ChordSegment(0.0, 1.0, "C:maj", 1.0)], provider="internal", duration_sec=1.0
    )
    shadow: dict = {}
    run(shadow)
    assert run.btc_calls == [] and shadow == {}


# ------------------------------------------------------------------ the orchestrator

LOOP = {"stem": "drums", "start_sec": 0.0, "end_sec": 8.0}


def _drive_hook(monkeypatch, hook_fn):
    seen = _drive(monkeypatch, lambda *a, **k: ([LOOP], {"bpm": 120.0, "musical_key": "C"}, {}, {}))
    monkeypatch.setattr(pipeline, "_maybe_run_chord_recognition", hook_fn)
    asyncio.run(pipeline._run_pipeline(JOB))
    return seen


def _extracting(seen):
    return [d for (s, p, d) in seen["events"] if (s, p) == ("extracting", "completed")]


def test_flag_off_is_the_exact_old_call_and_detail(monkeypatch):
    monkeypatch.delenv("CHORDS_SHADOW_BTC", raising=False)
    calls: list = []

    def hook_fn(*a, **k):
        calls.append((a, k))
        return {"chords": "ok", "reason": None}

    seen = _drive_hook(monkeypatch, hook_fn)
    assert len(calls) == 1 and calls[0][1] == {} and len(calls[0][0]) == 3
    assert _extracting(seen) == [{"chords": "ok"}]
    assert all("chords_shadow" not in (d or {}) for _s, _p, d in seen["events"])


def test_flag_on_puts_agreement_on_the_existing_row(monkeypatch):
    monkeypatch.setenv("CHORDS_SHADOW_BTC", "1")
    payload = {"chords_shadow": {"ok": True, "majmin": 0.9}}

    def hook_fn(*a, shadow_out=None):
        shadow_out.update(payload)
        return {"chords": "ok", "reason": None}

    seen = _drive_hook(monkeypatch, hook_fn)
    assert seen["failed"] == [] and seen["status"][-1] == "done"
    rows = [(s, p) for (s, p, _d) in seen["events"]]
    assert rows.count(("extracting", "completed")) == 1, "no extra row"
    assert _extracting(seen) == [{"chords": "ok", **payload}]
    others = [d for (s, p, d) in seen["events"] if (s, p) != ("extracting", "completed")]
    assert all("chords_shadow" not in (d or {}) for d in others)


def test_flag_on_with_nothing_to_report_adds_nothing(monkeypatch):
    monkeypatch.setenv("CHORDS_SHADOW_BTC", "true")
    seen = _drive_hook(monkeypatch, lambda *a, shadow_out=None: {"chords": "ok", "reason": None})
    assert _extracting(seen) == [{"chords": "ok"}]


# ------------------------------------------------------------------ the real child


def _write_triad_wav(path: Path, secs: float = 6.0, sr: int = 22050) -> None:
    freqs = (261.63, 329.63, 392.0)  # C major
    n = int(sr * secs)
    frames = b"".join(
        struct.pack("<h", int(6000 * sum(math.sin(2 * math.pi * f * i / sr) for f in freqs) / 3))
        for i in range(n)
    )
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(frames)


def test_real_child_reports_a_missing_input_by_class_name(tmp_path):
    with pytest.raises(cs.BtcShadowChildFailed) as info:
        cs.run_btc_child(str(tmp_path / "missing.wav"), 60.0)
    assert str(info.value) == "FileNotFoundError"


def test_real_child_is_killed_at_the_timeout(tmp_path):
    with pytest.raises(subprocess.TimeoutExpired):
        cs.run_btc_child(str(tmp_path / "missing.wav"), 0.001)


REAL_WEIGHTS = os.environ.get("BTC_WEIGHTS_PATH", "")


@pytest.mark.skipif(
    not (REAL_WEIGHTS and Path(REAL_WEIGHTS).is_file()), reason="BTC_WEIGHTS_PATH not set"
)
def test_real_btc_shadow_end_to_end(tmp_path):
    audio = tmp_path / "triad.wav"
    _write_triad_wav(audio)
    ref = _klangio([ChordSegment(start_sec=0.0, end_sec=6.0, label="C:maj", confidence=1.0)])
    out = cs.shadow_compare("j", str(audio), ref, 6.0)
    p = out["chords_shadow"]
    assert p["ok"] is True, p
    assert 0.0 <= p["majmin"] <= 1.0 and p["majmin"] >= 0.5
    assert p["btc_version"].startswith("btc-large-voca@")
    assert p["btc_ms"] < cs.SHADOW_TIMEOUT_SEC * 1000
