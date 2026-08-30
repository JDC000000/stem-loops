"""cobalt_client contract tests.

The module header promises every failure leaves as a typed Download*Error. The
caller in downloader/__init__.py currently hides breaches behind a blanket
`except Exception` -> yt-dlp fallback, so a regression here is invisible in
production until the day that fallback is removed or made selective. These tests
pin the contract directly.
"""

import httpx
import pytest

from worker.downloader import cobalt_client
from worker.errors import (
    DownloadAgeRestrictedError,
    DownloadBlockedError,
    DownloadInvalidUrlError,
    DownloadPrivateError,
    StemLoopsError,
)

URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


class _Resp:
    def __init__(self, payload, *, raw=None, content_type="application/json"):
        self._payload, self._raw = payload, raw
        self.headers = {"content-type": content_type}

    def raise_for_status(self):
        return None

    def json(self):
        if self._raw is not None:
            raise ValueError(f"Expecting value: {self._raw!r}")
        return self._payload


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Never let a test touch the real tunnel."""
    monkeypatch.setattr(cobalt_client, "_verify_stream", lambda url: None)


def _post(monkeypatch, resp):
    monkeypatch.setattr(cobalt_client.httpx, "post", lambda *a, **k: resp)


# --- malformed 200s must not escape as JSONDecodeError / AttributeError / TypeError ---

@pytest.mark.parametrize(
    "resp",
    [
        _Resp(None, raw="<html>fly edge error</html>", content_type="text/html"),
        _Resp(None, raw=""),                      # empty body
        _Resp(None),                              # literal JSON null
        _Resp([1, 2, 3]),                         # array, not object
        _Resp("a string"),                        # bare JSON string
    ],
    ids=["html", "empty", "null", "array", "string"],
)
def test_malformed_body_raises_typed_error(monkeypatch, resp):
    _post(monkeypatch, resp)
    with pytest.raises(StemLoopsError):
        cobalt_client.fetch_audio_url(URL)


def test_success_status_without_url_is_typed(monkeypatch):
    _post(monkeypatch, _Resp({"status": "tunnel"}))
    with pytest.raises(DownloadBlockedError):
        cobalt_client.fetch_audio_url(URL)


def test_picker_with_junk_entries_does_not_crash(monkeypatch):
    _post(monkeypatch, _Resp({"status": "picker", "picker": [None, "x", {}, {"url": "https://ok/a"}]}))
    assert cobalt_client.fetch_audio_url(URL) == "https://ok/a"


def test_non_string_url_is_rejected(monkeypatch):
    _post(monkeypatch, _Resp({"status": "tunnel", "url": 12345}))
    with pytest.raises(DownloadBlockedError):
        cobalt_client.fetch_audio_url(URL)


def test_non_string_error_text_does_not_crash(monkeypatch):
    _post(monkeypatch, _Resp({"status": "error", "text": {"nested": "object"}}))
    with pytest.raises(DownloadBlockedError):
        cobalt_client.fetch_audio_url(URL)


# --- v10 error.code -> taxonomy mapping ---

@pytest.mark.parametrize(
    "code,exc",
    [
        ("error.api.content.video.age", DownloadAgeRestrictedError),
        ("error.api.youtube.login", DownloadAgeRestrictedError),
        ("error.api.content.video.private", DownloadPrivateError),
        ("error.api.content.video.unavailable", DownloadBlockedError),
        ("error.api.link.invalid", DownloadInvalidUrlError),
        ("error.api.fetch.fail", DownloadBlockedError),
    ],
)
def test_v10_error_codes_map_to_taxonomy(monkeypatch, code, exc):
    _post(monkeypatch, _Resp({"status": "error", "error": {"code": code}}))
    with pytest.raises(exc):
        cobalt_client.fetch_audio_url(URL)


# --- transport failures stay typed (incl. the not-deployed / DNS case) ---

@pytest.mark.parametrize(
    "err", [httpx.ConnectError("dns"), httpx.ReadError("reset"), httpx.InvalidURL("bad")]
)
def test_transport_errors_stay_typed(monkeypatch, err):
    def boom(*a, **k):
        raise err

    monkeypatch.setattr(cobalt_client.httpx, "post", boom)
    with pytest.raises(StemLoopsError):
        cobalt_client.fetch_audio_url(URL)


def test_success_returns_url(monkeypatch):
    _post(monkeypatch, _Resp({"status": "tunnel", "url": "https://ok/audio.wav"}))
    assert cobalt_client.fetch_audio_url(URL) == "https://ok/audio.wav"
