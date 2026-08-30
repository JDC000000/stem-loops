#!/usr/bin/env python3
"""Report how stale the installed yt-dlp is against the latest release on PyPI.

WHY THIS EXISTS
    yt-dlp tracks YouTube's frequently-changing extraction internals, so a stale
    version is a live outage risk rather than cosmetic lag. On 2026-08-30 the
    production worker could not download ANY video: requirements.txt carried an
    unpinned `yt-dlp>=2024.5.27`, so the Jul-21 image build froze on 2026.07.04
    and silently rotted for ~8 weeks until every YouTube job failed
    DOWNLOAD_BLOCKED. Nothing surfaced that drift. This script does.

IMPORTANT — A `>=` FLOOR ONLY MOVES ON IMAGE REBUILD
    Bumping the floor in requirements.txt does NOT update a running deployment,
    and neither does this script: pip resolves the version at BUILD time, so the
    deployed version is frozen until the worker image is rebuilt and redeployed.
    Treat a STALE result as "rebuild and redeploy the worker", not "edit a pin".

EXIT CODES (designed for scheduling)
    0  FRESH    — installed release is within the age threshold
    1  STALE    — installed release is older than the threshold: ACT ON THIS
    2  UNKNOWN  — could not determine (PyPI unreachable, yt-dlp not installed,
                  unparseable response). Deliberately DISTINCT from 1 so a
                  network blip is never misread as a staleness alert.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

PYPI_URL = "https://pypi.org/pypi/yt-dlp/json"
# yt-dlp publishes nightly pre-releases (e.g. "2026.8.27.231323.dev0") alongside
# stable date versions ("2026.8.19"). Counting those as "releases behind" makes an
# up-to-date install look 5 behind, so only purely-numeric versions count as stable.
_STABLE_RE = re.compile(r"\d+(\.\d+)*\Z")
DEFAULT_MAX_AGE_DAYS = 45  # the outage version was ~57 days stale; alert before that

EXIT_FRESH, EXIT_STALE, EXIT_UNKNOWN = 0, 1, 2


def installed_version() -> str | None:
    """Version of yt-dlp importable in THIS interpreter, or None."""
    try:
        from importlib.metadata import version

        return version("yt-dlp")
    except Exception:
        pass
    try:  # fall back to the package's own constant
        import yt_dlp  # noqa: PLC0415

        return getattr(yt_dlp, "version", None) and yt_dlp.version.__version__
    except Exception:
        return None


def fetch_pypi(timeout: float) -> dict:
    with urllib.request.urlopen(PYPI_URL, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _release_date(payload: dict, ver: str) -> datetime | None:
    """Upload date of `ver`, or None if PyPI has no such release."""
    files = (payload.get("releases") or {}).get(ver) or []
    stamps = [f.get("upload_time_iso_8601") for f in files if f.get("upload_time_iso_8601")]
    if not stamps:
        return None
    # normalise the trailing Z that fromisoformat rejects on older Pythons
    return min(datetime.fromisoformat(s.replace("Z", "+00:00")) for s in stamps)


def evaluate(payload: dict, installed: str, max_age_days: int, now: datetime | None = None) -> dict:
    """Pure decision logic — no I/O, so it is unit-testable."""
    now = now or datetime.now(timezone.utc)
    latest = (payload.get("info") or {}).get("version")
    if not latest:
        return {"ok": False, "reason": "PyPI response had no info.version"}

    inst_date = _release_date(payload, installed)
    latest_date = _release_date(payload, latest)

    # Age is measured from the INSTALLED release's publication date — that is what
    # "how old is the code we actually run" means. If PyPI no longer lists the
    # installed version (yanked//dev build), fall back to the latest release's age
    # so we still alert rather than silently passing.
    basis = inst_date or latest_date
    if basis is None:
        return {"ok": False, "reason": "no upload dates in PyPI response"}

    age_days = (now - basis).days
    all_releases = payload.get("releases") or {}
    if installed == latest:
        behind = 0  # cannot be behind the version PyPI itself calls latest
    else:
        behind = sum(
            1
            for v in all_releases
            if _STABLE_RE.match(v)
            and (d := _release_date(payload, v)) is not None
            and inst_date is not None
            and d > inst_date
        )

    return {
        "ok": True,
        "installed": installed,
        "latest": latest,
        "up_to_date": installed == latest,
        "installed_release_date": inst_date.date().isoformat() if inst_date else None,
        "installed_version_known_to_pypi": inst_date is not None,
        "age_days": age_days,
        "releases_behind": behind,
        "threshold_days": max_age_days,
        "stale": age_days > max_age_days,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--max-age-days", type=int, default=DEFAULT_MAX_AGE_DAYS,
                    help=f"days before the installed release is STALE (default {DEFAULT_MAX_AGE_DAYS})")
    ap.add_argument("--version", help="check this version string instead of the installed one")
    ap.add_argument("--timeout", type=float, default=15.0, help="PyPI HTTP timeout in seconds")
    ap.add_argument("--json", action="store_true", dest="as_json", help="emit machine-readable JSON")
    args = ap.parse_args(argv)

    inst = args.version or installed_version()
    if not inst:
        msg = "UNKNOWN: yt-dlp is not installed in this interpreter (use --version to check explicitly)"
        print(json.dumps({"ok": False, "reason": msg}) if args.as_json else msg, file=sys.stderr)
        return EXIT_UNKNOWN

    try:
        payload = fetch_pypi(args.timeout)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        msg = f"UNKNOWN: could not reach PyPI ({type(e).__name__}: {e}) — not treating as stale"
        print(json.dumps({"ok": False, "reason": msg}) if args.as_json else msg, file=sys.stderr)
        return EXIT_UNKNOWN

    res = evaluate(payload, inst, args.max_age_days)
    if not res["ok"]:
        msg = f"UNKNOWN: {res['reason']}"
        print(json.dumps(res) if args.as_json else msg, file=sys.stderr)
        return EXIT_UNKNOWN

    if args.as_json:
        print(json.dumps(res, indent=2))
    else:
        state = "STALE" if res["stale"] else "FRESH"
        print(f"{state}: yt-dlp {res['installed']} (released {res['installed_release_date']}, "
              f"{res['age_days']}d ago) | latest {res['latest']} | "
              f"{res['releases_behind']} release(s) behind | threshold {res['threshold_days']}d")
        if not res["installed_version_known_to_pypi"]:
            print("  note: installed version is not listed on PyPI (yanked or non-release build); "
                  "age measured from the latest release instead.")
        if res["stale"]:
            print("  ACTION: rebuild and redeploy the worker image "
                  "(`cd apps/worker && fly deploy --remote-only`). Editing the requirements.txt "
                  "floor alone does NOT update a running deployment.")
    return EXIT_STALE if res["stale"] else EXIT_FRESH


if __name__ == "__main__":
    sys.exit(main())
