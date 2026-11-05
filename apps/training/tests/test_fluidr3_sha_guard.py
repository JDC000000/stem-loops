"""QA-B H3 regression tests for the FluidR3 SHA-256 guard.

The previous ``_download_fluidr3`` held a 32-char hex constant (MD5-shaped,
NOT SHA-256) and only logged the computed hash — it never compared.
That silently defeated DATA-PROVENANCE.md's MIT-bytes claim if the CDN
swapped the artefact.

The new contract this file exercises:

1. Unpinned flow (``FLUIDR3_SHA256 is None``) **fails closed**: it raises
   :class:`ChecksumMismatchError` naming the computed hash, and leaves the
   downloaded artefact on disk so the operator can pin it.
2. Pinned flow with a matching hash succeeds silently.
3. Pinned flow with a mismatched hash raises
   :class:`ChecksumMismatchError` AND removes the untrusted bytes so a
   retry does not idempotently skip the re-download.
4. The constant on disk is None or a 64-char hex SHA-256 (never a 32-char
   MD5-shaped string — the shape check itself is a regression guard).
5. The CLI maps the unpinned case to exit code 4 and surfaces the computed
   sha256 in its error output, so provenance is auditable without ever
   recording unverified bytes as if they were trusted.

Contract change (PR-Y1.sec-F1, 2026-11-04)
------------------------------------------
Items 1 and 5 previously described **trust-on-first-use**: an unpinned run
logged the computed hash and *accepted* the bytes. That silently
reintroduced the H3 bug after any cache miss, so ``_download_fluidr3`` was
changed to refuse unverified bytes outright. These tests were updated to
the fail-closed contract in session 7 (2026-11-05); they had been asserting
the pre-fix behaviour and were invisible because an unrelated ImportError
stopped this package's tests from being collected at all.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from training.data import download as dlmod
from training.data.download import (
    FLUIDR3_SHA256,
    ChecksumMismatchError,
    _download_fluidr3,
    main,
)
from training.data.sources import DataSource

# ─────────────────────────────────────────────────────────────────────────────
# Fixtures — mirror test_download_sources.py's offline stream fake.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the download CLI at an isolated cache under tmp_path."""
    monkeypatch.setenv("TRAINING_DATA_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(dlmod, "_BASE_BACKOFF_SEC", 0.0)
    return tmp_path / "cache"


class _FakeStreamResponse:
    """Minimal stand-in for ``httpx.stream`` context-managed response."""

    def __init__(self, body: bytes, status_code: int = 200) -> None:
        self._body = body
        self.status_code = status_code
        self.headers: dict[str, str] = {}
        self.request = httpx.Request("GET", "https://example/mock")

    def __enter__(self) -> _FakeStreamResponse:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def iter_bytes(self, chunk_size: int) -> Any:
        for i in range(0, len(self._body), chunk_size):
            yield self._body[i : i + chunk_size]

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                f"status {self.status_code}", request=self.request, response=self  # type: ignore[arg-type]
            )


def _install_stream(monkeypatch: pytest.MonkeyPatch, body: bytes) -> None:
    def fake_stream(method: str, url: str, **kwargs: Any) -> _FakeStreamResponse:
        return _FakeStreamResponse(body)

    monkeypatch.setattr(dlmod.httpx, "stream", fake_stream)


def _fluidr3_source() -> DataSource:
    """Hand-build the synthetic DataSource used by _cmd_download for fluidr3."""
    return DataSource(
        name="fluidr3",
        license=dlmod.FLUIDR3_LICENSE,
        url=dlmod.FLUIDR3_URL,
        size_gb=0.15,
        citation="Wen, F. (2000). FluidR3_GM. MIT License.",
        retrieval_notes="Default synthetic-render soundfont.",
    )


# ─────────────────────────────────────────────────────────────────────────────
# 1. Module-level invariants.
# ─────────────────────────────────────────────────────────────────────────────


def test_fluidr3_sha256_constant_is_none_not_md5_shaped() -> None:
    """The regression bug was a 32-char constant masquerading as SHA-256.

    The pin is a 64-char hex string or ``None`` — never a 32-char
    (MD5-length) hex blob. This test fails loudly if anyone reintroduces
    the old shape before verifying the real hash.
    """
    assert FLUIDR3_SHA256 is None or (
        isinstance(FLUIDR3_SHA256, str) and len(FLUIDR3_SHA256) == 64
    ), (f"FLUIDR3_SHA256 must be None or a 64-char hex SHA-256, " f"got {FLUIDR3_SHA256!r}")


# ─────────────────────────────────────────────────────────────────────────────
# 2. First-run flow (unpinned).
# ─────────────────────────────────────────────────────────────────────────────


def test_unpinned_run_fails_closed_and_names_computed_sha(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """FLUIDR3_SHA256 is None => refuse the bytes, but name the hash to pin.

    Fail-closed per PR-Y1.sec-F1. The error must carry everything the
    operator needs to resolve it: the computed hash, the constant to set,
    and the file to set it in.
    """
    body = b"fake-fluidr3-bytes"
    expected_sha = hashlib.sha256(body).hexdigest()

    monkeypatch.setattr(dlmod, "FLUIDR3_SHA256", None)
    _install_stream(monkeypatch, body)

    with pytest.raises(ChecksumMismatchError) as exc:
        _download_fluidr3(_fluidr3_source(), full=False)

    msg = str(exc.value)
    assert expected_sha in msg, "operator cannot pin a hash the error does not print"
    assert "FLUIDR3_SHA256" in msg
    assert "download.py" in msg


def test_unpinned_run_leaves_file_on_disk_for_pinning(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Unpinned run must NOT delete the artefact — it is needed to pin the hash.

    This distinguishes the unpinned case from the pinned-MISMATCH case, which
    deliberately removes the untrusted bytes (see
    ``test_pinned_mismatched_hash_raises_checksum_mismatch``). Here the bytes
    are merely unverified, not known-bad, and deleting them would force a
    re-download on every pinning attempt.
    """
    body = b"fake-fluidr3-bytes"
    monkeypatch.setattr(dlmod, "FLUIDR3_SHA256", None)
    _install_stream(monkeypatch, body)

    with pytest.raises(ChecksumMismatchError):
        _download_fluidr3(_fluidr3_source(), full=False)

    cached = cache_dir / "fluidr3" / "FluidR3_GM.sf2"
    assert cached.exists(), "artefact was deleted; operator cannot compute the pin"
    assert cached.read_bytes() == body


# ─────────────────────────────────────────────────────────────────────────────
# 3. Pinned flow — match.
# ─────────────────────────────────────────────────────────────────────────────


def test_pinned_matching_hash_succeeds_silently(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    body = b"fake-fluidr3-bytes"
    expected_sha = hashlib.sha256(body).hexdigest()

    monkeypatch.setattr(dlmod, "FLUIDR3_SHA256", expected_sha)
    _install_stream(monkeypatch, body)

    paths = _download_fluidr3(_fluidr3_source(), full=False)
    assert paths[0].read_bytes() == body
    # No pin-instruction banner on a matching pinned run.
    assert "Pin this value" not in capsys.readouterr().err


# ─────────────────────────────────────────────────────────────────────────────
# 4. Pinned flow — mismatch.
# ─────────────────────────────────────────────────────────────────────────────


def test_pinned_mismatched_hash_raises_checksum_mismatch(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = b"cdn-swapped-bytes"
    wrong_pin = "0" * 64  # 64-char hex but definitely not the real sha

    monkeypatch.setattr(dlmod, "FLUIDR3_SHA256", wrong_pin)
    _install_stream(monkeypatch, body)

    with pytest.raises(ChecksumMismatchError) as exc:
        _download_fluidr3(_fluidr3_source(), full=False)

    err = str(exc.value)
    assert "FluidR3_GM.sf2" in err
    assert wrong_pin in err
    assert hashlib.sha256(body).hexdigest() in err


def test_pinned_mismatch_deletes_untrusted_bytes(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A mismatched download must NOT leave the bad bytes on disk.

    If it did, the file-exists short-circuit in ``_already_have`` would
    make a retry silently skip the re-download, re-arming the same bug.
    """
    body = b"cdn-swapped-bytes"
    wrong_pin = "1" * 64

    monkeypatch.setattr(dlmod, "FLUIDR3_SHA256", wrong_pin)
    _install_stream(monkeypatch, body)

    source = _fluidr3_source()
    target = cache_dir / source.name / "FluidR3_GM.sf2"

    with pytest.raises(ChecksumMismatchError):
        _download_fluidr3(source, full=False)

    assert not target.exists(), "untrusted bytes must be removed on mismatch"


# ─────────────────────────────────────────────────────────────────────────────
# 5. Manifest provenance — computed sha lands even on the unpinned run.
# ─────────────────────────────────────────────────────────────────────────────


def test_cli_unpinned_run_exits_4_and_writes_no_manifest_row(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    """End-to-end: `python -m training.data.download --source fluidr3 --confirm`
    with no pin must exit 4 and record NOTHING in MANIFEST.jsonl.

    Pre-PR-Y1.sec-F1 this wrote a provenance row for unverified bytes, which
    is precisely the wrong outcome: MANIFEST.jsonl is the DATA-PROVENANCE.md
    audit trail, and a row there asserts the bytes were checked. The computed
    sha256 still reaches the operator via the error output, so pinning is just
    as easy without faking the audit trail.
    """
    body = b"fake-fluidr3-bytes"
    expected_sha = hashlib.sha256(body).hexdigest()

    monkeypatch.setattr(dlmod, "FLUIDR3_SHA256", None)
    _install_stream(monkeypatch, body)

    rc = main(["--source", "fluidr3", "--confirm"])
    assert rc == 4, "unpinned run must map to the ChecksumMismatchError exit code"

    # The operator still gets the hash to pin.
    captured = capsys.readouterr()
    assert expected_sha in (captured.err + captured.out)

    # No provenance row for bytes we refused to trust.
    manifest = cache_dir / "MANIFEST.jsonl"
    if manifest.exists():
        assert manifest.read_text(encoding="utf-8").strip() == "", (
            "unverified bytes must not get a MANIFEST provenance row"
        )


def test_cli_pinned_mismatch_returns_exit_4(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    """The CLI maps ChecksumMismatchError → exit code 4 (shared Zenodo path)."""
    body = b"cdn-swapped-bytes"
    monkeypatch.setattr(dlmod, "FLUIDR3_SHA256", "2" * 64)
    _install_stream(monkeypatch, body)

    rc = main(["--source", "fluidr3", "--confirm"])
    assert rc == 4
    assert "checksum-mismatch" in capsys.readouterr().err
