"""Link (YouTube) duration cap: an over-length video is refused before any spend.

WHY THIS FILE EXISTS. ``_max_upload_duration_sec()`` had exactly ONE caller --
``_prepare_upload_source`` -- so the 300 s ceiling was enforced on the upload path and
NOWHERE on the link path. A linked 10-minute video was accepted, a full Replicate
separation was billed per GPU-second over its whole length ($0.0014/s, replicate_client),
the chord overlay was replaced by a ``too_long`` tombstone, and only then did the browser
player refuse to open it (engine.ts, MAX_TRACK_SEC). The user waited through a paid
separation to be told no.

WHAT IS ASSERTED, AND HOW. Every length here is produced independently of the code under
test: a WAV of N seconds is written frame by frame with the stdlib ``wave`` module, and the
metadata readings are literal numbers handed to a stub. No assertion re-derives a duration
with ``_probe_duration_sec`` and then checks the code against that -- which would only prove
the code applied its own arithmetic to its own measurement.

The two layers are tested separately because they fail differently:
  * downloader gate 0c reads yt-dlp metadata and FAILS OPEN (a saver, not the enforcement);
  * ``pipeline._enforce_link_duration`` measures the staged file and is the enforcement.
"""

from __future__ import annotations

import asyncio
import math
import struct
import subprocess
import wave
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from worker import downloader, pipeline
from worker.downloader import ytdlp_client
from worker.errors import ALL_ERROR_CODES, LinkTooLongError, UploadTooLongError

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
# jobs.id is a uuid column; a non-uuid id fails at the first real DB statement.
JOB = "00000000-0000-4000-8000-0000000d0001"


def _wav(path: Path, secs: float, sr: int = 8000) -> Path:
    """A real WAV of exactly ``secs`` seconds. The length is set HERE, by frame count."""
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(
            b"".join(struct.pack("<h", int(3000 * math.sin(i / 20))) for i in range(int(sr * secs)))
        )
    return path


# ----------------------- layer 2: the enforcement, on bytes we hold -----------------------


def test_over_length_staged_file_is_refused(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    with pytest.raises(LinkTooLongError) as ei:
        pipeline._enforce_link_duration(JOB, str(_wav(tmp_path / "long.wav", 5.0)))
    assert ei.value.error_code == "UPLOAD_TOO_LONG"


def test_within_length_staged_file_passes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    assert pipeline._enforce_link_duration(JOB, str(_wav(tmp_path / "ok.wav", 2.0))) is None


def test_the_link_cap_is_the_upload_cap_and_moves_with_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    """The anti-drift assertion: ONE knob governs both inputs.

    A 5 s track is refused at a 3 s cap and accepted at a 30 s cap, with nothing changed but
    ``MAX_UPLOAD_DURATION_SEC`` -- the upload path's own env var. A second, link-only ceiling
    (the obvious way to re-break this) would leave one of these two halves failing.
    """
    staged = str(_wav(tmp_path / "five.wav", 5.0))
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    with pytest.raises(LinkTooLongError):
        pipeline._enforce_link_duration(JOB, staged)
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "30")
    assert pipeline._enforce_link_duration(JOB, staged) is None


def test_unmeasurable_staged_file_proceeds_and_says_so(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture
):
    """Documented residue, pinned so it cannot change silently in either direction.

    Audio whose length cannot be read proceeds -- the same stance ``_prepare_upload_source``
    takes on an unmeasurable header and an unmeasurable decode. Pinned because this is the
    one input for which "longer tracks are not accepted" is not enforceable, so a future
    change to fail CLOSED here should be a deliberate, visible one.
    """
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    junk = tmp_path / "unreadable.wav"
    junk.write_bytes(b"not audio at all")
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda _p: None)
    assert pipeline._enforce_link_duration(JOB, str(junk)) is None
    assert "link_duration_unmeasured" in capsys.readouterr().err


# ------------------------ layer 1: gate 0c, before a byte is fetched ------------------------


@pytest.fixture
def chain(monkeypatch: pytest.MonkeyPatch):
    """download_audio with its gates open and both fetchers recorded, never run for real."""
    calls: list[str] = []
    monkeypatch.setattr(downloader.fetch_gates, "is_blocklisted", lambda _v: False)
    monkeypatch.setattr(downloader.fetch_gates, "fetch_paused", lambda: None)
    monkeypatch.setattr(downloader.fetch_gates, "cobalt_allowed", lambda: False)
    monkeypatch.setattr(downloader.fetch_gates, "log_attempt", lambda **kw: None)
    monkeypatch.setattr(downloader.fetch_gates, "ytdlp_version", lambda: "test")
    monkeypatch.setattr(
        downloader.ytdlp_client,
        "fetch_audio_file",
        lambda u: calls.append("ytdlp") or "/tmp/a.wav",
    )
    monkeypatch.setattr(
        downloader.cobalt_client,
        "fetch_audio_url",
        lambda u: calls.append("cobalt") or "https://tunnel",
    )
    return calls


def test_gate_0c_refuses_from_metadata_without_fetching(chain, monkeypatch: pytest.MonkeyPatch):
    """612 s is the figure from the report that opened this: a 10:12 video."""
    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", lambda _u: 612.0)
    with pytest.raises(LinkTooLongError) as ei:
        downloader.download_audio(URL, JOB, 300.0)
    assert "5 minutes" in ei.value.user_message
    assert chain == []  # neither fetcher ran: no download, no proxy traffic, no spend


def test_gate_0c_lets_a_short_video_through(chain, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", lambda _u: 120.0)
    assert downloader.download_audio(URL, JOB, 300.0) == ("/tmp/a.wav", "ytdlp")
    assert chain == ["ytdlp"]


def test_gate_0c_fails_open_on_an_unreadable_length(chain, monkeypatch: pytest.MonkeyPatch):
    """None means UNKNOWN. The fetch proceeds and layer 2 does the refusing."""
    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", lambda _u: None)
    assert downloader.download_audio(URL, JOB, 300.0) == ("/tmp/a.wav", "ytdlp")
    assert chain == ["ytdlp"]


def test_no_cap_passed_means_no_probe_at_all(chain, monkeypatch: pytest.MonkeyPatch):
    """Every pre-existing caller passes no cap; none of them should gain a subprocess."""
    probed = MagicMock(side_effect=AssertionError("must not probe without a cap"))
    monkeypatch.setattr(downloader.ytdlp_client, "probe_duration_sec", probed)
    assert downloader.download_audio(URL, JOB) == ("/tmp/a.wav", "ytdlp")
    probed.assert_not_called()


# ------------------------------ the metadata reader itself ------------------------------


@pytest.mark.parametrize(
    "stdout,rc,expected",
    [
        ("612.0\n", 0, 612.0),
        ("612\n", 0, 612.0),
        ("NA\n", 0, None),  # yt-dlp's own "field absent" output
        ("", 0, None),
        ("0\n", 0, None),
        ("-5\n", 0, None),
        ("inf\n", 0, None),
        ("612.0\n", 1, None),  # a failed probe is unknown, not short
    ],
)
def test_probe_duration_sec_reads_yt_dlp_output(
    monkeypatch: pytest.MonkeyPatch, stdout: str, rc: int, expected: float | None
):
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    monkeypatch.setattr(
        ytdlp_client.subprocess,
        "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, rc, stdout, ""),
    )
    assert ytdlp_client.probe_duration_sec(URL) == expected


def test_probe_duration_sec_downloads_nothing_and_is_bounded(monkeypatch: pytest.MonkeyPatch):
    seen: dict = {}

    def spy(cmd, **kw):
        seen["cmd"] = cmd
        seen["kw"] = kw
        return subprocess.CompletedProcess(cmd, 0, "100\n", "")

    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    monkeypatch.setattr(ytdlp_client.subprocess, "run", spy)
    ytdlp_client.probe_duration_sec(URL)
    assert "--simulate" in seen["cmd"]  # metadata only: no media request, no bytes
    assert seen["kw"]["timeout"] == 15  # cannot hang the worker thread


def test_probe_timeout_is_unknown_not_short(monkeypatch: pytest.MonkeyPatch):
    def boom(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, 15)

    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    monkeypatch.setattr(ytdlp_client.subprocess, "run", boom)
    assert ytdlp_client.probe_duration_sec(URL) is None


# ----------------------------- the message, and the whole run -----------------------------


def test_message_names_the_cap_and_does_not_tell_a_linker_to_re_upload():
    assert LinkTooLongError.error_code == "UPLOAD_TOO_LONG"
    assert "UPLOAD_TOO_LONG" in ALL_ERROR_CODES
    assert issubclass(LinkTooLongError, UploadTooLongError)
    msg = LinkTooLongError(max_seconds=300.0).user_message
    assert "5 minutes" in msg
    assert "too long" in msg
    # The parent's wording ("Trim it and upload it again") is nonsense for a pasted URL.
    assert "upload it again" not in msg
    assert "10 minutes" in LinkTooLongError(max_seconds=600.0).user_message
    assert "30 seconds" in LinkTooLongError(max_seconds=30.0).user_message


def test_over_length_link_reaches_no_paid_provider(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """The whole pipeline on a link job: Replicate sees ZERO requests and the job fails typed.

    This is the regression that matters. ``submit_or_reattach`` is the first billed call on
    this path, and it is replaced with a landmine: if the refusal ever moves to after it, or
    disappears, this test reports a call that must never happen rather than a copy fragment.
    """
    from worker import replicate_client

    # CI sets STUB_MODE=true; _run_pipeline would then skip the real path (and every duration
    # gate on it) and write fake loops instead.
    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    monkeypatch.setenv("MAX_UPLOAD_DURATION_SEC", "3")
    monkeypatch.setenv("REPLICATE_API_TOKEN", "r8_test")

    staged = str(_wav(tmp_path / "ten_minutes_in_spirit.wav", 5.0))
    # Gate 0c is deliberately blinded (metadata unreadable) so that this test exercises the
    # ENFORCEMENT on the staged file rather than the saver in front of it.
    monkeypatch.setattr(pipeline, "download_audio", lambda u, j, cap=None: (staged, "ytdlp"))
    uploaded: list[str] = []
    monkeypatch.setattr(pipeline, "upload_input", lambda j, p: uploaded.append(p) or "https://x")

    submitted = MagicMock(side_effect=AssertionError("Replicate must not be called"))
    monkeypatch.setattr(pipeline, "submit_or_reattach", submitted)
    monkeypatch.setattr(replicate_client.httpx, "post", submitted)

    row = (URL, ["drums"], 4, "youtube", None, None)
    monkeypatch.setattr(pipeline, "_fetch_job", lambda _j: row)

    async def noop(*a, **k):
        return None

    failed: list[tuple] = []

    async def record_fail(*a):
        failed.append(a)

    monkeypatch.setattr(pipeline, "set_status", noop)
    monkeypatch.setattr(pipeline, "emit_event", noop)
    monkeypatch.setattr(pipeline, "_fail", record_fail)

    with pytest.raises(LinkTooLongError):
        asyncio.run(pipeline._run_pipeline(JOB))

    submitted.assert_not_called()
    assert uploaded == []  # not even staged to R2: refused before upload_input
    assert failed and failed[0][1] == "UPLOAD_TOO_LONG"
    assert failed[0][2] == LinkTooLongError(max_seconds=3.0).user_message
    assert "3 seconds" in failed[0][2]
