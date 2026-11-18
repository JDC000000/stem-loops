"""QA track B, B-09: external strings that become argv, a path or a URL are allow-listed.

* yt-dlp: the URL is passed after ``--``, so it can never be parsed as an option.
* ffmpeg/ffprobe on user-supplied media: ``-protocol_whitelist file,pipe`` before ``-i``.
* Replicate output: stem names must be in ALL_STEMS; URLs (and every redirect hop) must be
  https on replicate.delivery.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from worker import pipeline
from worker.downloader import ytdlp_client
from worker.errors import InternalError, LinkUnmeasurableError, UploadInvalidError

# ---------------------------------------------------------------------------------- yt-dlp

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


class _Done:
    returncode = 0
    stdout = "False\n"
    stderr = ""


def _capture_ytdlp(monkeypatch) -> list[list[str]]:
    seen: list[list[str]] = []

    def fake_run(cmd, *a, **k):
        seen.append(list(cmd))
        r = _Done()
        if "--print" in cmd and "is_live" not in cmd:
            r.stdout = '{"duration": 100, "title": "t", "id": "dQw4w9WgXcQ"}\n'
        return r

    monkeypatch.setattr(ytdlp_client.subprocess, "run", fake_run)
    return seen


def test_ytdlp_live_probe_passes_the_url_after_double_dash(monkeypatch):
    seen = _capture_ytdlp(monkeypatch)
    ytdlp_client._reject_if_live(URL, "")
    assert seen and seen[0][-2:] == ["--", URL]


def test_ytdlp_metadata_probe_passes_the_url_after_double_dash(monkeypatch):
    seen = _capture_ytdlp(monkeypatch)
    with contextlib.suppress(Exception):  # only the argv matters here
        ytdlp_client.probe_metadata(URL, proxy="")
    assert seen and seen[0][-2:] == ["--", URL]


def test_ytdlp_every_invocation_in_the_source_ends_options_before_the_url():
    """No `cmd.append(youtube_url)` (URL straight after the options) remains."""
    src = Path(ytdlp_client.__file__).read_text()
    assert "cmd.append(youtube_url)" not in src
    assert src.count('cmd += ["--", youtube_url]') == 3


# ---------------------------------------------------------------------------------- ffmpeg


def _guard_before_input(cmd: list[str]) -> bool:
    if "-i" not in cmd or "-protocol_whitelist" not in cmd:
        return False
    w = cmd.index("-protocol_whitelist")
    return cmd[w + 1] == "file,pipe" and w < cmd.index("-i")


def test_upload_decode_restricts_ffmpeg_to_local_protocols(monkeypatch, tmp_path):
    seen: list[list[str]] = []

    def fake_run(cmd, *a, **k):
        seen.append(list(cmd))
        raise subprocess.TimeoutExpired(cmd, 1)  # stop right after the decode is attempted

    monkeypatch.setattr(pipeline, "download_object", lambda key, dest: Path(dest).write_bytes(b"x"))
    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda p: None)
    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    with pytest.raises(UploadInvalidError):
        pipeline._prepare_upload_source("job", "job/_input.mp3")
    ffmpeg = [c for c in seen if "-i" in c]
    assert ffmpeg and all(_guard_before_input(c) for c in ffmpeg), ffmpeg


def test_link_trim_restricts_ffmpeg_to_local_protocols(monkeypatch, tmp_path):
    seen: list[list[str]] = []

    def fake_run(cmd, *a, **k):
        seen.append(list(cmd))
        raise subprocess.TimeoutExpired(cmd, 1)

    monkeypatch.setattr(pipeline, "_probe_duration_sec", lambda p: None)
    monkeypatch.setattr(pipeline.subprocess, "run", fake_run)
    with pytest.raises(LinkUnmeasurableError):
        pipeline._trim_link_source("job", str(tmp_path / "in.webm"))
    assert seen and all(_guard_before_input(c) for c in seen if "-i" in c), seen


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_refuses_a_network_fetch_with_the_guard(tmp_path):
    """The flag is real, not decorative: forced into the HLS demuxer, a playlist naming an
    http segment is refused by the whitelist (no connection attempted)."""
    pl = tmp_path / "raw_input"
    pl.write_text("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/x.ts\n")
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-y", *pipeline.FFMPEG_INPUT_GUARD, "-f", "hls", "-i", str(pl)]
        + [str(tmp_path / "o.wav")],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert r.returncode != 0
    assert "not on whitelist" in r.stderr


# -------------------------------------------------------------------------- Replicate stems


class _Resp:
    def __init__(self, status=200, location=None):
        self.status_code = status
        self.is_redirect = location is not None
        self.headers = {"location": location} if location else {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def raise_for_status(self):
        pass

    def iter_bytes(self, _n):
        yield b"RIFF"


def test_unknown_stem_names_are_never_used_as_paths(monkeypatch):
    got: list[str] = []
    monkeypatch.setattr(pipeline.httpx, "stream", lambda m, url, **k: (got.append(url), _Resp())[1])
    urls = {
        "drums": "https://replicate.delivery/a/drums.wav",
        "../../etc/evil": "https://replicate.delivery/a/x.wav",
        "piano": "https://replicate.delivery/a/piano.wav",
    }
    paths = pipeline._fetch_stems(urls, [], pipeline.ALL_STEMS)
    assert set(paths) == {"drums"}
    assert all(os.path.basename(p) == "drums.wav" for p in paths.values())
    assert got == ["https://replicate.delivery/a/drums.wav"]


@pytest.mark.parametrize(
    "url",
    [
        "http://replicate.delivery/a/drums.wav",
        "https://evil.example/drums.wav",
        "https://replicate.delivery.evil.example/drums.wav",
        "https://user:pw@replicate.delivery/drums.wav",
        "file:///etc/passwd",
        "https://169.254.169.254/latest/meta-data",
        None,
    ],
)
def test_off_list_stem_urls_fail_the_job_before_any_fetch(monkeypatch, url):
    calls: list[str] = []
    monkeypatch.setattr(pipeline.httpx, "stream", lambda m, u, **k: (calls.append(u), _Resp())[1])
    with pytest.raises(InternalError, match="allow-list"):
        pipeline._fetch_stems({"drums": url}, [], pipeline.ALL_STEMS)
    assert calls == []


def test_subdomain_of_replicate_delivery_is_allowed(monkeypatch):
    monkeypatch.setattr(pipeline.httpx, "stream", lambda m, u, **k: _Resp())
    paths = pipeline._fetch_stems(
        {"bass": "https://pbxt.replicate.delivery/x/bass.wav"}, [], pipeline.ALL_STEMS
    )
    assert set(paths) == {"bass"}


def test_a_redirect_off_the_list_is_refused_and_not_followed(monkeypatch):
    calls: list[str] = []

    def stream(m, u, **k):
        calls.append(u)
        assert k.get("follow_redirects") is False, "redirects must be followed by hand"
        if u.startswith("https://replicate.delivery/"):
            return _Resp(302, "http://169.254.169.254/latest/meta-data")
        return _Resp()

    monkeypatch.setattr(pipeline.httpx, "stream", stream)
    with pytest.raises(InternalError, match="redirect off the allow-list"):
        pipeline._fetch_stems(
            {"drums": "https://replicate.delivery/a/drums.wav"}, [], pipeline.ALL_STEMS
        )
    assert calls == ["https://replicate.delivery/a/drums.wav"]


def test_a_redirect_within_the_list_is_followed(monkeypatch):
    calls: list[str] = []

    def stream(m, u, **k):
        calls.append(u)
        if u == "https://replicate.delivery/a/drums.wav":
            return _Resp(307, "https://pbxt.replicate.delivery/b/drums.wav")
        return _Resp()

    monkeypatch.setattr(pipeline.httpx, "stream", stream)
    paths = pipeline._fetch_stems(
        {"drums": "https://replicate.delivery/a/drums.wav"}, [], pipeline.ALL_STEMS
    )
    assert set(paths) == {"drums"}
    assert calls[-1] == "https://pbxt.replicate.delivery/b/drums.wav"
