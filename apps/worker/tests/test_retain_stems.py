"""Behavioural tests for V3-J2 stem retention.

WHY THIS FILE EXISTS. An M-9 adversarial review ran 18 mutations against the first
version of this feature and **12 survived with every suite green**, because the only
tests covered the key-string builders. You could upload the WAV as the playback
artifact, make the encoder always fail, or change the retained stem set, and nothing
failed. These tests pin the BEHAVIOUR, and each names the mutation it kills.
"""

import os
import subprocess

import pytest

from worker import pipeline

JOB = "550e8400-e29b-41d4-a716-446655440000"
SIX = ("vocals", "drums", "bass", "other", "guitar", "keys")


def _ffmpeg() -> str:
    return pipeline._ffmpeg_bin()


@pytest.fixture
def stem_wavs(tmp_path):
    """Six short, real 24-bit stereo WAVs — real files, so the encoder really runs."""
    paths = {}
    for i, name in enumerate(SIX):
        p = tmp_path / f"{name}.wav"
        subprocess.run(
            [
                _ffmpeg(),
                "-nostdin",
                "-y",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                f"sine=frequency={110 * (i + 1)}:duration=1:sample_rate=44100",
                "-ac",
                "2",
                "-c:a",
                "pcm_s24le",
                str(p),
            ],
            check=True,
            capture_output=True,
        )
        paths[name] = str(p)
    return paths


@pytest.fixture
def recorder(monkeypatch):
    """Capture every upload_stem call instead of talking to R2."""
    calls: list[tuple[str, str, str]] = []

    def fake_upload(job_id, stem, local_path, kind):
        calls.append((stem, local_path, kind))
        return f"{job_id}/_stems/{kind}/{stem}"

    monkeypatch.setattr(pipeline, "upload_stem", fake_upload)
    return calls


# --------------------------------------------------------------------------
# The retained set
# --------------------------------------------------------------------------


def test_all_stems_is_the_literal_six_not_a_derived_value():
    """Kills the ALL_STEMS mutation that survived.

    The rewritten test in test_chord_rebill.py asserts ``set(also) == set(ALL_STEMS)``,
    which is a TAUTOLOGY: it compares the code to itself, so renaming ``drums`` to
    ``piano`` passes. This asserts the literal names, which is the actual contract
    with htdemucs_6s and with apps/web/src/lib/stem-keys.ts.
    """
    assert set(pipeline.ALL_STEMS) == {"vocals", "drums", "bass", "other", "guitar", "keys"}
    assert len(pipeline.ALL_STEMS) == 6
    # drums and vocals are the two the old requested_stems filter could silently drop
    assert "drums" in pipeline.ALL_STEMS
    assert "vocals" in pipeline.ALL_STEMS


def test_a_stem_outside_the_closed_set_is_ignored(stem_wavs, recorder):
    """A stray key in stem_paths must not become an uploaded artifact."""
    paths = dict(stem_wavs)
    paths["harmonic_mix"] = paths["bass"]
    report = pipeline.retain_stems(JOB, paths)
    assert "harmonic_mix" not in report["play"]
    assert "harmonic_mix" not in report["download"]
    assert all(stem in SIX for stem, _, _ in recorder)


def test_a_missing_file_is_skipped_not_uploaded(recorder):
    report = pipeline.retain_stems(JOB, {"drums": "/does/not/exist.wav", "bass": None})
    assert report["play"] == []
    assert report["download"] == []
    assert recorder == []


# --------------------------------------------------------------------------
# Which artifact goes where — the original Defect 1
# --------------------------------------------------------------------------


def test_playback_gets_the_opus_and_download_gets_the_source_wav(stem_wavs, recorder):
    """Kills the mutation that uploads the WAV as the playback artifact.

    That was the original defect: serving WAV to the mixer is 240-360 MB per song
    against a measured 287 MB Variant D budget. The two artifacts are distinguished
    here by EXTENSION, not by trusting the kind label.
    """
    report = pipeline.retain_stems(JOB, stem_wavs)
    assert sorted(report["play"]) == sorted(SIX)
    assert sorted(report["download"]) == sorted(SIX)

    by_kind: dict[str, list[tuple[str, str]]] = {"play": [], "download": []}
    for stem, path, kind in recorder:
        by_kind[kind].append((stem, path))

    assert len(by_kind["play"]) == 6
    assert len(by_kind["download"]) == 6
    for stem, path in by_kind["play"]:
        assert path.endswith(".opus"), f"play artifact for {stem} must be Opus, got {path}"
        assert os.path.getsize(path) > 0
    for stem, path in by_kind["download"]:
        assert path.endswith(".wav"), f"download artifact for {stem} must be WAV, got {path}"
        assert path == stem_wavs[stem], "the download artifact IS the source wav"


def test_the_opus_is_smaller_than_the_wav_it_came_from(stem_wavs, recorder):
    """Cheap guard against the codec being swapped for something non-compressing.

    A mutation replacing ``libopus`` with ``pcm_s16le`` produces a `.opus` file
    holding WAV-size PCM, which passes an extension check and blows the memory budget.
    """
    pipeline.retain_stems(JOB, stem_wavs)
    opus = {s: p for s, p, k in recorder if k == "play"}
    for stem, path in opus.items():
        assert (
            os.path.getsize(path) < os.path.getsize(stem_wavs[stem]) / 2
        ), f"{stem}: {os.path.getsize(path)} vs wav {os.path.getsize(stem_wavs[stem])}"


def test_the_encoded_artifact_really_is_ogg_opus(stem_wavs, recorder):
    pipeline.retain_stems(JOB, {"bass": stem_wavs["bass"]})
    play = [p for _, p, k in recorder if k == "play"]
    assert len(play) == 1
    with open(play[0], "rb") as fh:
        head = fh.read(4)
    assert head == b"OggS", f"expected an Ogg container, got {head!r}"


# --------------------------------------------------------------------------
# Failure is loud — the review's BLOCKING finding
# --------------------------------------------------------------------------


def test_total_encode_failure_still_uploads_wavs_and_reports_incomplete(
    stem_wavs, recorder, monkeypatch
):
    """Kills the mutation where _encode_stem_opus always returns None.

    The reviewer's false green: with every encode failing, the job still reached
    ``done``, six WAVs uploaded, and the route returned the same shape as a job that
    predates V3-J2. ``/bin/false`` stands in for a broken ffmpeg or a build without
    libopus.
    """
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", lambda: "/bin/false")
    report = pipeline.retain_stems(JOB, stem_wavs)

    assert report["play"] == [], "nothing should be playable"
    assert sorted(report["download"]) == sorted(SIX), "the WAVs must still land"
    assert report["complete"] is False
    # the download set is what lets the route say "encoder broke" rather than "old job"
    assert len(report["download"]) > len(report["play"])


def test_encode_failure_logs_the_exit_code_and_ffmpeg_stderr(stem_wavs, monkeypatch, capsys):
    """The first version logged str(exc)[:200] — the COMMAND LINE, truncated before the
    exit status — and threw ffmpeg's stderr away, leaving a total failure undiagnosable.
    """
    monkeypatch.setattr(pipeline, "upload_stem", lambda *a, **k: "k")
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", lambda: "/bin/false")
    pipeline.retain_stems(JOB, {"drums": stem_wavs["drums"]})
    # log_structured writes JSON lines to STDERR (logger.py docstring), and
    # readouterr() DRAINS the buffer — so capture once and read both streams off
    # that single result. Calling it twice returns an empty second read.
    cap = capsys.readouterr()
    out = cap.err + cap.out

    assert "stem_opus_encode_failed" in out
    assert "returncode" in out, "the exit status must be logged, not swallowed"
    assert "stderr_tail" in out, "ffmpeg's own error text must be logged"
    assert JOB in out, "the job id must be present or the log cannot be acted on"


def test_an_incomplete_retention_reports_a_likely_cause(stem_wavs, monkeypatch, capsys):
    monkeypatch.setattr(pipeline, "upload_stem", lambda *a, **k: "k")
    monkeypatch.setattr(pipeline, "_ffmpeg_bin", lambda: "/bin/false")
    pipeline.retain_stems(JOB, stem_wavs)
    cap = capsys.readouterr()
    out = cap.err + cap.out

    assert "stems_retained_incomplete" in out
    # six WAVs and zero Opus is an ENCODER problem, not an upload one
    assert "encoder" in out


def test_a_missing_ffmpeg_does_not_fail_the_job(stem_wavs, recorder, monkeypatch):
    """_ffmpeg_bin() used to be evaluated OUTSIDE the try, so InternalError escaped
    retain_stems and failed a job whose loops had already uploaded — the opposite of
    this function's documented posture.
    """

    def boom():
        raise pipeline.InternalError("ffmpeg unavailable: none found")

    monkeypatch.setattr(pipeline, "_ffmpeg_bin", boom)
    report = pipeline.retain_stems(JOB, stem_wavs)  # must NOT raise
    assert report["play"] == []
    assert sorted(report["download"]) == sorted(SIX)


def test_an_upload_failure_for_one_stem_does_not_lose_the_others(stem_wavs, monkeypatch):
    seen: list[tuple[str, str]] = []

    def flaky(job_id, stem, local_path, kind):
        if stem == "guitar":
            raise RuntimeError("R2 503")
        seen.append((stem, kind))
        return "k"

    monkeypatch.setattr(pipeline, "upload_stem", flaky)
    report = pipeline.retain_stems(JOB, stem_wavs)
    assert "guitar" not in report["play"]
    assert "guitar" not in report["download"]
    assert len(report["play"]) == 5
    assert report["complete"] is False


# --------------------------------------------------------------------------
# Report shape — the route's contract
# --------------------------------------------------------------------------


def test_complete_is_true_only_when_all_six_are_PLAYABLE(stem_wavs, recorder):
    report = pipeline.retain_stems(JOB, stem_wavs)
    assert report["complete"] is True
    assert set(report["expected"]) == set(pipeline.ALL_STEMS)


def test_complete_is_false_when_a_stem_is_absent(stem_wavs, recorder):
    partial = {k: v for k, v in stem_wavs.items() if k != "drums"}
    report = pipeline.retain_stems(JOB, partial)
    assert report["complete"] is False
    assert "drums" not in report["play"]
    # expected still names all six, so a consumer can see WHAT is missing
    assert "drums" in report["expected"]
