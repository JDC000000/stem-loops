"""Security (P2-9): injected token/cookie must never appear in logs or output.

Forces a yt-dlp failure with poisoned stderr and asserts nothing secret survives
into stderr (where structured logs are written). PRD §6.1 / §8 #6.
"""

import json
from unittest.mock import MagicMock, patch

import pytest

from worker.downloader import ytdlp_client
from worker.errors import DownloadBlockedError
from worker.logger import log_structured, redact_secrets

FAKE_TOKEN = "FAKE_TOKEN_abc123"
FAKE_COOKIE = "session_cookie=xyz"
# Residential-proxy shape (PROXY_URL): no keyword anywhere, credentials in userinfo.
FAKE_PROXY_USER = "acctFAKEuser"
FAKE_PROXY_PASS = "FAKEpw9182_session-ab12cd34_lifetime-2m"
FAKE_PROXY_URL = f"http://{FAKE_PROXY_USER}:{FAKE_PROXY_PASS}@geo.iproyal.com:12321"


def test_stderr_scrubbed(capsys):
    poisoned = f"error: {FAKE_TOKEN} {FAKE_COOKIE} not available"
    result = MagicMock()
    result.returncode = 1
    result.stderr = poisoned
    with patch("worker.downloader.ytdlp_client.subprocess.run", return_value=result):
        with pytest.raises(DownloadBlockedError):
            ytdlp_client.fetch_audio_file("https://youtu.be/fake")
    captured = capsys.readouterr()
    assert FAKE_TOKEN not in captured.err
    assert FAKE_TOKEN not in captured.out
    assert "session_cookie=xyz" not in captured.err


def test_redact_secrets():
    out = redact_secrets(f"Bearer {FAKE_TOKEN} and Set-Cookie: {FAKE_COOKIE}")
    assert FAKE_TOKEN not in out
    assert "xyz" not in out
    assert "[REDACTED]" in out


def test_redact_proxy_url_credentials():
    """Hardening C4: PROXY_URL is a scheme://user:pass@host string with no
    secret-indicating keyword anywhere in it, so the prefix/keyword passes never
    saw it — and yt-dlp echoes the full proxy URL in stderr on a proxy auth
    failure. The account's permanent credentials must not survive into logs."""
    out = redact_secrets(f"ERROR: unable to connect to proxy {FAKE_PROXY_URL}")
    assert FAKE_PROXY_USER not in out
    assert FAKE_PROXY_PASS not in out
    assert "[REDACTED]" in out
    # The non-secret half stays readable — a redacted log is still a useful log.
    assert "geo.iproyal.com:12321" in out


def test_redact_proxy_url_survives_json_encoding():
    """log_structured JSON-encodes fields before redacting, so the pattern has to
    hold inside a quoted JSON string too (this is the real production path)."""
    poisoned = json.dumps({"stderr": f"proxy {FAKE_PROXY_URL} refused", "url": "https://ok/x"})
    out = redact_secrets(poisoned)
    assert FAKE_PROXY_PASS not in out and FAKE_PROXY_USER not in out
    assert "https://ok/x" in out  # a credential-free URL is untouched


def test_redact_proxy_url_end_to_end_through_logger(capsys):
    """The whole logging path, not just the helper."""
    log_structured("ERROR", "ytdlp_failed", stderr=f"proxy {FAKE_PROXY_URL} auth failed")
    captured = capsys.readouterr()
    assert FAKE_PROXY_PASS not in captured.err
    assert FAKE_PROXY_USER not in captured.err


def test_redaction_leaves_ordinary_urls_alone():
    """No over-masking: URLs without userinfo (every R2/Replicate URL) are intact."""
    clean = "GET https://api.replicate.com/v1/predictions/abc123 -> 200"
    assert redact_secrets(clean) == clean
