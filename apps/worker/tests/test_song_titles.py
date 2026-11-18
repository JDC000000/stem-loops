"""P5.1 (design v1.4): song titles for NEW songs, written to ``jobs.title``.

What is pinned here:
  * the ONE yt-dlp metadata call asks for the title too (``--print title``), still downloads
    nothing, and still reads the duration the way gate 0c always has;
  * the title is cleaned before it can be stored: control and bidi-override characters,
    whitespace runs, yt-dlp's ``NA``, and length;
  * an upload's title is its file name without folders or extension;
  * the pipeline writes the title once, never over an existing one, and a failed write does
    not fail the song.

No database is used: ``_record_title``'s SQL is asserted on a fake connection.
"""

from __future__ import annotations

import asyncio
import subprocess
from unittest.mock import MagicMock

import pytest

from worker import downloader, pipeline
from worker.downloader import ytdlp_client
from worker.errors import SeparationFailedError
from worker.titles import TITLE_MAX_CHARS, clean_title, upload_title

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
JOB = "00000000-0000-4000-8000-0000000d7171"


def _run(monkeypatch: pytest.MonkeyPatch, stdout: str, rc: int = 0) -> ytdlp_client.LinkMetadata:
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    monkeypatch.setattr(
        ytdlp_client.subprocess,
        "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, rc, stdout, ""),
    )
    return ytdlp_client.probe_metadata(URL)


# ------------------------------ the yt-dlp call ------------------------------


def test_the_existing_metadata_call_now_prints_duration_then_title(monkeypatch: pytest.MonkeyPatch):
    seen: dict = {}

    def spy(cmd, **kw):
        seen["cmd"], seen["kw"] = cmd, kw
        return subprocess.CompletedProcess(cmd, 0, "212\nLucky Ticket\n", "")

    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    monkeypatch.setattr(ytdlp_client.subprocess, "run", spy)
    got = ytdlp_client.probe_metadata(URL)
    assert got == ytdlp_client.LinkMetadata(duration_sec=212.0, title="Lucky Ticket")
    cmd = seen["cmd"]
    # Exactly the two fields, duration FIRST (its parse is line 1) and title LAST.
    prints = [cmd[i + 1] for i, a in enumerate(cmd) if a == "--print"]
    assert prints == ["duration", "title"]
    assert "--simulate" in cmd  # metadata only: no media request, no bytes
    assert seen["kw"]["timeout"] == 15
    # Titles are arbitrary Unicode: decoded as UTF-8 whatever the locale, never raising.
    assert seen["kw"]["encoding"] == "utf-8"
    assert seen["kw"]["errors"] == "replace"


def test_only_one_subprocess_per_probe(monkeypatch: pytest.MonkeyPatch):
    """P5.1: 'same request, no extra proxy traffic' -- the title costs no second call."""
    run = MagicMock(return_value=subprocess.CompletedProcess([], 0, "100\nX\n", ""))
    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    monkeypatch.setattr(ytdlp_client.subprocess, "run", run)
    ytdlp_client.probe_metadata(URL)
    assert run.call_count == 1


@pytest.mark.parametrize(
    "stdout,rc,expected",
    [
        ("212\nLucky Ticket\n", 0, (212.0, "Lucky Ticket")),
        ("NA\nLucky Ticket\n", 0, (None, "Lucky Ticket")),  # unknown length, known title
        ("212\nNA\n", 0, (212.0, None)),  # yt-dlp's "field absent"
        ("212\n", 0, (212.0, None)),
        ("212\n\n", 0, (212.0, None)),
        ("", 0, (None, None)),
        ("212\nLucky Ticket\n", 1, (None, None)),  # a failed probe yields neither
        # A title with a line break spills only into its own field, never into the duration.
        ("212\nPart one\nPart two\n", 0, (212.0, "Part one Part two")),
        ("212\n  Spaced   out  \n", 0, (212.0, "Spaced out")),
    ],
)
def test_probe_metadata_parses_both_fields(
    monkeypatch: pytest.MonkeyPatch, stdout: str, rc: int, expected: tuple
):
    got = _run(monkeypatch, stdout, rc)
    assert (got.duration_sec, got.title) == expected


def test_the_title_from_the_probe_is_cleaned(monkeypatch: pytest.MonkeyPatch):
    got = _run(monkeypatch, "212\n\u202eevil\u202c Song\x1b[31m\n")
    assert got.title == "evil Song [31m"


def test_a_probe_timeout_yields_neither_field(monkeypatch: pytest.MonkeyPatch):
    def boom(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, 15)

    monkeypatch.setattr(ytdlp_client, "PROXY_URL", "")
    monkeypatch.setattr(ytdlp_client.subprocess, "run", boom)
    assert ytdlp_client.probe_metadata(URL) == ytdlp_client.UNKNOWN


# ------------------------------ download_audio hands the title out ------------------------------


@pytest.fixture
def gates(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(downloader.fetch_gates, "is_blocklisted", lambda _v: False)
    monkeypatch.setattr(downloader.fetch_gates, "fetch_paused", lambda: None)
    monkeypatch.setattr(downloader.fetch_gates, "cobalt_allowed", lambda: False)
    monkeypatch.setattr(downloader.fetch_gates, "log_attempt", lambda **kw: None)
    monkeypatch.setattr(downloader.fetch_gates, "ytdlp_version", lambda: "test")
    monkeypatch.setattr(downloader.ytdlp_client, "fetch_audio_file", lambda _u: "/tmp/a.wav")


def test_download_audio_puts_the_title_in_meta_and_keeps_its_return_shape(
    gates, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(
        downloader.ytdlp_client,
        "probe_metadata",
        lambda _u: ytdlp_client.LinkMetadata(duration_sec=120.0, title="Lucky Ticket"),
    )
    meta: dict = {}
    assert downloader.download_audio(URL, JOB, 300.0, meta=meta) == ("/tmp/a.wav", "ytdlp")
    assert meta == {"title": "Lucky Ticket"}


def test_download_audio_without_meta_still_works(gates, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        downloader.ytdlp_client,
        "probe_metadata",
        lambda _u: ytdlp_client.LinkMetadata(duration_sec=120.0, title="Lucky Ticket"),
    )
    assert downloader.download_audio(URL, JOB, 300.0) == ("/tmp/a.wav", "ytdlp")


# ------------------------------ cleaning ------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("Lucky Ticket", "Lucky Ticket"),
        ("  Lucky\tTicket\n", "Lucky Ticket"),
        ("", None),
        ("   ", None),
        ("NA", None),
        (None, None),
        (42, None),
        ("a\x00b", "a b"),  # NUL
        ("\u202eReversed\u202c", "Reversed"),  # RLO / PDF
        ("\u2066Isolated\u2069", "Isolated"),  # LRI / PDI
        ("zero\u200bwidth", "zerowidth"),
        ("\ufeffBOM", "BOM"),
        ("Cafe\u0301", "Caf\u00e9"),  # NFC
        (
            "\u5b87\u591a\u7530\u30d2\u30ab\u30eb - First Love",
            "\u5b87\u591a\u7530\u30d2\u30ab\u30eb - First Love",
        ),
        (
            "\U0001f468\u200d\U0001f469\u200d\U0001f467 family",
            "\U0001f468\u200d\U0001f469\u200d\U0001f467 family",
        ),  # ZWJ kept
        ("<script>alert(1)</script>", "<script>alert(1)</script>"),  # stored as text; React escapes
    ],
)
def test_clean_title(raw, expected):
    assert clean_title(raw) == expected


def test_clean_title_caps_the_length():
    out = clean_title("x" * 10_000)
    assert out is not None
    assert len(out) == TITLE_MAX_CHARS
    assert out.endswith("\u2026")
    # At the limit exactly, nothing is cut.
    assert clean_title("y" * TITLE_MAX_CHARS) == "y" * TITLE_MAX_CHARS


@pytest.mark.parametrize(
    "name,expected",
    [
        ("Lucky Ticket.mp3", "Lucky Ticket"),
        ("my.song.v2.wav", "my.song.v2"),
        ("C:\\Users\\me\\Music\\Song.flac", "Song"),
        ("folder/sub/Track 01.m4a", "Track 01"),
        ("no extension", "no extension"),
        (".mp3", None),
        ("", None),
        (None, None),
        ("\u202eevil.mp3", "evil"),
    ],
)
def test_upload_title_is_the_file_name_stem(name, expected):
    assert upload_title(name) == expected


# ------------------------------ the pipeline writes it ------------------------------


class _FakeConn:
    def __init__(self, sink: list, fail: bool = False):
        self.sink, self.fail = sink, fail

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        if self.fail:
            raise RuntimeError("db down")
        self.sink.append((" ".join(sql.split()), params))


def test_record_title_never_overwrites(monkeypatch: pytest.MonkeyPatch):
    sink: list = []
    monkeypatch.setattr(pipeline, "_db", lambda: _FakeConn(sink))
    pipeline._record_title(JOB, "Lucky Ticket")
    assert sink == [
        ("UPDATE jobs SET title=%s WHERE id=%s AND title IS NULL", ("Lucky Ticket", JOB))
    ]


def test_record_title_skips_an_empty_title(monkeypatch: pytest.MonkeyPatch):
    db = MagicMock(side_effect=AssertionError("no DB call for no title"))
    monkeypatch.setattr(pipeline, "_db", db)
    pipeline._record_title(JOB, None)
    pipeline._record_title(JOB, "")
    db.assert_not_called()


def test_a_failed_title_write_does_not_fail_the_song(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(pipeline, "_db", lambda: _FakeConn([], fail=True))
    pipeline._record_title(JOB, "Lucky Ticket")  # must not raise


def _rig(monkeypatch: pytest.MonkeyPatch, row: tuple, written: list):
    monkeypatch.delenv("STUB_MODE", raising=False)
    monkeypatch.setattr(pipeline, "_fetch_job", lambda _j: row)
    monkeypatch.setattr(pipeline, "_record_title", lambda j, t: written.append((j, t)))
    monkeypatch.setattr(
        pipeline,
        "submit_or_reattach",
        MagicMock(side_effect=SeparationFailedError("sentinel: reached the billed call")),
    )

    async def noop(*a, **k):
        return None

    monkeypatch.setattr(pipeline, "set_status", noop)
    monkeypatch.setattr(pipeline, "emit_event", noop)
    monkeypatch.setattr(pipeline, "_fail", noop)


def test_pipeline_writes_the_link_title_before_separation(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("ALLOW_YOUTUBE_INPUT", "true")
    written: list = []
    _rig(monkeypatch, (URL, ["drums"], 4, "youtube", None, None), written)

    def fake_download(_url, _job, cap=None, meta=None):
        assert meta is not None, "the pipeline must ask for the title"
        meta["title"] = "Lucky Ticket"
        return "https://tunnel.example/a.mp3", "cobalt"

    monkeypatch.setattr(pipeline, "download_audio", fake_download)
    with pytest.raises(SeparationFailedError, match="sentinel"):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert written == [(JOB, "Lucky Ticket")]


def test_pipeline_writes_the_upload_file_stem(monkeypatch: pytest.MonkeyPatch):
    written: list = []
    _rig(monkeypatch, (None, ["drums"], 4, "upload", "uploads/k", "Lucky Ticket.mp3"), written)
    monkeypatch.setattr(
        pipeline, "_prepare_upload_source", lambda _j, _k: ("https://presigned", None)
    )
    with pytest.raises(SeparationFailedError, match="sentinel"):
        asyncio.run(pipeline._run_pipeline(JOB))
    assert written == [(JOB, "Lucky Ticket")]
