"""Security audit §3 M5 + M6 regression tests for worker.chord_providers.klangio.

M5 — exception messages must NOT contain upstream response bodies verbatim.
    The pre-fix code raised ChordProviderError with ``{resp.text[:200]!r}``
    which leaked whatever Klangio echoed (auth hints, filenames, user-supplied
    metadata) into stdout/Sentry. Post-fix: we emit a sha256 prefix + byte
    count only.

M6 — KLANGIO_API_BASE must be https:// at module import time. The provider
    sends the API key on every call; an http:// base would leak the token
    in clear on the wire.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
from unittest.mock import MagicMock, patch

import httpx
import pytest


@pytest.fixture(autouse=True)
def _no_throttle(monkeypatch: pytest.MonkeyPatch) -> None:
    from worker.chord_providers import klangio as kg

    monkeypatch.setattr(kg, "MIN_REQUEST_INTERVAL_SEC", 0.0)


def _mock_response(
    *,
    status_code: int = 200,
    json_body: dict | list | None = None,
    text: str | None = None,
) -> MagicMock:
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.headers = {}
    resp.text = (
        text if text is not None else (json.dumps(json_body) if json_body is not None else "")
    )
    resp.json = MagicMock(
        return_value=json_body if json_body is not None else {},
        side_effect=None if json_body is not None else ValueError("not json"),
    )
    return resp


# ────────────────────────── M5: no body leakage ──────────────────────────


def test_m5_4xx_other_message_does_not_inline_upstream_body() -> None:
    """A non-402/429 4xx raise must contain a byte-count + sha256, not the body."""
    from worker.chord_providers import klangio as kg

    secret_body = (
        '{"error": "Invalid Authorization header: Bearer sk_live_ABCDEF12345",'
        ' "password_hint": "hunter2", "token": "sk_test_SECRETVALUE"}'
    )
    client = MagicMock(spec=httpx.Client)
    client.request.return_value = _mock_response(status_code=403, text=secret_body)

    with pytest.raises(kg.ChordProviderError) as excinfo:
        kg._request_with_retry(client, method="GET", url="/job/leaky")
    msg = str(excinfo.value)
    # The redacted shape is present …
    assert "body_bytes=" in msg
    assert re.search(r"body_sha256=[0-9a-f]{12}\b", msg)
    # … and none of the sensitive substrings leaked into the message.
    for leak in (
        "Bearer sk_live_",
        "password_hint",
        "hunter2",
        "sk_test_SECRETVALUE",
        "Invalid Authorization",
    ):
        assert leak not in msg, f"redaction regression: {leak!r} appeared in {msg!r}"


def test_m5_body_fingerprint_is_stable_sha256_prefix() -> None:
    """The fingerprint is a prefix of the real sha256 — cross-log correlation works."""
    from worker.chord_providers import klangio as kg

    body = "hello klangio"
    expected = hashlib.sha256(body.encode("utf-8")).hexdigest()[:12]
    msg = kg._body_fingerprint(body)
    assert f"body_sha256={expected}" in msg
    assert f"body_bytes={len(body.encode('utf-8'))}" in msg


def test_m5_not_json_message_does_not_inline_upstream_body() -> None:
    """ChordProviderError raised by _parse_json also redacts."""
    from worker.chord_providers import klangio as kg

    secret_body = "<html><body>API key sk_live_LEAK rejected by WAF</body></html>"
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = 502
    resp.text = secret_body
    resp.json = MagicMock(side_effect=ValueError("bad json"))
    with pytest.raises(kg.ChordProviderError) as excinfo:
        kg._parse_json(resp)
    msg = str(excinfo.value)
    assert "body_bytes=" in msg
    assert "sk_live_LEAK" not in msg
    assert "<html>" not in msg


def test_m5_terminal_job_message_omits_body() -> None:
    """``_poll_until_complete`` on a failed job emits status only — no body."""
    from worker.chord_providers import klangio as kg

    secret_hint = {"status": "failed", "error_detail": "API KEY sk_live_LEAK was rejected"}

    client = MagicMock(spec=httpx.Client)
    # First poll already terminal: no retry, straight to error.
    with patch.object(
        kg, "_request_with_retry", return_value=_mock_response(json_body=secret_hint)
    ):
        src = kg.KlangioChordSource()
        with pytest.raises(kg.ChordProviderError) as excinfo:
            src._poll_until_complete(client, "job-leaky")  # noqa: SLF001
    msg = str(excinfo.value)
    assert "sk_live_LEAK" not in msg
    assert "error_detail" not in msg
    # Status + job id survive so operators can still diagnose.
    assert "job-leaky" in msg
    assert "failed" in msg


# ────────────────────────── M6: https-only at import ──────────────────────────
#
# #462: these tests used to ``importlib.reload`` the shared ``worker.chord_providers.klangio``.
# A reload rebinds every class in it (ChordProviderError, KlangioChordSource, ...) and its
# process-wide state (the K-2 breaker, the throttle lock), so any module that had imported the
# old objects -- test_chord_source.py imports them at collection -- then failed 8 isinstance /
# pytest.raises checks when it ran later in the same process. Instead, execute the module
# source as a private throwaway copy: the import-time check still runs for real, and the
# shared module object is never touched.


def _import_klangio_copy():
    """Run klangio.py's module code under a private name; return the fresh module.

    The copy shares the ``worker.chord_providers`` package (so its relative imports resolve)
    but is removed from ``sys.modules`` afterwards; ``worker.chord_providers.klangio`` stays
    the same object before and after."""

    import sys

    from worker.chord_providers import klangio as shared

    name = "worker.chord_providers._klangio_m6_probe"
    spec = importlib.util.spec_from_file_location(name, shared.__file__)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod  # dataclasses resolve string annotations via sys.modules
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.modules.pop(name, None)
    assert sys.modules["worker.chord_providers.klangio"] is shared
    return mod


def test_m6_module_import_rejects_http_base(monkeypatch: pytest.MonkeyPatch) -> None:
    """Setting KLANGIO_API_BASE to an http:// URL must raise at module load."""
    monkeypatch.setenv("KLANGIO_API_BASE", "http://insecure.example.com")
    with pytest.raises(ValueError, match="must use https"):
        _import_klangio_copy()


def test_m6_module_import_rejects_empty_scheme(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KLANGIO_API_BASE", "//schemaless.example.com")
    with pytest.raises(ValueError, match="must use https"):
        _import_klangio_copy()


def test_m6_module_import_accepts_https_base(monkeypatch: pytest.MonkeyPatch) -> None:
    """https:// is explicitly allowed; the module loads cleanly."""
    monkeypatch.setenv("KLANGIO_API_BASE", "https://api.klang.io")
    mod = _import_klangio_copy()
    assert mod.API_BASE == "https://api.klang.io"


def test_m6_module_import_strips_trailing_slash(monkeypatch: pytest.MonkeyPatch) -> None:
    """Trailing slashes are stripped after the scheme check."""
    monkeypatch.setenv("KLANGIO_API_BASE", "https://api.klang.io/")
    mod = _import_klangio_copy()
    assert mod.API_BASE == "https://api.klang.io"


def test_m6_probe_leaves_the_shared_module_and_its_classes_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """#462 regression: probing the import-time check must not rebind the shared module's
    classes or reset its breaker object (other test modules hold references to them)."""
    from worker.chord_providers import klangio as kg

    before = (kg.ChordProviderError, kg.KlangioChordSource, kg._BREAKER, kg.API_BASE)
    monkeypatch.setenv("KLANGIO_API_BASE", "https://api.klang.io/")
    copy = _import_klangio_copy()
    assert copy.KlangioChordSource is not kg.KlangioChordSource  # it really was a fresh exec
    assert (kg.ChordProviderError, kg.KlangioChordSource, kg._BREAKER, kg.API_BASE) == before
