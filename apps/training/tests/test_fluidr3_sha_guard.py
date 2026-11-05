"""QA-B H3 regression tests for the FluidR3 SHA-256 guard.

The previous ``_download_fluidr3`` held a 32-char hex constant (MD5-shaped,
NOT SHA-256) and only logged the computed hash — it never compared.
That silently defeated DATA-PROVENANCE.md's MIT-bytes claim if the CDN
swapped the artefact.

The new contract this file exercises:

1. First-run flow (``FLUIDR3_SHA256 is None``) succeeds, prints the
   computed hash to stderr, and tells the operator to pin it in source.
2. Pinned flow with a matching hash succeeds silently.
3. Pinned flow with a mismatched hash raises
   :class:`ChecksumMismatchError` AND removes the untrusted bytes so a
   retry does not idempotently skip the re-download.
4. The constant on disk is None (not a 32-char MD5-shaped string — the
   shape check itself is a regression guard).
5. MANIFEST.jsonl still records the computed sha256 in the first-run
   case so provenance stays auditable even before pinning.
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


def test_unpinned_first_run_succeeds_and_prints_pin_instructions(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    """When FLUIDR3_SHA256 is None, download succeeds and instructs operator to pin."""
    body = b"fake-fluidr3-bytes"
    expected_sha = hashlib.sha256(body).hexdigest()

    monkeypatch.setattr(dlmod, "FLUIDR3_SHA256", None)
    _install_stream(monkeypatch, body)

    paths = _download_fluidr3(_fluidr3_source(), full=False)

    assert len(paths) == 1
    assert paths[0].name == "FluidR3_GM.sf2"
    assert paths[0].read_bytes() == body

    stderr = capsys.readouterr().err
    assert expected_sha in stderr
    # The pin-instruction banner points operators at the right place.
    assert "FLUIDR3_SHA256" in stderr
    assert "download.py" in stderr


def test_unpinned_first_run_leaves_file_on_disk_for_pinning(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Unpinned run must NOT delete the artefact — Jon needs it to pin the hash."""
    body = b"fake-fluidr3-bytes"
    monkeypatch.setattr(dlmod, "FLUIDR3_SHA256", None)
    _install_stream(monkeypatch, body)

    paths = _download_fluidr3(_fluidr3_source(), full=False)
    assert paths[0].exists()


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


def test_cli_unpinned_first_run_writes_manifest_entry_with_computed_sha(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End-to-end: `python -m training.data.download --source fluidr3 --confirm`
    with no pin must still write a MANIFEST.jsonl row carrying the real sha256.
    """
    body = b"fake-fluidr3-bytes"
    expected_sha = hashlib.sha256(body).hexdigest()

    monkeypatch.setattr(dlmod, "FLUIDR3_SHA256", None)
    _install_stream(monkeypatch, body)

    rc = main(["--source", "fluidr3", "--confirm"])
    assert rc == 0

    manifest = cache_dir / "MANIFEST.jsonl"
    lines = manifest.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry["source"] == "fluidr3"
    assert entry["filename"] == "FluidR3_GM.sf2"
    assert entry["sha256"] == expected_sha
    assert entry["license"] == "MIT"


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
