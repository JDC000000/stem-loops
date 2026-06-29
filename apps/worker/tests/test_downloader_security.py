"""Security (P2-9): injected token/cookie must never appear in logs or output.

Forces a yt-dlp failure with poisoned stderr and asserts nothing secret survives
into stderr (where structured logs are written). PRD §6.1 / §8 #6.
"""

from unittest.mock import MagicMock, patch

import pytest

from worker.downloader import ytdlp_client
from worker.errors import DownloadBlockedError
from worker.logger import redact_secrets

FAKE_TOKEN = "FAKE_TOKEN_abc123"
FAKE_COOKIE = "session_cookie=xyz"


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
