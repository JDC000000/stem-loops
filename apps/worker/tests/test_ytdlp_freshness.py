"""Unit tests for the yt-dlp freshness check's decision logic.

evaluate() is deliberately pure (no network) so these run offline and pin the
behaviour that matters operationally: a stale version must alert, an up-to-date
one must not, and nightly pre-releases must never inflate "releases behind".
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from check_ytdlp_freshness import evaluate  # noqa: E402

NOW = datetime(2026, 8, 30, tzinfo=timezone.utc)


def _payload(latest, releases):
    return {
        "info": {"version": latest},
        "releases": {v: [{"upload_time_iso_8601": d}] for v, d in releases.items()},
    }


PAYLOAD = _payload(
    "2026.8.19",
    {
        "2026.7.4": "2026-07-04T00:00:00Z",
        "2026.8.19": "2026-08-19T00:00:00Z",
        "2026.8.27.231323.dev0": "2026-08-27T00:00:00Z",  # nightly pre-release
        "2026.8.29.232711.dev0": "2026-08-29T00:00:00Z",  # nightly pre-release
    },
)


def test_up_to_date_is_fresh_and_zero_behind():
    r = evaluate(PAYLOAD, "2026.8.19", 45, now=NOW)
    assert r["ok"] and not r["stale"]
    assert r["up_to_date"] is True
    # regression: nightly .dev0 builds must NOT count as releases behind
    assert r["releases_behind"] == 0
    assert r["age_days"] == 11


def test_the_outage_version_is_stale():
    """2026.7.4 is what production silently ran for ~8 weeks."""
    r = evaluate(PAYLOAD, "2026.7.4", 45, now=NOW)
    assert r["stale"] is True
    assert r["age_days"] == 57
    assert r["releases_behind"] == 1  # only the stable 2026.8.19, not the nightlies


def test_threshold_is_exclusive_boundary():
    assert evaluate(PAYLOAD, "2026.7.4", 57, now=NOW)["stale"] is False
    assert evaluate(PAYLOAD, "2026.7.4", 56, now=NOW)["stale"] is True


def test_version_absent_from_pypi_falls_back_to_latest_date():
    """A yanked/local build must still be evaluated, not silently pass."""
    r = evaluate(PAYLOAD, "1999.1.1", 45, now=NOW)
    assert r["ok"] is True
    assert r["installed_version_known_to_pypi"] is False
    assert r["age_days"] == 11  # measured from latest release instead


@pytest.mark.parametrize(
    "payload,reason",
    [
        ({"info": {}, "releases": {}}, "info.version"),
        ({"info": {"version": "1.0"}, "releases": {}}, "upload dates"),
    ],
)
def test_malformed_pypi_payload_is_not_ok(payload, reason):
    r = evaluate(payload, "2026.8.19", 45, now=NOW)
    assert r["ok"] is False and reason in r["reason"]
