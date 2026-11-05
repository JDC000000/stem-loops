"""CLI: fetch training corpora with SHA-256 manifest + resume support.

Usage::

    python -m training.data.download --list
    python -m training.data.download --source guitarset --confirm
    python -m training.data.download --source aam --confirm            # 10% sample
    python -m training.data.download --source aam --confirm --full     # all 209 GB
    python -m training.data.download --source billboard --confirm
    python -m training.data.download --source fma --confirm            # fma_small
    python -m training.data.download --source fma --confirm --full     # fma_medium

Design rules (per PR-Y1.2, extended in PR-Y1.3 and PR-Y1.3c):

- **Dry by default.** Nothing is downloaded without ``--confirm``.
- **Resume-on-interrupt.** Partial files are kept at ``<path>.part`` and
  continued with an HTTP ``Range`` request.
- **Idempotent.** A file already present whose SHA-256 matches the recorded
  manifest entry is skipped. A mismatched hash is re-downloaded.
- **Robust transport.** 429 responses back off exponentially; transient
  connection errors retry up to three times before aborting.
- **Provenance.** Every successful download appends a line to
  ``cache/MANIFEST.jsonl`` recording source slug, filename, sha256, license,
  download timestamp (UTC, ISO-8601), and the source URL. This is the audit
  trail cited in ``DATA-PROVENANCE.md``.

PR-Y1.3 wired three live sources — PDMX (Zenodo), OpenEWLD (git clone), and
the FluidR3 soundfont (direct HTTP). PR-Y1.3c (this module as it now stands)
wires five more:

- **billboard**: ChoCo partition (``github.com/smashub/choco``) — CC-BY-4.0
  re-packaged McGill Billboard labels, used until J. A. Burgoyne confirms a
  canonical UvA distribution (see
  ``claude/correspondence/burgoyne-mcgill-billboard-outreach.md``).
- **aam**: Zenodo record 5794629 (CC-BY-4.0). Default = first 300 track
  entries alphabetically (~10%, ~21 GB); ``--full`` = all 209 GB.
- **guitarset**: Zenodo record 3371780 (CC-BY-4.0, ~2.5 GB, full).
- **winterreise**: Kept as :class:`NotImplementedError` — the AudioLabs
  Erlangen distribution has no clean programmatic endpoint. See
  ``DATA-PROVENANCE.md`` for the manual-fetch steps.
- **fma**: ``fma_metadata.zip`` from the Switch cloud mirror, then
  ``fma_small.zip`` (default) or ``fma_medium.zip`` (``--full``). After
  download the CLI filters ``tracks.csv`` to CC-BY-4.0 / CC-BY-SA-4.0 /
  CC0-1.0 rows and records the retained-track roster in
  ``fma_retained_tracks.csv`` under the FMA cache dir.

All eight sources (3 from PR-Y1.3 + 5 here) now have a wired path through
``_download_source``; nothing raises :class:`NotImplementedError` except the
intentionally-manual Winterreise branch.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import logging
import shutil
import subprocess
import sys
import time
import zipfile
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from training.data.sources import DATA_SOURCES, DataSource, by_name

log = logging.getLogger("training.data.download")

# Default cache location. Override by setting TRAINING_DATA_CACHE_DIR in env;
# the CLI reads that env var at startup (see ``_cache_root``).
DEFAULT_CACHE_DIR = Path(__file__).resolve().parent / "cache"
MANIFEST_FILENAME = "MANIFEST.jsonl"
CHUNK_SIZE = 1024 * 1024  # 1 MiB streaming reads

# Transport-level retry policy. Values are small by design so unit tests
# don't block; real runs can tune via env (left as a follow-up).
_MAX_RETRIES = 3
_BASE_BACKOFF_SEC = 1.0


# ─────────────────────────────────────────────────────────────────────────────
# Pinned release artefacts and endpoints.
# ─────────────────────────────────────────────────────────────────────────────

# PDMX lives as a Zenodo record. We fetch the file manifest via Zenodo's REST
# API and then stream just the ``no_license_conflict`` archive — the per-
# license partition the authors pre-separated.
PDMX_ZENODO_RECORD_ID = "15571083"
ZENODO_FILES_API = "https://zenodo.org/api/records/{record_id}/files"

# OpenEWLD is a plain git repository; we shallow-clone to minimise bytes.
OPENEWLD_GIT_URL = "https://github.com/00sapo/OpenEWLD.git"

# Billboard: Burgoyne (UvA) canonical distribution is pending. ChoCo
# re-packages the Billboard partition under CC-BY-4.0 and is the fallback
# available today. See correspondence/burgoyne-mcgill-billboard-outreach.md.
CHOCO_GIT_URL = "https://github.com/smashub/choco.git"
CHOCO_BILLBOARD_SUBPATH = "partitions/billboard"
# ChoCo's Billboard subset is CC-BY-4.0 (the ChoCo re-packaging license);
# the underlying McGill labels are CC0.
CHOCO_BILLBOARD_LICENSE = "CC-BY-4.0 (ChoCo repackaging) + CC0-1.0 (labels)"

# AAM: Zenodo record 5794629 (Ostermann et al., 2023). Default pulls the
# first ``AAM_SAMPLE_COUNT`` files alphabetically for a ~10% sample; --full
# pulls everything.
AAM_ZENODO_RECORD_ID = "5794629"
AAM_SAMPLE_COUNT = 300

# GuitarSet: Zenodo record 3371780 (Xi et al., 2018). All files, ~2.5 GB.
GUITARSET_ZENODO_RECORD_ID = "3371780"

# FMA: metadata lives at a stable Switch cloud mirror linked from the
# upstream repo (github.com/mdeff/fma). Audio archives sit beside it.
FMA_METADATA_URL = "https://os.unil.cloud.switch.ch/fma/fma_metadata.zip"
FMA_SMALL_URL = "https://os.unil.cloud.switch.ch/fma/fma_small.zip"
FMA_MEDIUM_URL = "https://os.unil.cloud.switch.ch/fma/fma_medium.zip"
# Only these per-track license tiers survive the filter; every other tier
# (CC-BY-NC, CC-BY-ND, CC-BY-NC-SA, all-rights-reserved, …) is dropped.
FMA_ALLOWED_LICENSES = frozenset(
    {
        "Attribution 4.0 International (CC BY 4.0)",
        "Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)",
        "Creative Commons 0",
    }
)

# Soundfonts are fetched here rather than in synthetic_render.py so the
# manifest + hash story is consistent with every other asset. FluidR3_GM is
# the Y1 default soundfont per the decision record.
FLUIDR3_URL = "https://musical-artifacts.com/artifacts/738/FluidR3_GM.sf2"
# QA-B H3 / PR-Y1.sec-F1: FluidR3 had a hex constant here previously
# (4f5dcc5686…c592) that was MD5-shaped at 32 chars — NOT a SHA-256 (which
# is 64 chars) — and was never compared against the computed hash: only
# logged. That silently defeated DATA-PROVENANCE.md's MIT-bytes claim if
# the CDN swapped the artefact.
#
# New contract: FLUIDR3_SHA256 is None by default and _download_fluidr3
# FAILS CLOSED (raises ChecksumMismatchError) when it is None. The real
# sha256 must be pinned here in a reviewed PR before the training pipeline
# can fetch the soundfont.
#
# TODO(PR-Y1.sec-F1): Jon — paste the real sha256 of
#   https://musical-artifacts.com/artifacts/738/FluidR3_GM.sf2
# before merging. Compute locally with:
#   curl -sL https://musical-artifacts.com/artifacts/738/FluidR3_GM.sf2 \
#     | sha256sum
# and replace the ``None`` below. Leaving it ``None`` is safe (fail-closed)
# but blocks synthetic-render from running until pinned.
FLUIDR3_SHA256: str | None = None
FLUIDR3_LICENSE = "MIT"


def _cache_root() -> Path:
    """Resolve the cache root, honouring TRAINING_DATA_CACHE_DIR."""
    import os

    override = os.environ.get("TRAINING_DATA_CACHE_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return DEFAULT_CACHE_DIR


def _source_dir(source: DataSource) -> Path:
    root = _cache_root() / source.name
    root.mkdir(parents=True, exist_ok=True)
    return root


def _sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK_SIZE), b""):
            h.update(chunk)
    return h.hexdigest()


def _md5_of(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(CHUNK_SIZE), b""):
            h.update(chunk)
    return h.hexdigest()


def _manifest_path() -> Path:
    return _cache_root() / MANIFEST_FILENAME


def _append_manifest(entry: dict) -> None:
    mpath = _manifest_path()
    mpath.parent.mkdir(parents=True, exist_ok=True)
    with mpath.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, sort_keys=True) + "\n")


def _already_have(target: Path, expected_sha256: str | None) -> bool:
    """True if `target` exists and matches `expected_sha256` (or no hash known)."""
    if not target.exists():
        return False
    if expected_sha256 is None:
        return True
    return _sha256_of(target) == expected_sha256


class ChecksumMismatchError(RuntimeError):
    """Raised when a downloaded archive's checksum does not match the upstream value."""


def _stream_download(url: str, target: Path, *, timeout: float = 60.0) -> None:
    """Download `url` to `target` with resume support and bounded retries.

    Writes to ``<target>.part`` and renames on success. 429 responses trigger
    exponential backoff; connection errors retry up to :data:`_MAX_RETRIES`
    times before aborting. On HTTP range-not-satisfiable the partial is
    cleared and the download restarts cleanly. 404 is a hard stop (upstream
    artefact really is missing).
    """
    attempt = 0
    while True:
        partial = target.with_suffix(target.suffix + ".part")
        resume_from = partial.stat().st_size if partial.exists() else 0
        headers: dict[str, str] = {}
        if resume_from > 0:
            headers["Range"] = f"bytes={resume_from}-"
            mode = "ab"
        else:
            mode = "wb"

        log.info(
            "downloading %s -> %s (attempt=%d, resume_from=%d)",
            url,
            target,
            attempt + 1,
            resume_from,
        )
        try:
            with httpx.stream(
                "GET", url, headers=headers, timeout=timeout, follow_redirects=True
            ) as resp:
                if resp.status_code == 416:
                    partial.unlink(missing_ok=True)
                    # Loop again from scratch — do not count this as a retry.
                    continue
                if resp.status_code == 429:
                    wait = _BASE_BACKOFF_SEC * (2**attempt)
                    log.warning("rate-limited by upstream; sleeping %.1fs", wait)
                    time.sleep(wait)
                    attempt += 1
                    if attempt >= _MAX_RETRIES:
                        resp.raise_for_status()
                    continue
                if resp.status_code == 404:
                    # 404 is a hard, non-retried failure. Caller decides
                    # whether to skip (per-track FMA audio) or abort.
                    raise httpx.HTTPStatusError(
                        f"404 for {url}", request=resp.request, response=resp
                    )
                resp.raise_for_status()
                with partial.open(mode) as out:
                    for chunk in resp.iter_bytes(CHUNK_SIZE):
                        out.write(chunk)
        except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError) as exc:
            attempt += 1
            if attempt >= _MAX_RETRIES:
                log.error("connection error after %d retries: %s", _MAX_RETRIES, exc)
                raise
            wait = _BASE_BACKOFF_SEC * (2**attempt)
            log.warning("transient connection error (%s); retrying in %.1fs", exc, wait)
            time.sleep(wait)
            continue

        partial.rename(target)
        return


def _zenodo_list_files(record_id: str, *, timeout: float = 60.0) -> list[dict[str, Any]]:
    """Fetch and return the Zenodo files listing for ``record_id``.

    Returns the raw ``entries`` list from ``/api/records/<id>/files``. Each
    entry carries ``key`` (filename), ``links.self`` (download URL), and
    ``checksum`` (``"md5:<hex>"``).
    """
    url = ZENODO_FILES_API.format(record_id=record_id)
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        log.info("querying Zenodo record %s for file list", record_id)
        resp = client.get(url)
        resp.raise_for_status()
        payload = resp.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"Zenodo record {record_id} returned non-object payload")
    entries = payload.get("entries", [])
    if not isinstance(entries, list):
        raise RuntimeError(f"Zenodo record {record_id} returned non-list entries")
    return entries


def _verify_md5_or_abort(target: Path, expected_checksum: str) -> None:
    """Verify ``target`` against a Zenodo-style ``md5:<hex>`` checksum.

    Raises :class:`ChecksumMismatchError` with a clear message on mismatch.
    Accepts a bare hex string too, for callers that have stripped the prefix.
    """
    if expected_checksum.startswith("md5:"):
        expected_hex = expected_checksum[4:]
    else:
        expected_hex = expected_checksum
    actual_hex = _md5_of(target)
    if actual_hex != expected_hex:
        raise ChecksumMismatchError(
            f"md5 mismatch for {target.name}: expected {expected_hex}, got {actual_hex}"
        )


def _shallow_clone(url: str, dest: Path, *, treeless: bool = False) -> None:
    """Shallow-clone ``url`` into ``dest``. No-op if ``dest`` already exists."""
    if dest.exists():
        log.info("clone already present at %s, skipping", dest)
        return
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("git executable not found on PATH; cannot clone.")
    cmd = [git, "clone", "--depth=1"]
    if treeless:
        cmd.append("--filter=tree:0")
    cmd.extend([url, str(dest)])
    log.info("shallow-cloning %s into %s", url, dest)
    subprocess.run(cmd, check=True)  # noqa: S603 — fixed URL, no shell interpolation


# ─────────────────────────────────────────────────────────────────────────────
# Per-source download routines.
# ─────────────────────────────────────────────────────────────────────────────


def _download_pdmx(source: DataSource, *, full: bool) -> list[Path]:
    """Fetch the PDMX ``no_license_conflict`` subset from Zenodo.

    Zenodo exposes the record's files at
    ``/api/records/<id>/files`` with each entry carrying a ``links.self``
    download URL and a ``checksum`` of the form ``"md5:<hex>"``. We keep
    only the archive whose key contains ``no_license_conflict`` — the
    partition the PDMX authors pre-filter to be free of upstream CC-BY-NC /
    CC-BY-ND content (per the Y1 decision record).
    """
    _ = full  # PDMX has no dev/full toggle — the no_license_conflict partition is fixed.
    target_dir = _source_dir(source)
    entries = _zenodo_list_files(PDMX_ZENODO_RECORD_ID)
    wanted = [e for e in entries if "no_license_conflict" in e.get("key", "")]
    if not wanted:
        raise RuntimeError(
            f"Zenodo record {PDMX_ZENODO_RECORD_ID} has no 'no_license_conflict' "
            "file listed. The record may have been re-partitioned; check "
            "https://zenodo.org/records/15571083 and update sources.py."
        )

    downloaded: list[Path] = []
    for entry in wanted:
        key = entry["key"]
        link = entry.get("links", {}).get("self")
        if not link:
            log.warning("skipping PDMX entry with no download link: %s", key)
            continue
        target = target_dir / key
        if target.exists():
            log.info("PDMX file already present, skipping: %s", target.name)
            downloaded.append(target)
            continue
        _stream_download(link, target)
        checksum = entry.get("checksum")
        if checksum:
            _verify_md5_or_abort(target, checksum)
        downloaded.append(target)
    return downloaded


def _download_openewld(source: DataSource, *, full: bool) -> list[Path]:
    """Shallow-clone the OpenEWLD repository."""
    _ = full
    target_dir = _source_dir(source)
    clone_dir = target_dir / "OpenEWLD"
    _shallow_clone(OPENEWLD_GIT_URL, clone_dir)
    # Return the .musicxml/.mxl files for manifest hashing.
    return sorted(clone_dir.rglob("*.musicxml")) + sorted(clone_dir.rglob("*.mxl"))


def _download_billboard(source: DataSource, *, full: bool) -> list[Path]:
    """Fetch McGill Billboard labels via the ChoCo CC-BY-4.0 re-packaging.

    The Burgoyne (UvA) canonical distribution is pending — see
    ``claude/correspondence/burgoyne-mcgill-billboard-outreach.md``. Until
    that lands, ChoCo's ``partitions/billboard`` directory is the clean,
    CC-BY-4.0, fetchable alternative. We shallow-clone the repo (treeless to
    skip history blobs) and keep only the Billboard partition under the
    cache.
    """
    _ = full
    target_dir = _source_dir(source)
    clone_dir = target_dir / "choco"
    _shallow_clone(CHOCO_GIT_URL, clone_dir, treeless=True)

    partition = clone_dir / CHOCO_BILLBOARD_SUBPATH
    if not partition.exists():
        raise RuntimeError(
            f"ChoCo clone missing expected Billboard partition: {partition}. "
            "Upstream repo layout may have changed — check "
            "https://github.com/smashub/choco"
        )

    # Hash and return every JAMS annotation file under the Billboard
    # partition. JAMS is ChoCo's canonical annotation format.
    jams = sorted(partition.rglob("*.jams"))
    if not jams:
        # Some ChoCo partitions distribute .json instead of .jams; keep both.
        jams = sorted(partition.rglob("*.json"))
    return jams


def _download_aam(source: DataSource, *, full: bool) -> list[Path]:
    """Fetch AAM — full (209 GB) or the first 300 track entries alphabetically.

    Zenodo lists all AAM artefacts under one record; the full corpus is
    distributed as many per-track archive entries. Sample mode pulls the
    first :data:`AAM_SAMPLE_COUNT` entries after sorting by ``key`` — a
    cheap, deterministic way to get ~10% coverage without a second API round
    trip. Full mode pulls every entry.
    """
    target_dir = _source_dir(source)
    entries = _zenodo_list_files(AAM_ZENODO_RECORD_ID)
    if not entries:
        raise RuntimeError(f"Zenodo record {AAM_ZENODO_RECORD_ID} returned no entries")

    sorted_entries = sorted(entries, key=lambda e: e.get("key", ""))
    if full:
        wanted = sorted_entries
    else:
        wanted = sorted_entries[:AAM_SAMPLE_COUNT]
        log.info(
            "AAM sample mode: taking first %d of %d entries (pass --full for all)",
            len(wanted),
            len(sorted_entries),
        )

    downloaded: list[Path] = []
    for entry in wanted:
        key = entry.get("key")
        link = entry.get("links", {}).get("self")
        if not key or not link:
            log.warning("skipping AAM entry missing key or link: %r", entry)
            continue
        target = target_dir / key
        if target.exists():
            log.info("AAM file already present, skipping: %s", target.name)
            downloaded.append(target)
            continue
        try:
            _stream_download(link, target)
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                log.warning("AAM entry 404, skipping: %s", key)
                continue
            raise
        checksum = entry.get("checksum")
        if checksum:
            _verify_md5_or_abort(target, checksum)
        downloaded.append(target)
    return downloaded


def _download_guitarset(source: DataSource, *, full: bool) -> list[Path]:
    """Fetch every file listed on GuitarSet's Zenodo record (~2.5 GB total)."""
    _ = full
    target_dir = _source_dir(source)
    entries = _zenodo_list_files(GUITARSET_ZENODO_RECORD_ID)
    if not entries:
        raise RuntimeError(f"Zenodo record {GUITARSET_ZENODO_RECORD_ID} returned no entries")

    downloaded: list[Path] = []
    for entry in entries:
        key = entry.get("key")
        link = entry.get("links", {}).get("self")
        if not key or not link:
            log.warning("skipping GuitarSet entry missing key or link: %r", entry)
            continue
        target = target_dir / key
        if target.exists():
            log.info("GuitarSet file already present, skipping: %s", target.name)
            downloaded.append(target)
            continue
        _stream_download(link, target)
        checksum = entry.get("checksum")
        if checksum:
            _verify_md5_or_abort(target, checksum)
        downloaded.append(target)
    return downloaded


def _download_winterreise(source: DataSource, *, full: bool) -> list[Path]:
    """Raise with a clear pointer to the manual-fetch steps in DATA-PROVENANCE.md.

    The AudioLabs Erlangen distribution for Schubert Winterreise has no
    reliable programmatic endpoint (no public Zenodo mirror, no git source,
    and the audiolabs-erlangen.de page gates downloads behind a form). Per
    the PR-Y1.3c scope, this source is documented as manual-fetch; Jon runs
    the steps in DATA-PROVENANCE.md by hand and drops the resulting bundle
    into ``cache/winterreise/``.
    """
    _ = full
    raise NotImplementedError(
        "Winterreise has no automatable endpoint. Follow the manual steps "
        "documented in apps/training/DATA-PROVENANCE.md under the "
        "'Schubert Winterreise' entry, then record the SHA-256 and timestamp "
        "there by hand in the same PR. (Fetching it automatically was "
        "intentionally scoped out of PR-Y1.3c.)"
    )


def _fma_track_license(row: dict[str, str]) -> str:
    """Return the FMA license label for a flattened tracks.csv row, or ''.

    FMA's ``tracks.csv`` ships with a multi-index header: the first column
    group is ``track`` and the license column is addressed as
    ``('track', 'license')``. When flattened we look up the column that
    literally contains ``license`` with a ``track`` prefix.
    """
    for key, value in row.items():
        k = key.lower()
        if "license" in k and ("track" in k or "track.license" in k or key == "license"):
            return (value or "").strip()
    # Fallback: any bare 'license' column.
    return (row.get("license") or "").strip()


def _fma_filter_tracks_csv(csv_bytes: bytes) -> list[tuple[str, str]]:
    """Return ``(track_id, license)`` pairs whose license is in the allowlist.

    FMA's ``tracks.csv`` has a 3-row header. We skip the first two header
    rows and treat row 3 as the DictReader fieldnames; row 1 contains the
    column ``track_id`` as the index.
    """
    text = csv_bytes.decode("utf-8", errors="replace")
    reader = csv.reader(io.StringIO(text))
    try:
        row0 = next(reader)  # top-level group (track, album, artist, …)
        row1 = next(reader)  # sub-field within group (license, title, …)
        _ = next(reader)  # subtype row
    except StopIteration as exc:
        raise RuntimeError("fma tracks.csv header malformed") from exc

    # Build flattened field names: "track.license", "album.title", etc. The
    # first column is the (unnamed) track_id index.
    fieldnames = ["track_id"] + [
        f"{row0[i] or 'col'}.{row1[i] or 'col'}".strip(".") for i in range(1, len(row1))
    ]

    retained: list[tuple[str, str]] = []
    for row in reader:
        if not row:
            continue
        rec = dict(zip(fieldnames, row, strict=False))
        license_label = (rec.get("track.license") or "").strip()
        if license_label in FMA_ALLOWED_LICENSES:
            tid = rec.get("track_id", "").strip()
            if tid:
                retained.append((tid, license_label))
    return retained


def _download_fma(source: DataSource, *, full: bool) -> list[Path]:
    """Fetch FMA metadata + audio, filtering to allowlisted per-track licenses.

    Steps:

    1. Download ``fma_metadata.zip`` from the Switch cloud mirror.
    2. Read ``fma_metadata/tracks.csv`` from the zip in memory (no extract
       needed — only the retained-track roster is persisted).
    3. Filter rows where ``('track', 'license')`` is in
       :data:`FMA_ALLOWED_LICENSES`. Write the retained roster to
       ``fma_retained_tracks.csv`` under the cache dir — this file is the
       audit trail cited in DATA-PROVENANCE.md for the FMA entry.
    4. Download ``fma_small.zip`` (default) or ``fma_medium.zip`` (``--full``).
       The bulk zip is monolithic; downstream code extracts only tracks
       whose IDs appear in ``fma_retained_tracks.csv``. The extract step is
       left to the training-data loader — this CLI ships the raw inputs +
       the roster.
    """
    target_dir = _source_dir(source)

    metadata_zip = target_dir / "fma_metadata.zip"
    if not metadata_zip.exists():
        _stream_download(FMA_METADATA_URL, metadata_zip)

    with zipfile.ZipFile(metadata_zip, "r") as zf:
        tracks_members = [n for n in zf.namelist() if n.endswith("tracks.csv")]
        if not tracks_members:
            raise RuntimeError(f"{metadata_zip.name} missing tracks.csv — metadata layout changed")
        with zf.open(tracks_members[0]) as fh:
            tracks_csv_bytes = fh.read()

    retained = _fma_filter_tracks_csv(tracks_csv_bytes)
    log.info("FMA license filter kept %d tracks", len(retained))
    roster_path = target_dir / "fma_retained_tracks.csv"
    with roster_path.open("w", encoding="utf-8", newline="") as out:
        writer = csv.writer(out)
        writer.writerow(["track_id", "license"])
        writer.writerows(retained)

    audio_url = FMA_MEDIUM_URL if full else FMA_SMALL_URL
    audio_name = "fma_medium.zip" if full else "fma_small.zip"
    audio_zip = target_dir / audio_name
    if not audio_zip.exists():
        _stream_download(audio_url, audio_zip)

    return [metadata_zip, roster_path, audio_zip]


def _download_fluidr3(source: DataSource, *, full: bool) -> list[Path]:
    """Fetch the FluidR3_GM soundfont (MIT) and enforce its pinned sha256.

    QA-B H3 / PR-Y1.sec-F1: the previous version held a 32-char hex constant
    (MD5-shaped, never a SHA-256) and *only logged* the computed hash — never
    compared. The new contract:

    - ``FLUIDR3_SHA256 is None`` (unpinned): the function **fails closed** —
      ``ChecksumMismatchError`` is raised. There is no trust-on-first-use.
      The operator must pin the real sha256 in source in its own reviewed PR.
    - ``FLUIDR3_SHA256`` set: the file is hashed whether newly-downloaded or
      pre-existing on disk (TOCTOU fix for a swapped artefact) and raises
      :class:`ChecksumMismatchError` on mismatch. The MANIFEST.jsonl entry
      is still appended with the computed SHA so provenance stays auditable.
    """
    _ = full
    target_dir = _source_dir(source)
    target = target_dir / "FluidR3_GM.sf2"

    # PR-Y1.sec-F1 TOCTOU fix: do NOT short-circuit on pre-existing file.
    # Only skip the network fetch — always hash the bytes on disk so a
    # swapped artefact in the cache dir is still rejected by the guard below.
    if not target.exists():
        _stream_download(FLUIDR3_URL, target)
    actual = _sha256_of(target)

    # PR-Y1.sec-F1 fail-closed: if the pin is unset, refuse to use unverified
    # bytes. Previous behaviour was trust-on-first-use (log + accept) which
    # silently reintroduced the H3 bug after a cache miss.
    if FLUIDR3_SHA256 is None:
        raise ChecksumMismatchError(
            "FLUIDR3_SHA256 unpinned; refusing to use unverified bytes. "
            f"Computed {actual}; pin it in source "
            "(apps/training/data/download.py) in its own reviewed PR before "
            "re-running synthetic render. See the TODO above FLUIDR3_SHA256."
        )
    if actual != FLUIDR3_SHA256:
        # Delete the untrusted bytes so a retry does not idempotently skip
        # the re-download (``_already_have`` short-circuits on file-exists).
        target.unlink(missing_ok=True)
        raise ChecksumMismatchError(
            "FluidR3_GM.sf2 sha256 mismatch: "
            f"expected {FLUIDR3_SHA256}, got {actual}. Upstream artefact at "
            f"{FLUIDR3_URL} appears to have been replaced; investigate before "
            "updating the pin."
        )
    log.info("FluidR3_GM sha256=%s (matches pin)", actual)
    return [target]


# Dispatch map: slug → download function. Every DATA_SOURCES entry plus
# the FluidR3 soundfont has a wired handler; Winterreise's handler
# intentionally raises NotImplementedError (see function docstring).
_WIRED: dict[str, object] = {
    "pdmx": _download_pdmx,
    "openewld": _download_openewld,
    "fluidr3": _download_fluidr3,
    "billboard": _download_billboard,
    "aam": _download_aam,
    "guitarset": _download_guitarset,
    "winterreise": _download_winterreise,
    "fma": _download_fma,
}


def _download_source(source: DataSource, *, full: bool) -> list[Path]:
    """Download `source` into its cache dir.

    All approved sources plus the FluidR3 soundfont are wired through
    :data:`_WIRED`. The transport layer (resume, retry, hashing, manifest
    append) is shared across every source and is exercised in the tests at
    ``apps/training/tests/test_download_sources.py``.
    """
    handler = _WIRED.get(source.name)
    if handler is not None:
        return handler(source, full=full)  # type: ignore[operator]

    raise NotImplementedError(
        f"No download handler registered for {source.name!r}. "
        "Add it to _WIRED in apps/training/data/download.py."
    )


def _confirm_or_die(args: argparse.Namespace) -> None:
    if not args.confirm:
        print(
            "Refusing to download without --confirm. Pass --confirm to proceed.\n"
            "Datasets can be large (AAM full corpus = ~209 GB).",
            file=sys.stderr,
        )
        sys.exit(2)


def _cmd_list(_args: argparse.Namespace) -> int:
    # Also advertise the fluidr3 soundfont as a fetchable artefact. It is
    # documented in SOUNDFONTS (synthetic_render) but travels through the
    # same download CLI so the manifest covers every fetched byte.
    print(f"{'NAME':<14} {'LICENSE':<36} {'SIZE_GB':>8}  URL")
    print("-" * 110)
    for s in DATA_SOURCES:
        print(f"{s.name:<14} {s.license:<36} {s.size_gb:>8.1f}  {s.url}")
    # Soundfont rows — not in DATA_SOURCES because they aren't annotation corpora.
    print(f"{'fluidr3':<14} {FLUIDR3_LICENSE:<36} {0.15:>8.1f}  {FLUIDR3_URL}")
    return 0


def _cmd_download(args: argparse.Namespace) -> int:
    _confirm_or_die(args)
    # Soundfonts are not DATA_SOURCES but we still wire them through the same
    # CLI. A synthetic DataSource record is used for the manifest entry.
    if args.source == "fluidr3":
        source = DataSource(
            name="fluidr3",
            license=FLUIDR3_LICENSE,
            url=FLUIDR3_URL,
            size_gb=0.15,
            citation=(
                "Wen, F. (2000). FluidR3_GM: A General MIDI SoundFont. MIT License. "
                "Distributed via musical-artifacts.com."
            ),
            retrieval_notes="Default synthetic-render soundfont (PR-Y1.3).",
        )
    else:
        source = by_name(args.source)
    _source_dir(source)  # ensure it exists

    try:
        downloaded = _download_source(source, full=args.full)
    except NotImplementedError as e:
        log.warning("%s", e)
        print(f"not-yet-implemented: {e}", file=sys.stderr)
        return 3
    except ChecksumMismatchError as e:
        log.error("%s", e)
        print(f"checksum-mismatch: {e}", file=sys.stderr)
        return 4

    for path in downloaded:
        entry = {
            "source": source.name,
            "filename": path.name,
            "sha256": _sha256_of(path),
            "license": source.license,
            "download_timestamp": datetime.now(UTC).isoformat(),
            "src_url": source.url,
        }
        _append_manifest(entry)
        log.info("recorded %s sha256=%s", path.name, entry["sha256"])
    return 0


def _cmd_describe(args: argparse.Namespace) -> int:
    source = by_name(args.source)
    print(json.dumps(asdict(source), indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m training.data.download",
        description="Fetch ChordNet Y1 training corpora with SHA-256 manifest.",
    )
    p.add_argument(
        "--list",
        action="store_true",
        help="List all approved sources with license + size and exit.",
    )
    p.add_argument(
        "--describe",
        action="store_true",
        help="Print the full dataclass record for --source and exit.",
    )
    choices = [s.name for s in DATA_SOURCES] + ["fluidr3"]
    p.add_argument(
        "--source",
        choices=choices,
        help="Which source to act on (adds 'fluidr3' soundfont alongside corpora).",
    )
    p.add_argument(
        "--confirm",
        action="store_true",
        help="Required to actually download anything. Dry-run by default.",
    )
    p.add_argument(
        "--full",
        action="store_true",
        help="For sources that have a dev subset (e.g. AAM), fetch the full corpus.",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Enable debug logging.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.list:
        return _cmd_list(args)
    if args.describe:
        if not args.source:
            parser.error("--describe requires --source")
        return _cmd_describe(args)
    if args.source:
        return _cmd_download(args)
    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
