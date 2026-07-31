"""Hardening H11: the worker must not leave temp directories behind.

The backlog previously discounted this as "Fly restarts clear ephemeral disk", but
the worker is an always-on machine now (min_machines_running=1), so every job and
every reaper retry leaked 40-60MB of stem/loop WAVs permanently until the 4GB VM
filled and every subsequent job failed fleet-wide with ENOSPC.

Each test asserts on the set of sl_*/stub_* directories in the system temp dir, so
it catches a leak from any call path rather than a specific implementation detail.
"""

import glob
import os
import tempfile
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
import soundfile as sf

from worker import pipeline, stub_separation
from worker.downloader import ytdlp_client
from worker.errors import DownloadBlockedError, DownloadTimeoutError, UploadInvalidError

PREFIXES = ("sl_upload_*", "sl_loops_*", "sl_stems_*", "stub_ph_*", "sl_ytdlp_*", "stub_*")


def _worker_tmpdirs() -> set[str]:
    root = tempfile.gettempdir()
    found: set[str] = set()
    for pattern in PREFIXES:
        found.update(glob.glob(os.path.join(root, pattern)))
    return found


@pytest.fixture
def no_new_tmpdirs():
    """Fail the test if it leaves a worker temp directory behind."""
    before = _worker_tmpdirs()
    yield
    leaked = _worker_tmpdirs() - before
    assert not leaked, f"leaked temp dirs: {leaked}"


def test_upload_source_cleans_up_on_success(no_new_tmpdirs):
    with (
        patch("worker.pipeline.download_object"),
        patch("worker.pipeline._ffmpeg_bin", return_value="/bin/true"),
        patch("worker.pipeline.subprocess.run") as run,
        patch("worker.pipeline.upload_input", return_value="https://r2/signed") as up,
    ):
        # Stand in for ffmpeg: write a non-empty WAV where the real binary would.
        def _fake_ffmpeg(cmd, **kwargs):
            with open(cmd[-1], "wb") as f:
                f.write(b"RIFF....WAVE")
            return MagicMock(returncode=0, stderr="")

        run.side_effect = _fake_ffmpeg
        assert pipeline._prepare_upload_source("job-1", "job-1/_input.mp3") == "https://r2/signed"
    up.assert_called_once()


def test_upload_source_cleans_up_when_ffmpeg_rejects_the_file(no_new_tmpdirs):
    """The failure path matters most — a bad upload is a normal, frequent event."""
    with (
        patch("worker.pipeline.download_object"),
        patch("worker.pipeline._ffmpeg_bin", return_value="/bin/true"),
        patch(
            "worker.pipeline.subprocess.run",
            return_value=MagicMock(returncode=1, stderr="not audio"),
        ),
    ):
        with pytest.raises(UploadInvalidError):
            pipeline._prepare_upload_source("job-1", "job-1/_input.txt")


def test_upload_source_cleans_up_when_the_download_itself_fails(no_new_tmpdirs):
    with patch("worker.pipeline.download_object", side_effect=RuntimeError("R2 down")):
        with pytest.raises(RuntimeError):
            pipeline._prepare_upload_source("job-1", "job-1/_input.mp3")


def _loop(sr=44100, dur=2.0):
    t = np.arange(int(sr * dur)) / sr
    return {
        "stem": "drums",
        "start_sec": 0.0,
        "end_sec": dur,
        "audio": (0.4 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)[np.newaxis, :],
        "sr": sr,
    }


def test_encode_and_upload_cleans_up_on_success(no_new_tmpdirs):
    tags = {"bpm": 120.0, "musical_key": "C major"}
    with (
        patch("worker.pipeline.upload_loop", return_value="job-1/drums/verse_0000.wav"),
        patch("worker.pipeline._insert_loop"),
        patch("worker.pipeline.Heartbeat.beat"),
    ):
        assert pipeline.encode_and_upload("job-1", [_loop()], tags, {}, {}, 4) == 1


def test_encode_and_upload_cleans_up_when_r2_fails(no_new_tmpdirs):
    tags = {"bpm": 120.0, "musical_key": None}
    with (
        patch("worker.pipeline.upload_loop", side_effect=RuntimeError("R2 refused")),
        patch("worker.pipeline._insert_loop"),
        patch("worker.pipeline.Heartbeat.beat"),
    ):
        with pytest.raises(RuntimeError):
            pipeline.encode_and_upload("job-1", [_loop()], tags, {}, {}, 4)


def test_stub_placeholder_dir_is_removed_by_its_owner(no_new_tmpdirs):
    """_stub_placeholder_wav's dir is owned by _insert_stub_loops, on both paths."""
    seen = {}

    def _record(job_id, stems, sections, bars, bpm, key, bar_sec, placeholder):
        seen["path"] = placeholder
        return 0

    with patch("worker.pipeline._write_stub_loops", side_effect=_record):
        pipeline._insert_stub_loops("job-1", ["drums"], 4)
    if seen.get("path") is None:
        pytest.skip("audio libs unavailable, no placeholder was created")
    assert not os.path.exists(os.path.dirname(seen["path"]))

    with patch("worker.pipeline._write_stub_loops", side_effect=RuntimeError("db down")):
        with pytest.raises(RuntimeError):
            pipeline._insert_stub_loops("job-1", ["drums"], 4)


def test_stub_separate_cleans_up_after_its_context(no_new_tmpdirs):
    with stub_separation.stub_separate("job-1") as stem_paths:
        assert len(stem_paths) == len(stub_separation.STEMS)
        assert all(os.path.exists(p) for p in stem_paths.values())
        held = next(iter(stem_paths.values()))
    assert not os.path.exists(held)


def _ytdlp_result(returncode: int, stderr: str = ""):
    return MagicMock(returncode=returncode, stderr=stderr)


@pytest.mark.parametrize(
    "result,expected",
    [
        (_ytdlp_result(1, "Sign in to confirm you're not a bot"), DownloadBlockedError),
        (_ytdlp_result(0), DownloadBlockedError),  # exit 0 but produced no .wav
    ],
)
def test_ytdlp_cleans_up_on_failure(result, expected, no_new_tmpdirs):
    with (
        patch("worker.downloader.ytdlp_client._reject_if_live"),
        patch("worker.downloader.ytdlp_client.subprocess.run", return_value=result),
    ):
        with pytest.raises(expected):
            ytdlp_client.fetch_audio_file("https://youtu.be/fake")


def test_ytdlp_cleans_up_on_timeout(no_new_tmpdirs):
    import subprocess

    with (
        patch("worker.downloader.ytdlp_client._reject_if_live"),
        patch(
            "worker.downloader.ytdlp_client.subprocess.run",
            side_effect=subprocess.TimeoutExpired("yt-dlp", 10),
        ),
    ):
        with pytest.raises(DownloadTimeoutError):
            ytdlp_client.fetch_audio_file("https://youtu.be/fake")


def test_ytdlp_success_hands_the_dir_to_the_caller():
    """On success the file must still exist — run_pipeline stages it to R2 and then
    removes the directory itself (it can't be cleaned before the caller reads it)."""
    before = _worker_tmpdirs()

    def _fake_run(cmd, **kwargs):
        out_template = cmd[cmd.index("-o") + 1]
        tmpdir = os.path.dirname(out_template)
        sf.write(os.path.join(tmpdir, "abc.wav"), np.zeros(1000, dtype=np.float32), 44100)
        return MagicMock(returncode=0, stderr="")

    with (
        patch("worker.downloader.ytdlp_client._reject_if_live"),
        patch("worker.downloader.ytdlp_client.subprocess.run", side_effect=_fake_run),
    ):
        path = ytdlp_client.fetch_audio_file("https://youtu.be/fake")
    try:
        assert os.path.exists(path)
        assert os.path.dirname(path) in (_worker_tmpdirs() - before)
    finally:
        import shutil

        shutil.rmtree(os.path.dirname(path), ignore_errors=True)
