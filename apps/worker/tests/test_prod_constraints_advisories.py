"""QA track B, B-16: the production image's pins must not carry the known advisories.

pip-audit on constraints-prod.txt (2026-11-18) flagged urllib3 2.7.0 (fixed 2.8.0), certifi
2026.7.22 (fixed 2026.10.18) and msgpack 1.2.2 (fixed 1.2.3). These are floors on the EXACT
pins, so a later edit that drops one back below its fix goes red here.
"""

from __future__ import annotations

from pathlib import Path

import pytest

CONSTRAINTS = Path(__file__).resolve().parents[1] / "constraints-prod.txt"
FLOORS = {"urllib3": (2, 8, 0), "certifi": (2026, 10, 18), "msgpack": (1, 2, 3)}


def _pins() -> dict[str, tuple[int, ...]]:
    out: dict[str, tuple[int, ...]] = {}
    for line in CONSTRAINTS.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if "==" in line:
            name, ver = line.split("==", 1)
            out[name.strip().lower()] = tuple(int(p) for p in ver.strip().split(".") if p.isdigit())
    return out


@pytest.mark.parametrize("name", sorted(FLOORS))
def test_pin_is_at_or_above_the_advisory_fix(name):
    pins = _pins()
    assert name in pins, f"{name} is no longer pinned in constraints-prod.txt"
    assert pins[name] >= FLOORS[name], f"{name} {pins[name]} is below the fixed {FLOORS[name]}"
