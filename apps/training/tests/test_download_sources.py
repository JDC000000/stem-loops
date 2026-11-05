"""Tests for ``training.data.download`` — PR-Y1.3c coverage.

Every test runs OFFLINE: ``httpx`` is monkey-patched per test, ``git clone``
is monkey-patched, and the Zenodo files endpoint is fed from fixture
payloads. No network, no real downloads.

Coverage for each newly wired source (billboard, aam, guitarset,
winterreise, fma) plus the shared transport:

- Dry-run exit code (rc=2 without ``--confirm``).
- SHA-256 pinning / recording in the manifest.
- Checksum-mismatch detection (aborts with ``ChecksumMismatchError``).
- Idempotency (second run with the same cache returns early).
- Resume-on-interrupt (``.part`` + ``Range`` header picks up where left off).
- AAM ``--full`` vs default sample (first 300 entries alphabetically).
- FMA ``tracks.csv`` license filter keeps only allowlisted licenses.
- Winterreise raises :class:`NotImplementedError` pointing at manual steps.
"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import httpx
import pytest

from training.data import download as dlmod
from training.data.download import (
    AAM_SAMPLE_COUNT,
    FMA_ALLOWED_LICENSES,
    ChecksumMismatchError,
    _download_aam,
    _download_billboard,
    _download_fluidr3,
    _download_fma,
    _download_guitarset,
    _download_pdmx,
    _download_winterreise,
    _fma_filter_tracks_csv,
    _stream_download,
    _verify_md5_or_abort,
    main,
)
from training.data.sources import DataSource, by_name

# ─────────────────────────────────────────────────────────────────────────────
# Fixtures.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture
def cache_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the download CLI at an isolated cache under tmp_path."""
    monkeypatch.setenv("TRAINING_DATA_CACHE_DIR", str(tmp_path / "cache"))
    # Keep retry sleeps near-zero so a 429 test doesn't actually wait.
    monkeypatch.setattr(dlmod, "_BASE_BACKOFF_SEC", 0.0)
    return tmp_path / "cache"


class _FakeStreamResponse:
    """Minimal stand-in for ``httpx.stream`` context-managed response."""

    def __init__(
        self,
        body: bytes,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._body = body
        self.status_code = status_code
        self.headers = headers or {}
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


def _install_stream(
    monkeypatch: pytest.MonkeyPatch,
    handler,  # (url, headers) -> _FakeStreamResponse
) -> list[dict[str, Any]]:
    """Install a fake ``httpx.stream`` and return a call-log list."""
    calls: list[dict[str, Any]] = []

    def fake_stream(method: str, url: str, **kwargs: Any) -> _FakeStreamResponse:
        headers = kwargs.get("headers") or {}
        calls.append({"method": method, "url": url, "headers": dict(headers)})
        return handler(url, headers)

    monkeypatch.setattr(dlmod.httpx, "stream", fake_stream)
    return calls


def _install_client_get(
    monkeypatch: pytest.MonkeyPatch,
    payload: dict,
) -> list[str]:
    """Install a fake ``httpx.Client`` whose ``get`` returns ``payload`` as JSON."""
    urls: list[str] = []

    class _FakeResp:
        status_code = 200

        def json(self) -> dict:
            return payload

        def raise_for_status(self) -> None:
            return None

    class _FakeClient:
        def __init__(self, *a: Any, **kw: Any) -> None:
            pass

        def __enter__(self) -> _FakeClient:
            return self

        def __exit__(self, *exc: object) -> None:
            return None

        def get(self, url: str) -> _FakeResp:
            urls.append(url)
            return _FakeResp()

    monkeypatch.setattr(dlmod.httpx, "Client", _FakeClient)
    return urls


# ─────────────────────────────────────────────────────────────────────────────
# CLI — dry-run and smoke.
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "source_name",
    ["billboard", "aam", "guitarset", "winterreise", "fma"],
)
def test_cli_dry_run_exits_2_without_confirm(
    source_name: str, cache_dir: Path, capsys: pytest.CaptureFixture
) -> None:
    with pytest.raises(SystemExit) as exc:
        main(["--source", source_name])
    assert exc.value.code == 2
    assert "Refusing to download without --confirm" in capsys.readouterr().err


def test_cli_list_includes_all_wired_sources(
    cache_dir: Path, capsys: pytest.CaptureFixture
) -> None:
    rc = main(["--list"])
    out = capsys.readouterr().out
    assert rc == 0
    for name in ("billboard", "aam", "guitarset", "winterreise", "fma", "fluidr3"):
        assert name in out


# ─────────────────────────────────────────────────────────────────────────────
# _stream_download: resume, retry, 404, 416.
# ─────────────────────────────────────────────────────────────────────────────


def test_stream_download_resume_sends_range_header(
    cache_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A pre-existing .part file makes the next attempt send Range: bytes=N-."""
    target = tmp_path / "artifact.zip"
    partial = target.with_suffix(target.suffix + ".part")
    partial.write_bytes(b"ABCDE")  # 5 bytes already there

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        # Server returns only the remaining bytes.
        return _FakeStreamResponse(b"FGHIJ")

    calls = _install_stream(monkeypatch, handler)
    _stream_download("https://example/artifact.zip", target)
    assert target.read_bytes() == b"ABCDEFGHIJ"
    # The one call sent Range: bytes=5-
    assert calls[0]["headers"].get("Range") == "bytes=5-"


def test_stream_download_416_restarts_cleanly(
    cache_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A 416 (range not satisfiable) clears the .part and starts over."""
    target = tmp_path / "artifact.bin"
    partial = target.with_suffix(target.suffix + ".part")
    partial.write_bytes(b"stale-stale")

    state = {"first": True}

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        if state["first"]:
            state["first"] = False
            return _FakeStreamResponse(b"", status_code=416)
        return _FakeStreamResponse(b"FRESH")

    _install_stream(monkeypatch, handler)
    _stream_download("https://example/artifact.bin", target)
    assert target.read_bytes() == b"FRESH"


def test_stream_download_429_backs_off_then_succeeds(
    cache_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """429 triggers backoff and retries up to _MAX_RETRIES times."""
    target = tmp_path / "x.bin"

    seq = iter([429, 200])

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        code = next(seq)
        if code == 200:
            return _FakeStreamResponse(b"OK")
        return _FakeStreamResponse(b"", status_code=429)

    _install_stream(monkeypatch, handler)
    _stream_download("https://example/x.bin", target)
    assert target.read_bytes() == b"OK"


def test_stream_download_404_raises(
    cache_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "missing.bin"

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        return _FakeStreamResponse(b"", status_code=404)

    _install_stream(monkeypatch, handler)
    with pytest.raises(httpx.HTTPStatusError):
        _stream_download("https://example/missing.bin", target)


def test_stream_download_connection_error_retries_then_raises(
    cache_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Three consecutive connection errors abort with the last exception."""
    target = tmp_path / "x.bin"

    def fake_stream(method: str, url: str, **kw: Any) -> _FakeStreamResponse:
        raise httpx.ConnectError("boom", request=httpx.Request(method, url))

    monkeypatch.setattr(dlmod.httpx, "stream", fake_stream)
    with pytest.raises(httpx.ConnectError):
        _stream_download("https://example/x.bin", target)


# ─────────────────────────────────────────────────────────────────────────────
# Checksum verification.
# ─────────────────────────────────────────────────────────────────────────────


def test_verify_md5_or_abort_passes(tmp_path: Path) -> None:
    p = tmp_path / "ok.bin"
    p.write_bytes(b"hello")
    # md5("hello") = 5d41402abc4b2a76b9719d911017c592
    _verify_md5_or_abort(p, "md5:5d41402abc4b2a76b9719d911017c592")


def test_verify_md5_or_abort_raises_on_mismatch(tmp_path: Path) -> None:
    p = tmp_path / "bad.bin"
    p.write_bytes(b"hello")
    with pytest.raises(ChecksumMismatchError) as exc:
        _verify_md5_or_abort(p, "md5:deadbeef" + "0" * 24)
    assert "mismatch" in str(exc.value)


# ─────────────────────────────────────────────────────────────────────────────
# PDMX (regression — already wired in PR-Y1.3, but exercises the retry path).
# ─────────────────────────────────────────────────────────────────────────────


def test_pdmx_streams_only_no_license_conflict(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = {
        "entries": [
            {
                "key": "pdmx_full.tar.gz",
                "links": {"self": "https://zenodo/pdmx_full.tar.gz"},
                "checksum": "md5:11111111111111111111111111111111",
            },
            {
                "key": "pdmx_no_license_conflict.tar.gz",
                "links": {"self": "https://zenodo/pdmx_nlc.tar.gz"},
                # md5("NLC-OK") happens to be:
                "checksum": "md5:" + __import__("hashlib").md5(b"NLC-OK").hexdigest(),
            },
        ]
    }
    _install_client_get(monkeypatch, payload)

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        assert "pdmx_nlc" in url, f"should only download no_license_conflict, got {url}"
        return _FakeStreamResponse(b"NLC-OK")

    _install_stream(monkeypatch, handler)
    source = by_name("pdmx")
    paths = _download_pdmx(source, full=False)
    assert len(paths) == 1
    assert paths[0].name == "pdmx_no_license_conflict.tar.gz"


# ─────────────────────────────────────────────────────────────────────────────
# Billboard (ChoCo clone).
# ─────────────────────────────────────────────────────────────────────────────


def _fake_git_clone(partition_relpath: str):
    """Return a fake ``subprocess.run`` that materialises a ChoCo layout."""

    def _run(cmd: list[str], check: bool = False, **kw: Any) -> MagicMock:
        # cmd ends with the clone destination path.
        dest = Path(cmd[-1])
        part = dest / partition_relpath
        part.mkdir(parents=True, exist_ok=True)
        (part / "0001.jams").write_text('{"onset": 0.0}', encoding="utf-8")
        (part / "0002.jams").write_text('{"onset": 1.0}', encoding="utf-8")
        return MagicMock(returncode=0)

    return _run


def test_billboard_shallow_clones_choco_and_returns_jams(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(dlmod.shutil, "which", lambda _b: "/usr/bin/git")
    monkeypatch.setattr(dlmod.subprocess, "run", _fake_git_clone("partitions/billboard"))
    source = by_name("billboard")
    paths = _download_billboard(source, full=False)
    assert len(paths) == 2
    assert all(p.name.endswith(".jams") for p in paths)


def test_billboard_idempotent_when_clone_already_present(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Second call must not re-invoke git."""
    monkeypatch.setattr(dlmod.shutil, "which", lambda _b: "/usr/bin/git")
    call_count = {"n": 0}

    def _run(cmd: list[str], check: bool = False, **kw: Any) -> MagicMock:
        call_count["n"] += 1
        return _fake_git_clone("partitions/billboard")(cmd, check=check, **kw)

    monkeypatch.setattr(dlmod.subprocess, "run", _run)
    source = by_name("billboard")
    _download_billboard(source, full=False)
    assert call_count["n"] == 1
    _download_billboard(source, full=False)  # second call = no new clone
    assert call_count["n"] == 1


def test_billboard_raises_when_partition_missing(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the ChoCo layout changes, we fail loudly rather than silently empty."""
    monkeypatch.setattr(dlmod.shutil, "which", lambda _b: "/usr/bin/git")

    def _bad_clone(cmd: list[str], check: bool = False, **kw: Any) -> MagicMock:
        dest = Path(cmd[-1])
        dest.mkdir(parents=True, exist_ok=True)
        # No partition dir created.
        return MagicMock(returncode=0)

    monkeypatch.setattr(dlmod.subprocess, "run", _bad_clone)
    source = by_name("billboard")
    with pytest.raises(RuntimeError, match="Billboard partition"):
        _download_billboard(source, full=False)


# ─────────────────────────────────────────────────────────────────────────────
# AAM (Zenodo sample vs full).
# ─────────────────────────────────────────────────────────────────────────────


def _aam_payload(n_entries: int) -> dict:
    """Synthesise an AAM Zenodo file listing with n entries, alphabetical."""
    import hashlib

    entries = []
    for i in range(n_entries):
        body = f"track-{i:05d}".encode()
        md5 = hashlib.md5(body).hexdigest()
        entries.append(
            {
                "key": f"track-{i:05d}.zip",
                "links": {"self": f"https://zenodo/aam/track-{i:05d}.zip"},
                "checksum": f"md5:{md5}",
            }
        )
    return {"entries": entries}


def test_aam_default_samples_first_300_alphabetically(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = _aam_payload(500)  # more than 300
    _install_client_get(monkeypatch, payload)

    seen: list[str] = []

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        seen.append(url)
        # Return bytes matching the key in the url so md5 verification passes.
        key = url.rsplit("/", 1)[-1]
        body = key.removesuffix(".zip").encode()
        return _FakeStreamResponse(body)

    _install_stream(monkeypatch, handler)
    source = by_name("aam")
    paths = _download_aam(source, full=False)
    assert len(paths) == AAM_SAMPLE_COUNT == 300
    # Alphabetical: first file is track-00000.zip, last is track-00299.zip
    assert paths[0].name == "track-00000.zip"
    assert paths[-1].name == "track-00299.zip"


def test_aam_full_takes_everything(cache_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    payload = _aam_payload(5)
    _install_client_get(monkeypatch, payload)

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        key = url.rsplit("/", 1)[-1]
        body = key.removesuffix(".zip").encode()
        return _FakeStreamResponse(body)

    _install_stream(monkeypatch, handler)
    source = by_name("aam")
    paths = _download_aam(source, full=True)
    assert len(paths) == 5


def test_aam_idempotency_skips_existing(cache_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A second call with the same cache does not re-stream existing files."""
    payload = _aam_payload(3)
    _install_client_get(monkeypatch, payload)

    download_count = {"n": 0}

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        download_count["n"] += 1
        key = url.rsplit("/", 1)[-1]
        body = key.removesuffix(".zip").encode()
        return _FakeStreamResponse(body)

    _install_stream(monkeypatch, handler)
    source = by_name("aam")
    _download_aam(source, full=True)
    assert download_count["n"] == 3
    _download_aam(source, full=True)
    assert download_count["n"] == 3  # no new downloads


def test_aam_checksum_mismatch_aborts(cache_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    payload = {
        "entries": [
            {
                "key": "track-00000.zip",
                "links": {"self": "https://zenodo/aam/track-00000.zip"},
                "checksum": "md5:deadbeef" + "0" * 24,  # intentionally wrong
            }
        ]
    }
    _install_client_get(monkeypatch, payload)

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        return _FakeStreamResponse(b"some-bytes")

    _install_stream(monkeypatch, handler)
    source = by_name("aam")
    with pytest.raises(ChecksumMismatchError):
        _download_aam(source, full=True)


# ─────────────────────────────────────────────────────────────────────────────
# GuitarSet (full Zenodo).
# ─────────────────────────────────────────────────────────────────────────────


def test_guitarset_downloads_every_zenodo_entry(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hashlib

    body1 = b"guitarset-annotations"
    body2 = b"guitarset-audio-mono"
    payload = {
        "entries": [
            {
                "key": "annotation.zip",
                "links": {"self": "https://zenodo/guitarset/annotation.zip"},
                "checksum": "md5:" + hashlib.md5(body1).hexdigest(),
            },
            {
                "key": "audio_mono-mic.zip",
                "links": {"self": "https://zenodo/guitarset/audio_mono-mic.zip"},
                "checksum": "md5:" + hashlib.md5(body2).hexdigest(),
            },
        ]
    }
    _install_client_get(monkeypatch, payload)
    bodies = {"annotation.zip": body1, "audio_mono-mic.zip": body2}

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        key = url.rsplit("/", 1)[-1]
        return _FakeStreamResponse(bodies[key])

    _install_stream(monkeypatch, handler)
    source = by_name("guitarset")
    paths = _download_guitarset(source, full=False)
    assert {p.name for p in paths} == {"annotation.zip", "audio_mono-mic.zip"}


# ─────────────────────────────────────────────────────────────────────────────
# Winterreise — NotImplemented is the contract, with manual pointer.
# ─────────────────────────────────────────────────────────────────────────────


def test_winterreise_raises_notimplemented_with_manual_pointer(
    cache_dir: Path,
) -> None:
    source = by_name("winterreise")
    with pytest.raises(NotImplementedError) as exc:
        _download_winterreise(source, full=False)
    assert "DATA-PROVENANCE.md" in str(exc.value)


def test_cli_winterreise_exits_3(cache_dir: Path, capsys: pytest.CaptureFixture) -> None:
    rc = main(["--source", "winterreise", "--confirm"])
    assert rc == 3
    assert "not-yet-implemented" in capsys.readouterr().err


# ─────────────────────────────────────────────────────────────────────────────
# FMA — tracks.csv license filter.
# ─────────────────────────────────────────────────────────────────────────────


def _fake_fma_metadata_zip() -> bytes:
    """Build an in-memory fma_metadata.zip containing a mini tracks.csv."""
    tracks_csv = (
        # Row 0: group headers. Column 0 is the (unnamed) track_id index.
        ",track,track,album,artist\n"
        # Row 1: sub-field within group.
        ",license,title,title,name\n"
        # Row 2: subtype.
        ",nominal,nominal,nominal,nominal\n"
        # Data rows — 2 CC-BY-4.0 (keep), 1 CC-BY-NC (drop), 1 CC0 (keep), 1 CC-BY-SA (keep).
        "1,Attribution 4.0 International (CC BY 4.0),Alpha,A,ArtA\n"
        "2,Attribution-NonCommercial 4.0 International (CC BY-NC 4.0),Beta,B,ArtB\n"
        "3,Creative Commons 0,Gamma,C,ArtC\n"
        "4,Attribution-ShareAlike 4.0 International (CC BY-SA 4.0),Delta,D,ArtD\n"
        "5,Attribution 4.0 International (CC BY 4.0),Epsilon,E,ArtE\n"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("fma_metadata/tracks.csv", tracks_csv)
    return buf.getvalue()


def test_fma_filter_tracks_csv_keeps_only_allowlisted() -> None:
    zip_bytes = _fake_fma_metadata_zip()
    with zipfile.ZipFile(io.BytesIO(zip_bytes), "r") as zf:
        tracks_csv = zf.read("fma_metadata/tracks.csv")
    retained = _fma_filter_tracks_csv(tracks_csv)
    # IDs 1, 3, 4, 5 (CC-BY, CC0, CC-BY-SA, CC-BY). ID 2 (NC) dropped.
    assert [tid for tid, _ in retained] == ["1", "3", "4", "5"]
    # Every retained license is in the allowlist.
    for _, lic in retained:
        assert lic in FMA_ALLOWED_LICENSES


def test_fma_download_writes_retained_tracks_csv(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    metadata_bytes = _fake_fma_metadata_zip()
    small_bytes = b"fma-small-audio-zip"

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        if "metadata" in url:
            return _FakeStreamResponse(metadata_bytes)
        if "small" in url:
            return _FakeStreamResponse(small_bytes)
        raise AssertionError(f"unexpected url: {url}")

    _install_stream(monkeypatch, handler)
    source = by_name("fma")
    paths = _download_fma(source, full=False)

    names = {p.name for p in paths}
    assert "fma_metadata.zip" in names
    assert "fma_retained_tracks.csv" in names
    assert "fma_small.zip" in names

    roster = cache_dir / "fma" / "fma_retained_tracks.csv"
    text = roster.read_text(encoding="utf-8")
    assert "track_id,license" in text.splitlines()[0]
    # 4 data rows kept (ids 1, 3, 4, 5).
    assert len(text.splitlines()) == 1 + 4


def test_fma_full_downloads_medium_not_small(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    metadata_bytes = _fake_fma_metadata_zip()
    seen: list[str] = []

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        seen.append(url)
        if "metadata" in url:
            return _FakeStreamResponse(metadata_bytes)
        return _FakeStreamResponse(b"audio-zip-body")

    _install_stream(monkeypatch, handler)
    source = by_name("fma")
    _download_fma(source, full=True)
    assert any("fma_medium.zip" in u for u in seen)
    assert not any("fma_small.zip" in u for u in seen)


def test_fma_idempotent_skips_existing_archives(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Second run with cached metadata + small zip must not re-download them."""
    metadata_bytes = _fake_fma_metadata_zip()
    download_count = {"n": 0}

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        download_count["n"] += 1
        if "metadata" in url:
            return _FakeStreamResponse(metadata_bytes)
        return _FakeStreamResponse(b"audio-zip-body")

    _install_stream(monkeypatch, handler)
    source = by_name("fma")
    _download_fma(source, full=False)
    first_n = download_count["n"]
    assert first_n == 2  # metadata + small
    _download_fma(source, full=False)
    assert download_count["n"] == first_n  # no new network calls


# ─────────────────────────────────────────────────────────────────────────────
# End-to-end CLI — download → manifest.
# ─────────────────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────────────────
# FluidR3 (QA-B H3): the SHA guard fires on mismatch.
# Deeper coverage of the unpinned/pinned/mismatch matrix lives in
# ``test_fluidr3_sha_guard.py``; this test is the single-row contract check
# that belongs beside the other checksum-mismatch assertions.
# ─────────────────────────────────────────────────────────────────────────────


def test_fluidr3_checksum_mismatch_aborts(cache_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    body = b"cdn-replaced-bytes"
    monkeypatch.setattr(dlmod, "FLUIDR3_SHA256", "f" * 64)  # 64-char hex that won't match

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        return _FakeStreamResponse(body)

    _install_stream(monkeypatch, handler)

    source = DataSource(
        name="fluidr3",
        license=dlmod.FLUIDR3_LICENSE,
        url=dlmod.FLUIDR3_URL,
        size_gb=0.15,
        citation="Wen, F. (2000). FluidR3_GM. MIT License.",
        retrieval_notes="",
    )
    with pytest.raises(ChecksumMismatchError, match="FluidR3_GM.sf2"):
        _download_fluidr3(source, full=False)


def test_cli_guitarset_appends_manifest_with_sha256(
    cache_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import hashlib

    body = b"guitarset-annotations"
    payload = {
        "entries": [
            {
                "key": "annotation.zip",
                "links": {"self": "https://zenodo/guitarset/annotation.zip"},
                "checksum": "md5:" + hashlib.md5(body).hexdigest(),
            }
        ]
    }
    _install_client_get(monkeypatch, payload)

    def handler(url: str, headers: dict[str, str]) -> _FakeStreamResponse:
        return _FakeStreamResponse(body)

    _install_stream(monkeypatch, handler)
    rc = main(["--source", "guitarset", "--confirm"])
    assert rc == 0

    manifest = cache_dir / "MANIFEST.jsonl"
    lines = manifest.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry["source"] == "guitarset"
    assert entry["filename"] == "annotation.zip"
    assert entry["sha256"] == hashlib.sha256(body).hexdigest()
    assert entry["license"] == "CC-BY-4.0"
    assert entry["src_url"].startswith("https://zenodo.org/")
