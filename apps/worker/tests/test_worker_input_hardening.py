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


def _guard_before_input(cmd: list[str], *, formats: bool = False) -> bool:
    if "-i" not in cmd or "-protocol_whitelist" not in cmd:
        return False
    w = cmd.index("-protocol_whitelist")
    ok = cmd[w + 1] == "file,pipe" and w < cmd.index("-i")
    if formats:
        if "-format_whitelist" not in cmd:
            return False
        f = cmd.index("-format_whitelist")
        allowed = set(cmd[f + 1].split(","))
        ok = ok and f < cmd.index("-i") and not ({"hls", "concat", "image2", "mpegts"} & allowed)
    return ok


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
    assert ffmpeg and all(_guard_before_input(c, formats=True) for c in ffmpeg), ffmpeg


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


def test_ffprobe_duration_probe_is_restricted_too(monkeypatch, tmp_path):
    """The duration probe also opens the raw upload, so it carries the same guard (R10)."""
    junk = tmp_path / "raw_input"
    junk.write_bytes(b"not audio at all")  # soundfile refuses -> falls through to ffprobe
    seen: list[list[str]] = []

    class _P:
        returncode = 1
        stdout = ""

    monkeypatch.setattr(pipeline.shutil, "which", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(
        pipeline.subprocess, "run", lambda cmd, *a, **k: (seen.append(cmd), _P())[1]
    )
    assert pipeline._probe_duration_sec(str(junk)) is None
    assert len(seen) == 1
    cmd = seen[0]
    assert cmd[0].endswith("ffprobe") and cmd[-1] == str(junk)
    w, f = cmd.index("-protocol_whitelist"), cmd.index("-format_whitelist")
    assert cmd[w + 1] == "file,pipe" and "hls" not in cmd[f + 1].split(",")


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_upload_guard_refuses_an_hls_local_file_read(tmp_path):
    """SF-5: the protocol whitelist alone still lets the hls demuxer read a LOCAL file named
    in a playlist (shown here first, so the test proves something). The upload guard's format
    whitelist refuses the demuxer itself."""
    wav = tmp_path / "secret.wav"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=d=1"]
        + [str(wav)],
        check=True,
        timeout=30,
    )
    pl = tmp_path / "raw_input"
    pl.write_text(f"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n{wav}\n#EXT-X-ENDLIST\n")

    def run(guard):
        return subprocess.run(
            ["ffmpeg", "-hide_banner", "-y", *guard, "-f", "hls", "-i", str(pl)]
            + [str(tmp_path / "o.wav")],
            capture_output=True,
            text=True,
            timeout=30,
        )

    assert run(pipeline.FFMPEG_INPUT_GUARD).returncode == 0, "control: file-only reads it"
    assert run(pipeline.FFMPEG_UPLOAD_GUARD).returncode != 0


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_an_hls_playlist_shaped_upload_is_refused_by_the_real_decode(monkeypatch, tmp_path):
    """End to end through _prepare_upload_source with real ffmpeg: a playlist uploaded as the
    input is an invalid upload, and nothing it names is staged."""
    wav = tmp_path / "secret.wav"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=d=1"]
        + [str(wav)],
        check=True,
        timeout=30,
    )
    body = f"#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n{wav}\n#EXT-X-ENDLIST\n"
    monkeypatch.setattr(pipeline, "download_object", lambda key, dest: Path(dest).write_text(body))
    staged: list[str] = []
    monkeypatch.setattr(pipeline, "upload_input", lambda job, path: staged.append(path) or "u")
    with pytest.raises(UploadInvalidError):
        pipeline._prepare_upload_source("job", "job/_input.mp3")
    assert staged == []


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
@pytest.mark.parametrize(
    "ext", ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aiff", "mp4", "mov", "webm"]
)
def test_every_accepted_upload_type_still_decodes_under_the_upload_guard(tmp_path, ext):
    src = tmp_path / f"t.{ext}"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=d=1"]
        + [str(src)],
        check=True,
        timeout=30,
    )
    raw = tmp_path / "raw_input"  # extensionless, exactly as the pipeline stores it
    raw.write_bytes(src.read_bytes())
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *pipeline.FFMPEG_UPLOAD_GUARD]
        + ["-i", str(raw), str(tmp_path / "o.wav")],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert r.returncode == 0, r.stderr


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
        "https://evilreplicate.delivery/drums.wav",
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
