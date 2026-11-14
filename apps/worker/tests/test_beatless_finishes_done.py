"""B5 (Jon, 2026-11-13): a beatless or rubato track finishes `done` with stems and chords
and 0 loops, instead of failing the whole job EXTRACTION_FAILED.

Only the extractor's BEAT guard is softened. Its length guards ("too short", "no loops
fit") still fail the job, and every assertion below that says so is the negative half.
"""

from __future__ import annotations

import asyncio
import os

import numpy as np
import pytest
import soundfile as sf

from worker import pipeline, replicate_client
from worker.errors import ExtractionFailedError
from worker.extractor import loop_extractor
from worker.extractor.loop_extractor import NoReliableBeatError, extract_loops

SR = 44100
JOB = "00000000-0000-4000-8000-0000000b5b01"
SIX = ("vocals", "drums", "bass", "other", "guitar", "keys")


def _silent_stems(tmp_path, names=("drums", "bass", "vocals"), sec=40) -> dict[str, str]:
    out = {}
    for n in names:
        p = os.path.join(tmp_path, f"{n}.wav")
        sf.write(p, np.zeros(SR * sec, dtype=np.float32), SR)
        out[n] = p
    return out


# ------------------------------------------------------------------ the extractor's typing


def test_the_beat_guard_raises_the_typed_subclass(tmp_path):
    stems = _silent_stems(tmp_path, names=("drums",))
    with pytest.raises(NoReliableBeatError):
        list(extract_loops(stems, 120.0))


def test_the_beat_guard_is_still_an_extraction_failure_for_callers_that_do_not_opt_in():
    # Anything that catches ExtractionFailedError (the pipeline's generic handler, the
    # error taxonomy, older callers) keeps working unchanged.
    assert issubclass(NoReliableBeatError, ExtractionFailedError)
    assert NoReliableBeatError("x").error_code == "EXTRACTION_FAILED"


# ------------------------------------------------------------------ extract_and_tag


def test_beatless_stems_give_zero_loops_and_a_null_bpm(tmp_path, monkeypatch):
    """Real audio, real beat grid, real extractor: silence has no beat."""
    written: list[dict] = []
    monkeypatch.setattr(pipeline, "_update_job_tags", lambda _j, tags: written.append(dict(tags)))
    loops, tags, seg_label, seg_energy = pipeline.extract_and_tag(
        JOB, _silent_stems(tmp_path), ["drums", "bass", "vocals"], 4
    )
    assert loops == []
    assert seg_label == {} and seg_energy == {}
    assert tags["bpm"] is None, "a tempo the beat guard refused must not be reported"
    assert "musical_key" in tags
    assert written and written[-1]["bpm"] is None, "jobs.bpm must be written NULL"


def test_a_too_short_track_still_fails_the_job(tmp_path, monkeypatch):
    # Negative half: only the BEAT guard is softened. A length refusal propagates.
    monkeypatch.setattr(pipeline, "_update_job_tags", lambda *_: None)

    def too_short(*_a, **_k):
        raise ExtractionFailedError("Too short: 3.0 bars < 8")
        yield  # pragma: no cover - makes this a generator like the real one

    monkeypatch.setattr(pipeline, "extract_loops", too_short)
    with pytest.raises(ExtractionFailedError) as caught:
        pipeline.extract_and_tag(JOB, _silent_stems(tmp_path, names=("drums",)), ["drums"], 4)
    assert not isinstance(caught.value, NoReliableBeatError)


def test_a_track_with_a_beat_still_records_its_bpm(tmp_path, monkeypatch):
    # The NULL bpm is the beatless branch only: on the normal path the tagged bpm is written.
    written: list[dict] = []
    monkeypatch.setattr(pipeline, "_update_job_tags", lambda _j, tags: written.append(dict(tags)))
    monkeypatch.setattr(
        pipeline,
        "detect_bpm_and_key",
        lambda *_a, **_k: {"bpm": 120.0, "musical_key": "C major"},
    )
    monkeypatch.setattr(pipeline, "extract_loops", lambda *_a, **_k: iter(()))
    pipeline.extract_and_tag(JOB, _silent_stems(tmp_path, names=("drums",)), ["drums"], 4)
    assert written == [{"bpm": 120.0, "musical_key": "C major"}]


def test_record_loops_with_no_loops_writes_nothing_and_never_divides_by_the_null_bpm(
    monkeypatch,
):
    def boom(*_a, **_k):
        raise AssertionError("no loop row may be written for a beatless job")

    monkeypatch.setattr(pipeline, "_insert_loop", boom)
    assert pipeline.record_loops(JOB, [], {"bpm": None, "musical_key": "C major"}, {}, {}, 4) == 0


# ------------------------------------------------------------------ the whole pipeline


def _async(fn):
    async def run(*a, **k):
        return fn(*a, **k)

    return run


def _drive(monkeypatch, extract):
    """Walk the real _run_pipeline with every I/O edge stubbed; record what happened."""
    monkeypatch.delenv("STUB_MODE", raising=False)
    seen: dict = {"status": [], "events": [], "calls": [], "failed": []}
    row = ("", ["drums", "bass", "vocals", "other"], 4, "upload", "uploads/x", "song.mp3")
    monkeypatch.setattr(pipeline, "_fetch_job", lambda _j: row)
    monkeypatch.setattr(pipeline, "set_status", _async(lambda _j, s: seen["status"].append(s)))
    monkeypatch.setattr(
        pipeline,
        "emit_event",
        _async(
            lambda _j, stage, phase, pct=None, detail=None: seen["events"].append(
                (stage, phase, detail)
            )
        ),
    )
    monkeypatch.setattr(pipeline, "_prepare_upload_source", lambda *a: ("https://audio", None))
    monkeypatch.setattr(pipeline, "submit_or_reattach", lambda *a: "pred")
    urls = {n: f"https://cdn/{n}.wav" for n in SIX}
    monkeypatch.setattr(pipeline, "poll_until_done", lambda *a: (urls, 0.1))
    monkeypatch.setattr(
        pipeline, "_fetch_stems", lambda stem_urls, *_a: {n: f"/x/{n}.wav" for n in stem_urls}
    )
    monkeypatch.setattr(pipeline, "extract_and_tag", extract)
    monkeypatch.setattr(
        pipeline,
        "_maybe_run_chord_recognition",
        lambda *a: seen["calls"].append("chords"),
    )

    def record(_j, loops, *a, **k):
        seen["calls"].append(("record", len(loops)))
        return len(loops)

    monkeypatch.setattr(pipeline, "record_loops", record)
    monkeypatch.setattr(
        pipeline,
        "retain_stems",
        lambda _j, paths: seen["calls"].append(("stems", len(paths))) or {"played": list(paths)},
    )
    monkeypatch.setattr(pipeline, "_fail", _async(lambda *a: seen["failed"].append(a)))
    monkeypatch.setattr(replicate_client, "_heartbeat", lambda *_: None)
    return seen


def test_a_beatless_job_finishes_done_with_stems_and_chords_and_zero_loops(monkeypatch):
    seen = _drive(
        monkeypatch,
        lambda *a, **k: ([], {"bpm": None, "musical_key": "A minor"}, {}, {}),
    )
    asyncio.run(pipeline._run_pipeline(JOB))
    assert seen["failed"] == [], "a beatless track must not fail the job"
    assert seen["status"][-1] == "done"
    assert "chords" in seen["calls"], "the chord overlay still runs for a beatless track"
    assert ("stems", 6) in seen["calls"], "all six stems are still retained for the mixer"
    assert ("record", 0) in seen["calls"]
    extracted = [d for (s, p, d) in seen["events"] if (s, p) == ("extracting", "completed")]
    assert extracted == [{"loops": 0, "reason": "no_reliable_beat"}]


def test_a_job_with_loops_carries_no_beatless_reason(monkeypatch):
    loop = {"stem": "drums", "start_sec": 0.0, "end_sec": 8.0}
    seen = _drive(
        monkeypatch,
        lambda *a, **k: ([loop], {"bpm": 120.0, "musical_key": "C major"}, {}, {}),
    )
    asyncio.run(pipeline._run_pipeline(JOB))
    assert seen["status"][-1] == "done"
    extracted = [d for (s, p, d) in seen["events"] if (s, p) == ("extracting", "completed")]
    assert extracted == [None]


def test_a_too_short_job_still_fails_extraction_failed_before_chords(monkeypatch):
    def too_short(*_a, **_k):
        raise ExtractionFailedError("Too short: 3.0 bars < 8")

    seen = _drive(monkeypatch, too_short)
    with pytest.raises(ExtractionFailedError):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert seen["failed"] and seen["failed"][0][1] == "EXTRACTION_FAILED"
    assert "chords" not in seen["calls"], "no Klangio spend on a job that fails extraction"
    assert "done" not in seen["status"]


def test_the_softened_guard_is_the_beat_guard_and_not_the_length_guard():
    # Pin which guard raises which type, by source, so a refactor that swaps them is loud.
    import inspect

    src = inspect.getsource(loop_extractor.extract_loops)
    assert src.count("raise NoReliableBeatError(") == 1
    beat = src.index("raise NoReliableBeatError(")
    assert "No reliable beat" in src[beat : beat + 120]
    assert 'ExtractionFailedError(f"Too short' in src
