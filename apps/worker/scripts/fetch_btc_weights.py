#!/usr/bin/env python3
"""Fetch the BTC chord-model weights (CHORDS_PROVIDER=btc) and verify their pinned SHA-256.

Weights are NEVER committed. The worker image fetches them at build time (Dockerfile) and the
worker verifies the same SHA-256 before reading them (chord_providers/btc.py). Local tests:

    python apps/worker/scripts/fetch_btc_weights.py /tmp/btc/btc_model_large_voca.pt
    BTC_WEIGHTS_PATH=/tmp/btc/btc_model_large_voca.pt pytest apps/worker/tests/test_chord_btc.py

Source: github.com/jayg996/BTC-ISMIR19 at commit 2682317 (code MIT, (c) 2019 Jonggwon Park),
file test/btc_model_large_voca.pt, 12,229,576 bytes. Licence caveat (DR-D1, Jon's D1a
2026-11-27): the weights were trained on chord annotations some publishers license as
non-commercial; accepted for the unpaid beta only.

Exit 0 when the file is in place and verified. On a network/checksum failure: exit 1, or,
with --soft (the Dockerfile uses it, so a GitHub outage cannot block a klangio deploy), print a
loud warning, leave NO file behind and exit 0; selecting btc then fails per job with
BtcWeightsMissing -> a provider_failed tombstone. Standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import tempfile
import urllib.request
from pathlib import Path

COMMIT = "2682317be668032e6e4b269ded36adaa2ad57df0"
URL = f"https://raw.githubusercontent.com/jayg996/BTC-ISMIR19/{COMMIT}/test/btc_model_large_voca.pt"
SHA256 = "1673d23f8f9a55ae7f9e8b80a51da616debb22675b8d8b67ea6ce0ef37b0ab51"
SIZE = 12_229_576
MAX_BYTES = 16 * 1024 * 1024


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch(dest: Path, url: str | None = None, timeout: float = 60.0) -> None:
    url = url or URL
    if dest.is_file() and _sha256(dest) == SHA256:
        print(f"btc weights already present and verified: {dest}")
        return
    dest.unlink(missing_ok=True)  # a stale/bad file must not survive a failed fetch
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=dest.parent, prefix=".btc-", suffix=".part")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as out, urllib.request.urlopen(url, timeout=timeout) as resp:
            total = 0
            while chunk := resp.read(1 << 20):
                total += len(chunk)
                if total > MAX_BYTES:
                    raise RuntimeError(f"download exceeds {MAX_BYTES} bytes")
                out.write(chunk)
        if tmp.stat().st_size != SIZE:
            raise RuntimeError(f"size {tmp.stat().st_size} != {SIZE}")
        got = _sha256(tmp)
        if got != SHA256:
            raise RuntimeError(f"sha256 mismatch: got {got}, want {SHA256}")
        os.replace(tmp, dest)
        print(f"btc weights fetched and verified: {dest}")
    finally:
        tmp.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("dest", type=Path, help="destination file path")
    ap.add_argument("--soft", action="store_true", help="warn instead of failing")
    args = ap.parse_args(argv)
    try:
        fetch(args.dest)
    except Exception as exc:  # noqa: BLE001 — reported below
        msg = f"btc weights NOT installed ({exc}); CHORDS_PROVIDER=btc will fail per job"
        if args.soft:
            print(f"WARNING: {msg}", file=sys.stderr)
            return 0
        print(f"ERROR: {msg}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
