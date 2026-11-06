"""One Harte validity table, run through every validator that guards it (issue #141, item 4).

The same label used to be accepted by one layer and rejected by another (``G:7/5`` accepted by
the worker, rejected by the other three; ``C:foo`` accepted by the DB but not the worker). Each
validator had its own tests, each green.

The expected validity lives in ``fixtures/contracts/harte-labels.json``, hand-authored and
independent of every validator. This file checks the two Python-side layers:
  * the worker's ``is_valid_harte_label``
  * the REAL ``chord_edits_valid_harte`` CHECK, read out of a fully migrated database
    (``pg_get_constraintdef``) and applied to a probe table, so a future migration that
    changes the constraint is what gets tested, not a copy of it.
The web layers (real chord-edits route + real edit-collector) read the same file in
``apps/web/test/harte-cross-layer.test.mjs``. Add a label to the JSON and all four layers
must agree on it.

The DB layer needs DATABASE_URL (local throwaway DB with all migrations applied).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from worker.chord_source import _HARTE_QUALITIES, is_valid_harte_label

FIXTURE = Path(__file__).resolve().parents[3] / "fixtures" / "contracts" / "harte-labels.json"
TABLE = json.loads(FIXTURE.read_text())
CASES = [(r["label"], r["valid"], r["note"]) for r in TABLE["labels"]]
IDS = [f"{'ok' if v else 'bad'}-{n}-{lab!r}" for lab, v, n in CASES]

# REAL divergences found by this table that need a production change (out of scope for the test
# PR). strict xfail: the day the worker is fixed these XPASS and fail, forcing the entry's removal.
WORKER_KNOWN_DIVERGENCES = {
    "C:maj7\n": "HARTE_RE ends in `$` and uses re.match, so a trailing newline is accepted; "
    "the DB CHECK and the JS regex reject it. Fix: re.fullmatch / \\Z in chord_source.py.",
}


def _worker_cases() -> list:
    out = []
    for (label, valid, note), id_ in zip(CASES, IDS, strict=True):
        marks = ()
        if label in WORKER_KNOWN_DIVERGENCES:
            marks = (pytest.mark.xfail(strict=True, reason=WORKER_KNOWN_DIVERGENCES[label]),)
        out.append(pytest.param(label, valid, note, id=id_, marks=marks))
    return out


DB = os.environ.get("DATABASE_URL")
_DB_LOCAL = bool(DB) and any(h in (DB or "") for h in ("127.0.0.1", "localhost"))


def test_fixture_covers_all_24_qualities_and_matches_the_worker_alphabet() -> None:
    assert len(TABLE["qualities"]) == 24
    assert set(TABLE["qualities"]) == set(_HARTE_QUALITIES), "fixture and worker alphabet drifted"
    valid = {lab for lab, v, _ in CASES if v}
    for q in TABLE["qualities"]:
        assert f"C:{q}" in valid, f"quality {q} has no valid case in the table"
    assert {"N", "X"} <= valid and any("/" in lab for lab in valid), "need N, X and slash chords"
    assert sum(1 for _, v, _ in CASES if not v) >= 20, "need real junk coverage"


@pytest.mark.parametrize(("label", "valid", "note"), _worker_cases())
def test_worker_is_valid_harte_label_agrees_with_the_table(
    label: str, valid: bool, note: str
) -> None:
    assert is_valid_harte_label(label) is valid, f"worker disagrees on {label!r} ({note})"


@pytest.mark.skipif(not _DB_LOCAL, reason="needs a local DATABASE_URL with migrations applied")
def test_db_check_constraint_agrees_with_the_table() -> None:
    import psycopg
    from psycopg import errors

    disagreements: list[str] = []
    with psycopg.connect(DB) as c:  # type: ignore[arg-type]
        row = c.execute(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conname = 'chord_edits_valid_harte' "
            "AND conrelid = 'public.chord_edits'::regclass"
        ).fetchone()
        assert row, "chord_edits_valid_harte is missing - migrations not applied?"
        c.execute(
            f"CREATE TEMP TABLE harte_probe (corrected_label text, CONSTRAINT probe {row[0]})"
        )
        for label, valid, note in CASES:
            c.execute("SAVEPOINT p")
            try:
                c.execute("INSERT INTO harte_probe VALUES (%s)", (label,))
                accepted = True
            except (errors.CheckViolation, errors.DataError):
                # DataError: Postgres text cannot hold NUL - the DB refuses it, which is "invalid".
                accepted = False
            finally:
                c.execute("ROLLBACK TO SAVEPOINT p")
            if accepted is not valid:
                disagreements.append(
                    f"{label!r} ({note}): table says valid={valid}, DB accepted={accepted}"
                )
        c.rollback()
    assert not disagreements, "DB CHECK disagrees with the table:\n" + "\n".join(disagreements)
