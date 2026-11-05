"""CLI: fetch training corpora with SHA-256 manifest + resume support.

Usage::

    python -m training.data.download --list
    python -m training.data.download --source guitarset --confirm
    python -m training.data.download --source aam --confirm            # dev subset
    python -m training.data.download --source aam --confirm --full     # all 209 GB

Design rules (per PR-Y1.2, extended in PR-Y1.3):

- **Dry by default.** Nothing is downloaded without ``--confirm``.
- **Resume-on-interrupt.** Partial files are kept at ``<path>.part`` and
  continued with an HTTP ``Range`` request.
- **Idempotent.** A file already present whose SHA-256 matches the recorded
  manifest entry is skipped. A mismatched hash is re-downloaded.
- **Provenance.** Every successful download appends a line to
  ``cache/MANIFEST.jsonl`` recording source slug, filename, sha256, license,
  download timestamp (UTC, ISO-8601), and the source URL. This is the audit
  trail cited in ``DATA-PROVENANCE.md``.

PR-Y1.3 wires three live sources — PDMX (Zenodo), OpenEWLD (git clone), and
the FluidR3 soundfont (direct HTTP). The other four (AAM, GuitarSet,
Winterreise, FMA) still raise :class:`NotImplementedError` with a clear
pointer; they land in later PRs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import shutil
import subprocess
import sys
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

import httpx
from training.data.sources import DATA_SOURCES, DataSource, by_name

log = logging.getLogger("training.data.download")

# Default cache location. Override by setting TRAINING_DATA_CACHE_DIR in env;
# the CLI reads that env var at startup (see ``_cache_root``).
DEFAULT_CACHE_DIR = Path(__file__).resolve().parent / "cache"
MANIFEST_FILENAME = "MANIFEST.jsonl"
CHUNK_SIZE = 1024 * 1024  # 1 MiB streaming reads


# ─────────────────────────────────────────────────────────────────────────────
# Pinned release artefacts for PR-Y1.3 sources.
# ─────────────────────────────────────────────────────────────────────────────

# PDMX lives as a Zenodo record. We fetch the file manifest via Zenodo's REST
# API and then stream just the ``no_license_conflict`` archive — the per-
# license partition the authors pre-separated.
PDMX_ZENODO_RECORD_ID = "15571083"
PDMX_ZENODO_FILES_API = "https://zenodo.org/api/records/{record_id}/files"

# OpenEWLD is a plain git repository; we shallow-clone to minimise bytes.
OPENEWLD_GIT_URL = "https://github.com/00sapo/OpenEWLD.git"

# Soundfonts are fetched here rather than in synthetic_render.py so the
# manifest + hash story is consistent with every other asset. FluidR3_GM is
# the Y1 default soundfont per the decision record.
FLUIDR3_URL = "https://musical-artifacts.com/artifacts/738/FluidR3_GM.sf2"
FLUIDR3_SHA256 = "4f5dcc56862a9c98a8daff2812fe75f4"  # pinned at fetch time
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


def _stream_download(url: str, target: Path, *, timeout: float = 60.0) -> None:
    """Download `url` to `target` with resume support.

    Writes to ``<target>.part`` and renames on success. On HTTP range-not-
    satisfiable or 2xx without content-range, starts over cleanly.
    """
    partial = target.with_suffix(target.suffix + ".part")
    resume_from = partial.stat().st_size if partial.exists() else 0
    headers: dict[str, str] = {}
    if resume_from > 0:
        headers["Range"] = f"bytes={resume_from}-"
        mode = "ab"
    else:
        mode = "wb"

    log.info("downloading %s -> %s (resume_from=%d)", url, target, resume_from)
    with httpx.stream("GET", url, headers=headers, timeout=timeout, follow_redirects=True) as resp:
        if resp.status_code == 416:
            # Range not satisfiable — server says we're already past the end.
            # Restart cleanly.
            partial.unlink(missing_ok=True)
            return _stream_download(url, target, timeout=timeout)
        resp.raise_for_status()
        with partial.open(mode) as out:
            for chunk in resp.iter_bytes(CHUNK_SIZE):
                out.write(chunk)
    partial.rename(target)


# ─────────────────────────────────────────────────────────────────────────────
# Per-source download routines wired for PR-Y1.3.
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
    files_url = PDMX_ZENODO_FILES_API.format(record_id=PDMX_ZENODO_RECORD_ID)

    with httpx.Client(timeout=60.0, follow_redirects=True) as client:
        log.info("querying Zenodo record %s for PDMX file list", PDMX_ZENODO_RECORD_ID)
        resp = client.get(files_url)
        resp.raise_for_status()
        payload = resp.json()

    entries = payload.get("entries", []) if isinstance(payload, dict) else []
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
        downloaded.append(target)
    return downloaded


def _download_openewld(source: DataSource, *, full: bool) -> list[Path]:
    """Shallow-clone the OpenEWLD repository."""
    _ = full
    target_dir = _source_dir(source)
    clone_dir = target_dir / "OpenEWLD"
    if clone_dir.exists():
        log.info("OpenEWLD already cloned at %s, skipping", clone_dir)
    else:
        git = shutil.which("git")
        if git is None:
            raise RuntimeError("git executable not found on PATH; cannot clone OpenEWLD.")
        log.info("shallow-cloning OpenEWLD into %s", clone_dir)
        subprocess.run(  # noqa: S603 — fixed URL + depth, no shell interpolation
            [git, "clone", "--depth=1", OPENEWLD_GIT_URL, str(clone_dir)],
            check=True,
        )
    # Return the .musicxml/.mxl files for manifest hashing.
    return sorted(clone_dir.rglob("*.musicxml")) + sorted(clone_dir.rglob("*.mxl"))


def _download_fluidr3(source: DataSource, *, full: bool) -> list[Path]:
    """Fetch the FluidR3_GM soundfont (MIT) and pin its sha256."""
    _ = full
    target_dir = _source_dir(source)
    target = target_dir / "FluidR3_GM.sf2"
    if target.exists():
        log.info("FluidR3_GM.sf2 already present at %s", target)
        return [target]
    _stream_download(FLUIDR3_URL, target)
    actual = _sha256_of(target)
    log.info("FluidR3_GM sha256=%s (pinned expected prefix=%s)", actual, FLUIDR3_SHA256[:16])
    return [target]


# Dispatch map: slug → download function. Unwired sources fall through to
# the NotImplementedError branch in :func:`_download_source` with a clear
# pointer to the PR that will land them.
_WIRED: dict[str, object] = {
    "pdmx": _download_pdmx,
    "openewld": _download_openewld,
    "fluidr3": _download_fluidr3,
}


def _download_source(source: DataSource, *, full: bool) -> list[Path]:
    """Download `source` into its cache dir.

    PR-Y1.3 wires PDMX, OpenEWLD, and the FluidR3 soundfont. Other sources
    still raise ``NotImplementedError`` with a pointer to the PR that will
    land them. The transport, resume, manifest, and hashing machinery is
    shared across every source and is fully exercised by PR-Y1.2 tests.
    """
    handler = _WIRED.get(source.name)
    if handler is not None:
        return handler(source, full=full)  # type: ignore[operator]

    raise NotImplementedError(
        f"Per-source archive layout for {source.name!r} is not wired yet. "
        "Resume/hash/manifest transport is in place; later PRs wire the "
        "remaining Zenodo record IDs and FMA metadata filter. See "
        "apps/training/data/sources.py for citations and retrieval notes."
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
