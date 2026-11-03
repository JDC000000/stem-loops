"""SL-B24 #1: the gate and the fetchers must see the SAME video id.

A crafted raw URL like `watch?%76=A&v=B` can fool naive parsers: the kill-switch /
blocklist gate reads one value for `v`, yt-dlp or Cobalt reads the other. The fix is
to rebuild a canonical `watch?v=<gate-approved-id>` URL after the gate check and send
only THAT to the fetchers.
"""

from unittest.mock import patch

import pytest

from worker.downloader import download_audio
from worker.downloader import fetch_gates


class _StubFetchGates:
    """Minimal no-op gates so download_audio reaches the fetcher call."""

    @staticmethod
    def is_blocklisted(_video_id: str) -> bool:
        return False

    @staticmethod
    def fetch_paused() -> str | None:
        return None

    @staticmethod
    def log_attempt(**_kwargs) -> None:
        return None

    @staticmethod
    def cobalt_allowed() -> bool:
        return False

    @staticmethod
    def ytdlp_version() -> str:
        return "stub"


def test_canonical_watch_url_shape():
    assert fetch_gates.canonical_watch_url("dQw4w9WgXcQ") == (
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    )


@pytest.mark.parametrize(
    "raw_url, gate_id",
    [
        # Baseline: the gate reads 'dQw4w9WgXcQ' via the normal watch?v= form.
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        # youtu.be short form.
        ("https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        # The attack: %76 decodes to 'v', so parse_qs collapses both into the 'v'
        # list and picks the FIRST one (AAAAAAAAAAA). Without the canonicalisation
        # fix, yt-dlp would receive this raw URL and could fetch BBBBBBBBBBB.
        (
            "https://www.youtube.com/watch?%76=AAAAAAAAAAA&v=BBBBBBBBBBB",
            "AAAAAAAAAAA",
        ),
        # Extra tracking params should be stripped — fetcher only sees the id.
        (
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42&feature=share",
            "dQw4w9WgXcQ",
        ),
        # /shorts/ form.
        ("https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ],
)
def test_fetcher_receives_canonical_url(monkeypatch, raw_url, gate_id):
    """Whatever the input URL shape, yt-dlp must be called with the canonical
    `watch?v=<gate-approved-id>` form — never the raw attacker-supplied text.
    """
    canonical = f"https://www.youtube.com/watch?v={gate_id}"
    seen: dict[str, str] = {}

    def fake_fetch_audio_file(url: str) -> str:
        seen["url"] = url
        return "/tmp/stub.wav"

    # Patch gates to be permissive and the ytdlp fetch to capture what it saw.
    monkeypatch.setattr("worker.downloader.fetch_gates.is_blocklisted", _StubFetchGates.is_blocklisted)
    monkeypatch.setattr("worker.downloader.fetch_gates.fetch_paused", _StubFetchGates.fetch_paused)
    monkeypatch.setattr("worker.downloader.fetch_gates.log_attempt", _StubFetchGates.log_attempt)
    monkeypatch.setattr("worker.downloader.fetch_gates.cobalt_allowed", _StubFetchGates.cobalt_allowed)
    monkeypatch.setattr("worker.downloader.fetch_gates.ytdlp_version", _StubFetchGates.ytdlp_version)
    monkeypatch.setattr(
        "worker.downloader.ytdlp_client.fetch_audio_file", fake_fetch_audio_file
    )
    monkeypatch.setattr("worker.downloader.ytdlp_client.last_session_hash", lambda: None)

    path, source = download_audio(raw_url)
    assert path == "/tmp/stub.wav"
    assert source == "ytdlp"
    assert seen["url"] == canonical, (
        f"fetcher saw {seen['url']!r} but gate approved id {gate_id!r} "
        f"(canonical = {canonical!r}); SL-B24 #1 regression."
    )
