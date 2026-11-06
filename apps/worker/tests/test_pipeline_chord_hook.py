"""Unit tests for the Y1 chord hook in ``worker.pipeline`` (PR-Y1.qa-T4).

Contracts covered:

  1. Successful recognition uploads to R2 at ``jobs/<job_id>/play.chords.json``
     with the right Content-Type and Cache-Control.
  2. An R2 upload failure is logged + swallowed — the hook MUST NOT raise
     (chords are an optional overlay feature; a worker exception here would
     fail the whole pipeline).
  3. Stem selection works against the REAL ``htdemucs_6s`` stem set
     (``vocals, drums, bass, other, guitar, keys``). There is no ``instrumental``
     stem in production, and ``other`` is the post-extraction residue, so the
     default input is a mix of the harmonic stems, never bare ``other`` when
     ``keys`` / ``guitar`` exist, and never ``vocals``.

No real HTTP (``api.klang.io`` is never contacted); the chord provider and R2
client are mocked. Stems are real tiny WAVs so the ffmpeg mix runs for real.
"""

from __future__ import annotations

import json
import math
import os
import struct
import wave
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from worker import pipeline
from worker.chord_source import ChordResult, ChordSegment

# The exact stem set htdemucs_6s produces after replicate_client.STEM_RENAME
# (piano -> keys). If the separation model changes, change this AND the selector.
REAL_6S_STEMS = ("vocals", "drums", "bass", "other", "guitar", "keys")


def _write_wav(path: Path, freq: float, secs: float = 0.2, sr: int = 44100) -> None:
    n = int(sr * secs)
    frames = b"".join(
        struct.pack("<hh", *(int(8000 * math.sin(2 * math.pi * freq * i / sr)),) * 2)
        for i in range(n)
    )
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(frames)


def _make_stems(tmp_path: Path, names: tuple[str, ...] = REAL_6S_STEMS) -> dict[str, str]:
    paths: dict[str, str] = {}
    for i, name in enumerate(names):
        p = tmp_path / f"{name}.wav"
        _write_wav(p, 220.0 * (i + 1))
        paths[name] = str(p)
    return paths


# ----------------------------- shared fixtures -----------------------------
@pytest.fixture
def stem_paths(tmp_path: Path) -> dict[str, str]:
    """The realistic htdemucs_6s stem set (no 'instrumental')."""
    return _make_stems(tmp_path)


@pytest.fixture
def chord_result() -> ChordResult:
    """A realistic 3-segment recognition result."""
    return ChordResult(
        segments=[
            ChordSegment(start_sec=0.0, end_sec=1.6, label="C:maj", confidence=1.0),
            ChordSegment(start_sec=1.6, end_sec=3.2, label="F:maj", confidence=1.0),
            ChordSegment(start_sec=3.2, end_sec=4.8, label="G:7", confidence=1.0),
        ],
        key="C:major",
        provider="klangio",
        provider_version="2026-11-04",
        duration_sec=4.8,
        model_ms=123,
    )


def _run_hook(job_id: str, stems: dict, chord_result: ChordResult):
    """Run the hook with a mocked provider + R2; return (provider, r2)."""
    fake_provider = MagicMock()
    fake_provider.recognize.return_value = chord_result
    fake_r2 = MagicMock()
    with (
        patch("worker.chord_source.get_chord_source", return_value=fake_provider),
        patch("worker.storage.r2_uploader._r2", return_value=fake_r2),
    ):
        pipeline._maybe_run_chord_recognition(job_id, stems, list(stems))
    return fake_provider, fake_r2


# ----------------------------- Part 1: R2 upload path -----------------------------
def test_chord_hook_uploads_to_r2_with_correct_key_and_headers(
    stem_paths: dict[str, str],
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Happy path: recognition result is JSON-serialised and uploaded to the
    deterministic ``jobs/<job_id>/play.chords.json`` key with
    ``application/json`` + ``private, max-age=0`` headers."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")

    _, fake_r2 = _run_hook("job-abc", stem_paths, chord_result)

    fake_r2.put_object.assert_called_once()
    kwargs = fake_r2.put_object.call_args.kwargs
    assert kwargs["Bucket"] == "test-bucket"
    assert kwargs["Key"] == "jobs/job-abc/play.chords.json"
    assert kwargs["ContentType"] == "application/json"
    assert kwargs["CacheControl"] == "private, max-age=0"

    import json

    body = kwargs["Body"]
    assert isinstance(body, (bytes, bytearray))
    payload = json.loads(body.decode("utf-8"))
    assert payload["provider"] == "klangio"
    assert payload["provider_version"] == "2026-11-04"
    assert payload["key"] == "C:major"
    assert [s["label"] for s in payload["segments"]] == ["C:maj", "F:maj", "G:7"]


def test_chord_hook_upload_failure_is_logged_not_raised(
    stem_paths: dict[str, str],
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """R2 put_object raising MUST NOT propagate — the hook swallows the failure
    so the rest of the pipeline can still complete."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")

    fake_provider = MagicMock()
    fake_provider.recognize.return_value = chord_result
    fake_r2 = MagicMock()
    fake_r2.put_object.side_effect = RuntimeError("simulated R2 outage")

    with (
        patch("worker.chord_source.get_chord_source", return_value=fake_provider),
        patch("worker.storage.r2_uploader._r2", return_value=fake_r2),
    ):
        pipeline._maybe_run_chord_recognition("job-xyz", stem_paths, ["keys"])

    # Recognition ran once and its upload failed. The result is NOT kept, so a requeue would
    # call recognize() again; that second call reattaches to the recorded Klangio job instead
    # of paying (see test_chord_rebill.py::test_failed_upload_then_rerun_does_not_pay_twice).
    fake_provider.recognize.assert_called_once()


def test_chord_hook_provider_failure_is_logged_not_raised(
    stem_paths: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Provider raising also doesn't propagate."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")

    fake_provider = MagicMock()
    fake_provider.recognize.side_effect = RuntimeError("klangio 500")
    fake_r2 = MagicMock()

    with (
        patch("worker.chord_source.get_chord_source", return_value=fake_provider),
        patch("worker.storage.r2_uploader._r2", return_value=fake_r2),
    ):
        pipeline._maybe_run_chord_recognition("job-fail", stem_paths, ["keys"])

    # No chord artifact is written, only a tombstone saying the provider failed.
    fake_r2.put_object.assert_called_once()
    assert json.loads(fake_r2.put_object.call_args.kwargs["Body"]) == {
        "status": "unavailable",
        "reason": "provider_failed",
    }


# ----------------------------- Part 3: stem selection (real 6-stem set) ---------------
def test_fixture_is_the_real_htdemucs_6s_stem_set(stem_paths: dict[str, str]) -> None:
    """Guard the fixture itself: exactly the 6 stems production emits, no 'instrumental'.
    Cross-checks the piano->keys rename so the fixture can't silently drift again."""
    from worker.replicate_client import STEM_RENAME

    assert set(stem_paths) == set(REAL_6S_STEMS)
    assert "instrumental" not in stem_paths
    assert STEM_RENAME == {"piano": "keys"}


def test_chord_hook_default_sends_harmonic_mix_not_bare_other(
    stem_paths: dict[str, str],
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The realistic 6-stem set must yield harmonic audio: a mix of
    keys + guitar + other (+ bass), NOT the bare 'other' residue and NOT vocals."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")
    monkeypatch.setattr(pipeline, "CHORDS_DEFAULT_STEM", pipeline.HARMONIC_MIX)

    mixed_inputs: list[list[str]] = []
    real_mix = pipeline._mix_stems_to_wav

    def spy(paths: list[str]) -> str | None:
        mixed_inputs.append(list(paths))
        return real_mix(paths)

    seen: dict[str, object] = {}
    fake_provider = MagicMock()

    def recognize(audio_path, *, stem, **_kw):
        # The temp mix must exist and be non-empty at call time.
        seen["exists"] = os.path.exists(audio_path) and os.path.getsize(audio_path) > 44
        return chord_result

    fake_provider.recognize.side_effect = recognize
    with (
        patch.object(pipeline, "_mix_stems_to_wav", side_effect=spy),
        patch("worker.chord_source.get_chord_source", return_value=fake_provider),
        patch("worker.storage.r2_uploader._r2", return_value=MagicMock()),
    ):
        pipeline._maybe_run_chord_recognition("job-mix", stem_paths, list(stem_paths))

    call = fake_provider.recognize.call_args
    assert call.kwargs.get("stem") == "harmonic_mix"
    sent = str(call.args[0])
    assert sent not in stem_paths.values(), "must be a synthesised mix, not a single stem"
    assert seen["exists"] is True
    assert mixed_inputs == [
        [stem_paths["keys"], stem_paths["guitar"], stem_paths["other"], stem_paths["bass"]]
    ]


@pytest.mark.parametrize(
    "preferred", ["harmonic_mix", "instrumental", "mix", "", "vocals", "drums", "keys", "other"]
)
def test_vocals_and_drums_are_never_chosen(stem_paths: dict[str, str], preferred: str) -> None:
    """vocals is the worst-accuracy input and drums are noise: never selected, never mixed,
    whatever CHORDS_STEM says."""
    captured: list[list[str]] = []
    real_mix = pipeline._mix_stems_to_wav

    def spy(paths: list[str]) -> str | None:
        captured.append(list(paths))
        return real_mix(paths)

    with patch.object(pipeline, "_mix_stems_to_wav", side_effect=spy):
        chosen = pipeline._choose_chord_input(stem_paths, preferred=preferred)

    assert chosen is not None
    label, path = chosen
    assert label not in ("vocals", "drums")
    assert path not in (stem_paths["vocals"], stem_paths["drums"])
    for inputs in captured:
        assert stem_paths["vocals"] not in inputs
        assert stem_paths["drums"] not in inputs


def test_vocals_never_chosen_even_when_it_is_the_only_stem_besides_drums_bass(
    tmp_path: Path,
) -> None:
    stems = _make_stems(tmp_path, ("vocals", "drums", "bass"))
    for preferred in ("harmonic_mix", "vocals", "bass", "drums"):
        assert pipeline._choose_chord_input(stems, preferred=preferred) is None


def test_chord_hook_honours_explicit_single_stem_override(
    stem_paths: dict[str, str],
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CHORDS_STEM=keys is still a valid explicit choice (e.g. a piano-only catalogue)."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")
    monkeypatch.setattr(pipeline, "CHORDS_DEFAULT_STEM", "keys")

    provider, _ = _run_hook("job-keys", stem_paths, chord_result)

    call = provider.recognize.call_args
    assert str(call.args[0]) == stem_paths["keys"]
    assert call.kwargs.get("stem") == "keys"


def test_legacy_instrumental_setting_resolves_to_harmonic_mix(
    stem_paths: dict[str, str],
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Deployments still carrying CHORDS_STEM=instrumental (the old default in
    .env.example) must get the harmonic mix, not a silent fall-through to 'other'."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")
    monkeypatch.setattr(pipeline, "CHORDS_DEFAULT_STEM", "instrumental")

    provider, _ = _run_hook("job-legacy", stem_paths, chord_result)

    call = provider.recognize.call_args
    assert call.kwargs.get("stem") == "harmonic_mix"
    assert str(call.args[0]) not in stem_paths.values()


def test_single_harmonic_stem_present_skips_without_spending(tmp_path: Path) -> None:
    """One harmonic stem is not a mix. In a 6-stem split `other` is the residue after guitar and
    keys were removed, so sending it alone is plausible but wrong: skip, no mix, no request."""
    for only in ("guitar", "keys", "other"):
        stems = _make_stems(tmp_path, ("vocals", "drums", only))
        with patch.object(pipeline, "_mix_stems_to_wav") as mix:
            assert pipeline._choose_chord_input(stems) is None
        mix.assert_not_called()


def test_only_other_and_vocals_is_skipped_not_sent_as_other(tmp_path: Path) -> None:
    stems = _make_stems(tmp_path, ("vocals", "other"))
    assert pipeline._choose_chord_input(stems) is None


def test_mix_failure_skips_instead_of_sending_a_single_stem(
    stem_paths: dict[str, str],
) -> None:
    """If ffmpeg mixing fails there is no single-stem fallback: the old keys-first fallback
    could send a near-silent stem to a paid API."""
    with patch.object(pipeline, "_mix_stems_to_wav", return_value=None):
        assert pipeline._choose_chord_input(stem_paths) is None


def test_real_ffmpeg_mix_produces_nonempty_wav(stem_paths: dict[str, str]) -> None:
    """End-to-end ffmpeg mix (ffmpeg is a worker dependency): output is a decodable WAV."""
    out = pipeline._mix_stems_to_wav([stem_paths["keys"], stem_paths["guitar"]])
    assert out is not None
    with wave.open(out, "rb") as w:
        assert w.getframerate() == 44100
        assert w.getnchannels() == 2
        assert w.getnframes() > 0


def test_regression_instrumental_is_not_a_load_bearing_assumption(
    stem_paths: dict[str, str], tmp_path: Path
) -> None:
    """htdemucs_6s never emits 'instrumental'. This fails if the selector (or its default)
    starts depending on that stem again — the bug class where a fake fixture stem made
    the tests pass while production took a different branch."""
    # 1. The default must not name a stem the model doesn't produce.
    assert pipeline.CHORDS_DEFAULT_STEM != "instrumental"
    assert pipeline.CHORDS_DEFAULT_STEM == pipeline.HARMONIC_MIX or (
        pipeline.CHORDS_DEFAULT_STEM in REAL_6S_STEMS
    )
    # 2. The real stem set (no 'instrumental') yields harmonic audio, not None / bare other.
    chosen = pipeline._choose_chord_input(stem_paths, preferred=pipeline.CHORDS_DEFAULT_STEM)
    assert chosen is not None and chosen[0] != "other"
    # 3. A stray 'instrumental' key is ignored, not trusted over the real stems.
    decoy = tmp_path / "decoy_instrumental.wav"
    _write_wav(decoy, 999.0)
    with_decoy = {**stem_paths, "instrumental": str(decoy)}
    chosen = pipeline._choose_chord_input(with_decoy, preferred="instrumental")
    assert chosen is not None and chosen[1] != str(decoy)
    # 4. A set containing ONLY 'instrumental' is not usable -> skip, never silently use it.
    assert pipeline._choose_chord_input({"instrumental": str(decoy)}) is None


# ----------------------------- logging -----------------------------
def test_chord_hook_logs_which_input_was_used(
    stem_paths: dict[str, str],
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")
    monkeypatch.setattr(pipeline, "CHORDS_DEFAULT_STEM", pipeline.HARMONIC_MIX)

    with patch.object(pipeline, "log_structured") as log:
        _run_hook("job-log", stem_paths, chord_result)

    events = {c.args[1]: c.kwargs for c in log.call_args_list}
    assert events["chords_input_selected"]["chord_input"] == "harmonic_mix"
    assert events["chords_input_selected"]["job_id"] == "job-log"
    assert events["chords_complete"]["stem"] == "harmonic_mix"


# ----------------------------- feature-flag guards -----------------------------
def test_chord_hook_skipped_when_provider_disabled(
    stem_paths: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """CHORDS_PROVIDER='' is the Gate-2 fixture-run disable switch."""
    monkeypatch.setenv("CHORDS_PROVIDER", "")

    fake_r2 = MagicMock()
    with patch("worker.storage.r2_uploader._r2", return_value=fake_r2):
        pipeline._maybe_run_chord_recognition("job-off", stem_paths, ["keys"])

    fake_r2.put_object.assert_not_called()


def test_chord_hook_skipped_when_no_harmonic_stem(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No harmonic stem (only vocals/drums/bass) -> skip rather than feed vocals to
    Klangio, and log the accurately-named skip event."""
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")
    monkeypatch.setattr(pipeline, "CHORDS_DEFAULT_STEM", pipeline.HARMONIC_MIX)

    stems = _make_stems(tmp_path, ("vocals", "drums", "bass"))

    fake_provider = MagicMock()
    fake_r2 = MagicMock()

    with (
        patch.object(pipeline, "log_structured") as log,
        patch("worker.chord_source.get_chord_source", return_value=fake_provider),
        patch("worker.storage.r2_uploader._r2", return_value=fake_r2),
    ):
        pipeline._maybe_run_chord_recognition("job-vocals", stems, ["vocals"])

    fake_provider.recognize.assert_not_called()
    fake_r2.put_object.assert_called_once()
    assert json.loads(fake_r2.put_object.call_args.kwargs["Body"]) == {
        "status": "unavailable",
        "reason": "not_attempted",
    }
    names = [c.args[1] for c in log.call_args_list]
    assert "chords_skipped_no_harmonic_stem" in names
    assert "chords_skipped_no_instrumental_stem" not in names


# ----------------------------- Part 4: per-job idempotency (reaper requeue) -----------------
class _FakeR2:
    """Tiny stateful R2: put_object stores, get_object returns or raises NoSuchKey."""

    def __init__(self, preset: dict[str, bytes] | None = None) -> None:
        self.objects: dict[str, bytes] = dict(preset or {})
        self.put_object = MagicMock(side_effect=self._put)

    def _put(self, **kw) -> None:
        self.objects[kw["Key"]] = kw["Body"]

    def get_object(self, Bucket: str, Key: str) -> dict:  # noqa: N803
        if Key not in self.objects:
            from botocore.exceptions import ClientError

            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "x"}}, "GetObject")
        import io

        return {"Body": io.BytesIO(self.objects[Key])}


def _run_with_r2(job_id: str, stems: dict, result: ChordResult, r2, quota: MagicMock | None = None):
    """Run the hook; ``quota`` stands in for the Klangio reserve that recognize() performs."""
    provider = MagicMock()

    def _recognize(*_a, **_k):
        if quota is not None:
            quota.reserve()
        return result

    provider.recognize.side_effect = _recognize
    with (
        patch("worker.chord_source.get_chord_source", return_value=provider),
        patch("worker.storage.r2_uploader._r2", return_value=r2),
    ):
        pipeline._maybe_run_chord_recognition(job_id, stems, list(stems))
    return provider


@pytest.fixture
def _chord_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHORDS_PROVIDER", "klangio")
    monkeypatch.setenv("R2_BUCKET_NAME", "test-bucket")


def test_rerun_with_artifact_makes_zero_provider_calls_and_no_quota(
    stem_paths: dict[str, str], chord_result: ChordResult, _chord_env: None
) -> None:
    r2 = _FakeR2()
    quota = MagicMock()
    first = _run_with_r2("job-1", stem_paths, chord_result, r2, quota)
    assert first.recognize.call_count == 1 and quota.reserve.call_count == 1
    assert "jobs/job-1/play.chords.json" in r2.objects

    # Reaper requeue: whole pipeline reruns, hook is invoked again for the same job.
    second = _run_with_r2("job-1", stem_paths, chord_result, r2, quota)
    assert second.recognize.call_count == 0
    assert quota.reserve.call_count == 1  # unchanged: no increment for a call that never happened
    assert r2.put_object.call_count == 1  # artifact not rewritten


def test_first_run_without_artifact_behaves_as_before(
    stem_paths: dict[str, str], chord_result: ChordResult, _chord_env: None
) -> None:
    r2 = _FakeR2()
    quota = MagicMock()
    provider = _run_with_r2("job-new", stem_paths, chord_result, r2, quota)
    provider.recognize.assert_called_once()
    assert quota.reserve.call_count == 1
    assert r2.put_object.call_args.kwargs["Key"] == "jobs/job-new/play.chords.json"


def test_artifact_for_other_job_is_not_reused(
    stem_paths: dict[str, str], chord_result: ChordResult, _chord_env: None
) -> None:
    r2 = _FakeR2({"jobs/other/play.chords.json": b'{"segments":[{"label":"C"}]}'})
    provider = _run_with_r2("job-2", stem_paths, chord_result, r2)
    provider.recognize.assert_called_once()


@pytest.mark.parametrize(
    "bad",
    [b"", b"{not json", b"[]", b'"str"', b"{}", b'{"segments": null}'],
    ids=["zero-byte", "truncated", "list", "string", "no-segments", "null"],
)
def test_corrupt_or_empty_artifact_is_regenerated_not_permanent(
    stem_paths: dict[str, str], chord_result: ChordResult, _chord_env: None, bad: bytes
) -> None:
    """Semantics: only a JSON object with a ``segments`` list (empty is valid: a silent track
    yields []) suppresses the provider. Anything else is regenerated and overwritten in place."""
    key = "jobs/job-bad/play.chords.json"
    r2 = _FakeR2({key: bad})
    provider = _run_with_r2("job-bad", stem_paths, chord_result, r2)
    provider.recognize.assert_called_once()
    assert r2.objects[key] != bad and len(r2.objects[key]) > 0


def test_reuse_check_r2_error_fails_open(
    stem_paths: dict[str, str], chord_result: ChordResult, _chord_env: None
) -> None:
    """A transient R2 error on the check must not drop chords: fall through to the provider."""
    r2 = _FakeR2()
    r2.get_object = MagicMock(side_effect=RuntimeError("R2 503"))  # type: ignore[method-assign]
    provider = _run_with_r2("job-503", stem_paths, chord_result, r2)
    provider.recognize.assert_called_once()


def test_existing_artifact_skips_before_stem_mix(
    stem_paths: dict[str, str], chord_result: ChordResult, _chord_env: None
) -> None:
    r2 = _FakeR2({"jobs/job-3/play.chords.json": b'{"segments":[{"label":"C:maj"}]}'})
    with patch.object(pipeline, "_choose_chord_input") as choose:
        _run_with_r2("job-3", stem_paths, chord_result, r2)
    choose.assert_not_called()


def test_chord_heartbeat_beats_while_running_and_stops(monkeypatch: pytest.MonkeyPatch) -> None:
    """The chord stage (Klangio polling up to 600s) must bump jobs.updated_at inside the
    300s reaper stale window; the beat task must be gone once the stage exits."""
    import asyncio

    from worker import replicate_client

    beats: list[str] = []
    monkeypatch.setattr(replicate_client, "HEARTBEAT_SECONDS", 0.01)
    monkeypatch.setattr(replicate_client, "_heartbeat", lambda jid: beats.append(jid))

    async def go() -> int:
        async with pipeline._chord_heartbeat("job-hb"):
            await asyncio.sleep(0.1)
        n = len(beats)
        await asyncio.sleep(0.05)
        assert len(beats) == n  # stopped on exit
        return n

    assert asyncio.run(go()) >= 2
    assert set(beats) == {"job-hb"}


# ----------------------- duration gate + tombstones (too_long etc.) -----------------------
def _tombstone(r2: MagicMock) -> dict:
    r2.put_object.assert_called_once()
    return json.loads(r2.put_object.call_args.kwargs["Body"])


def test_under_limit_track_behaves_as_before(
    stem_paths: dict[str, str], chord_result: ChordResult, _chord_env: None
) -> None:
    """0.2 s stems: provider is called once and the artifact is the real ChordResult."""
    r2 = _FakeR2()
    provider = _run_with_r2("job-short", stem_paths, chord_result, r2)
    provider.recognize.assert_called_once()
    body = json.loads(r2.objects["jobs/job-short/play.chords.json"])
    assert body["segments"] and "status" not in body


def test_over_limit_skips_provider_mix_and_writes_too_long_tombstone(
    stem_paths: dict[str, str], monkeypatch: pytest.MonkeyPatch, _chord_env: None
) -> None:
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: 1200.0)  # 20 min
    provider = MagicMock()
    r2 = MagicMock()
    r2.get_object.side_effect = RuntimeError("NoSuchKey")
    with (
        patch.object(pipeline, "_choose_chord_input") as choose,
        patch("worker.chord_source.get_chord_source", return_value=provider),
        patch("worker.storage.r2_uploader._r2", return_value=r2),
    ):
        pipeline._maybe_run_chord_recognition("job-long", stem_paths, list(stem_paths))
    provider.recognize.assert_not_called()  # no Klangio call
    choose.assert_not_called()  # and no wasted ffmpeg mix
    body = _tombstone(r2)
    assert body["status"] == "unavailable" and body["reason"] == "too_long"
    assert r2.put_object.call_args.kwargs["Key"] == "jobs/job-long/play.chords.json"


def test_limit_is_read_from_config_not_hardcoded(
    stem_paths: dict[str, str],
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
    _chord_env: None,
) -> None:
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: 400.0)
    # Default 300: 400 s is too long.
    monkeypatch.delenv("CHORDS_MAX_AUDIO_SEC", raising=False)
    assert pipeline._chords_max_audio_sec() == 300.0
    r2 = _FakeR2()
    assert _run_with_r2("job-a", stem_paths, chord_result, r2).recognize.call_count == 0
    # Raised to 600 (e.g. Enterprise): the same track now goes through.
    monkeypatch.setenv("CHORDS_MAX_AUDIO_SEC", "600")
    r2 = _FakeR2()
    assert _run_with_r2("job-b", stem_paths, chord_result, r2).recognize.call_count == 1
    # Lowered to 100: a 150 s track is skipped.
    monkeypatch.setenv("CHORDS_MAX_AUDIO_SEC", "100")
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: 150.0)
    assert _run_with_r2("job-c", stem_paths, chord_result, _FakeR2()).recognize.call_count == 0


@pytest.mark.parametrize("bad", ["abc", "0", "-5", "inf", "nan"])
def test_invalid_limit_falls_back_to_default(bad: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHORDS_MAX_AUDIO_SEC", bad)
    assert pipeline._chords_max_audio_sec() == 300.0


def test_exactly_at_limit_is_allowed(
    stem_paths: dict[str, str],
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
    _chord_env: None,
) -> None:
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: 300.0)
    assert _run_with_r2("job-edge", stem_paths, chord_result, _FakeR2()).recognize.call_count == 1


def test_unmeasurable_duration_fails_open_to_provider_check(
    stem_paths: dict[str, str],
    chord_result: ChordResult,
    monkeypatch: pytest.MonkeyPatch,
    _chord_env: None,
) -> None:
    """If we cannot probe, do not tombstone: the provider's own fail-closed check decides."""
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: None)
    assert _run_with_r2("job-np", stem_paths, chord_result, _FakeR2()).recognize.call_count == 1


def test_real_probe_measures_a_wav(tmp_path: Path) -> None:
    p = tmp_path / "x.wav"
    _write_wav(p, 440.0, secs=1.5)
    assert pipeline._probe_duration_sec(str(p)) == pytest.approx(1.5, abs=0.05)
    assert pipeline._probe_duration_sec(str(tmp_path / "missing.wav")) is None


def test_tombstone_is_not_treated_as_a_reusable_artifact(
    stem_paths: dict[str, str], chord_result: ChordResult, _chord_env: None
) -> None:
    """A rerun after a (possibly transient) provider_failed tombstone must retry."""
    key = "jobs/job-tomb/play.chords.json"
    r2 = _FakeR2({key: b'{"status":"unavailable","reason":"provider_failed"}'})
    provider = _run_with_r2("job-tomb", stem_paths, chord_result, r2)
    provider.recognize.assert_called_once()


def test_tombstone_write_failure_is_swallowed(
    stem_paths: dict[str, str], monkeypatch: pytest.MonkeyPatch, _chord_env: None
) -> None:
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: 1200.0)
    r2 = MagicMock()
    r2.get_object.side_effect = RuntimeError("NoSuchKey")
    r2.put_object.side_effect = RuntimeError("R2 down")
    with patch("worker.storage.r2_uploader._r2", return_value=r2):
        pipeline._maybe_run_chord_recognition("job-x", stem_paths, list(stem_paths))


def test_disabled_provider_writes_no_tombstone(
    stem_paths: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CHORDS_PROVIDER", "")
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: 1200.0)
    r2 = MagicMock()
    with patch("worker.storage.r2_uploader._r2", return_value=r2):
        pipeline._maybe_run_chord_recognition("job-off2", stem_paths, list(stem_paths))
    r2.put_object.assert_not_called()


def test_loader_reasons_match_what_worker_writes() -> None:
    """The reasons the worker writes must be ones play-chords-loader.ts maps (not 'unknown')."""
    loader = Path(__file__).resolve().parents[3] / "apps/web/src/chord/play-chords-loader.ts"
    src = loader.read_text()
    for reason in ("too_long", "provider_failed", "not_attempted"):
        assert f"v === '{reason}'" in src
