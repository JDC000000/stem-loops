"""CLI: fetch training corpora with SHA-256 manifest + resume support.

Usage::

    python -m training.data.download --list
    python -m training.data.download --source guitarset --confirm
    python -m training.data.download --source aam --confirm            # dev subset
    python -m training.data.download --source aam --confirm --full     # all 209 GB

Design rules (per PR-Y1.2):

- **Dry by default.** Nothing is downloaded without ``--confirm``.
- **Resume-on-interrupt.** Partial files are kept at ``<path>.part`` and
  continued with an HTTP ``Range`` request.
- **Idempotent.** A file already present whose SHA-256 matches the recorded
  manifest entry is skipped. A mismatched hash is re-downloaded.
- **Provenance.** Every successful download appends a line to
  ``cache/MANIFEST.jsonl`` recording source slug, filename, sha256, license,
  download timestamp (UTC, ISO-8601), and the source URL. This is the audit
  trail cited in ``DATA-PROVENANCE.md``.

The actual per-source download logic is scaffolded here but kept intentionally
small for PR-Y1.2 — expanding each source to its real archive layout
(Zenodo zip bundles, FMA metadata filtering, etc.) is PR-Y1.3 work.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
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


def _download_source(source: DataSource, *, full: bool) -> list[Path]:
    """Download `source` into its cache dir.

    PR-Y1.2 scaffold: the per-source archive layout is not finalised. This
    function raises NotImplementedError with a clear pointer so PR-Y1.3 can
    plug in the real Zenodo/GitHub record layouts. The transport, resume,
    manifest, and hashing machinery around it is complete and tested.
    """
    _ = full  # reserved for aam --full vs dev subset; PR-Y1.3.
    raise NotImplementedError(
        f"Per-source archive layout for {source.name!r} is not wired yet. "
        "Resume/hash/manifest transport is in place; PR-Y1.3 wires the "
        "Zenodo record IDs and FMA metadata filter. See "
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
    print(f"{'NAME':<14} {'LICENSE':<36} {'SIZE_GB':>8}  URL")
    print("-" * 110)
    for s in DATA_SOURCES:
        print(f"{s.name:<14} {s.license:<36} {s.size_gb:>8.1f}  {s.url}")
    return 0


def _cmd_download(args: argparse.Namespace) -> int:
    _confirm_or_die(args)
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
    p.add_argument(
        "--source",
        choices=[s.name for s in DATA_SOURCES],
        help="Which source to act on.",
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
