"""Tests for ``scripts/codegen_alphabet.py``.

These tests are self-contained: they drive the generator against a minimal
in-memory alphabet.py fixture rather than the real
``apps/training/model/alphabet.py``. This keeps the test suite runnable on
branches where PR-Y1.4b is not yet merged.

Every behaviour the CI job ``alphabet-mirror-sync`` relies on is covered here:

  - A clean codegen produces a TS file and a JSON fixture whose SHAs agree
    with the Python module's ``ALPHABET_SHA``.
  - ``--check-only`` returns 0 when the files on disk match.
  - ``--check-only`` returns 2 when the TS file has been modified.
  - ``--check-only`` returns 2 when the JSON fixture has been modified.
  - ``--check-only`` returns 2 when either file has been deleted.
  - ``--check-only`` returns 2 when the ``ALPHABET_SHA`` literal in the TS
    file has been hand-edited (even if the labels still match).
  - The cross-validation refuses to emit when the Python module's own
    ``ALPHABET_SHA`` does not match the recomputed one (catches a Python-side
    label change that forgot to update the SHA).
  - The generator also emits against the real ``apps/training/model/alphabet.py``
    when it is present (skipped on branches where PR-Y1.4b has not landed).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
CODEGEN = REPO_ROOT / "scripts" / "codegen_alphabet.py"
assert CODEGEN.is_file(), f"codegen script not found at {CODEGEN}"

# A minimal fixture alphabet.py — same symbol surface as the real one (which
# the generator imports by reflection), but with just enough labels that the
# emitted TS/JSON are tractable to compare.
FIXTURE_ALPHABET = '''"""Minimal alphabet fixture used by test_codegen_alphabet.

Mirrors the symbol surface of apps/training/model/alphabet.py: ROOTS,
QUALITY_LABELS, BASS_LABELS, QUALITIES, LABELS, QUALITY_N_INDEX,
BASS_SAME_INDEX, BASS_N_INDEX, N_INDEX, X_INDEX, ALPHABET_SHA.
"""

from __future__ import annotations

import hashlib
import json

ROOTS = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

QUALITY_LABELS = (
    "maj", "min", "dim", "aug", "sus2", "sus4",
    "maj6", "min6", "maj7", "min7", "7", "dim7", "hdim7", "minmaj7",
    "maj9", "min9", "9", "11", "13",
    "add9", "add11", "5", "add6", "aug7",
    "N",
)
assert len(QUALITY_LABELS) == 25
QUALITY_N_INDEX = 24

BASS_LABELS = tuple(["same"] + [str(i) for i in range(1, 12)] + ["N"])
assert len(BASS_LABELS) == 13
BASS_SAME_INDEX = 0
BASS_N_INDEX = 12

QUALITIES = ("maj", "min", "dim", "aug", "sus")


def _build_flat_labels():
    labels = []
    for r in ROOTS:
        for q in QUALITIES:
            labels.append(f"{r}:{q}")
    labels.append("N")
    labels.append("X")
    return labels


LABELS = tuple(_build_flat_labels())
NUM_CHORD_LABELS = 60
NUM_LABELS = 62
N_INDEX = NUM_CHORD_LABELS
X_INDEX = NUM_CHORD_LABELS + 1


def _compute_alphabet_sha() -> str:
    payload = json.dumps(
        {
            "version": "y1-v1.5-factored",
            "roots": list(ROOTS),
            "quality_labels": list(QUALITY_LABELS),
            "bass_labels": list(BASS_LABELS),
            "quality_n_index": QUALITY_N_INDEX,
            "bass_same_index": BASS_SAME_INDEX,
            "bass_n_index": BASS_N_INDEX,
            "legacy_qualities": list(QUALITIES),
            "legacy_labels": list(LABELS),
            "legacy_n_index": N_INDEX,
            "legacy_x_index": X_INDEX,
        },
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


ALPHABET_SHA = _compute_alphabet_sha()
'''


def _run_codegen(
    source: Path,
    ts_out: Path,
    json_out: Path,
    *extra_args: str,
) -> subprocess.CompletedProcess:
    """Invoke the codegen via subprocess so we exercise the real CLI."""
    return subprocess.run(
        [
            sys.executable,
            str(CODEGEN),
            "--from",
            str(source),
            "--ts-out",
            str(ts_out),
            "--json-out",
            str(json_out),
            *extra_args,
        ],
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.fixture
def workspace(tmp_path: Path) -> dict[str, Path]:
    """A fresh workspace with the minimal fixture alphabet.py."""
    source = tmp_path / "alphabet.py"
    source.write_text(FIXTURE_ALPHABET, encoding="utf-8")
    return {
        "source": source,
        "ts_out": tmp_path / "alphabet.ts",
        "json_out": tmp_path / "alphabet.v1.5.json",
    }


def test_codegen_emits_both_files(workspace: dict[str, Path]) -> None:
    """A clean generate writes a TS file and a JSON fixture with matching SHAs."""
    result = _run_codegen(workspace["source"], workspace["ts_out"], workspace["json_out"])
    assert result.returncode == 0, result.stderr
    assert workspace["ts_out"].is_file()
    assert workspace["json_out"].is_file()

    ts = workspace["ts_out"].read_text(encoding="utf-8")
    assert "AUTOGENERATED FROM apps/training/model/alphabet.py" in ts
    assert "export const ALPHABET_SHA =" in ts
    assert "export const QUALITY_LABELS" in ts
    assert "export const BASS_LABELS" in ts
    assert "export const ROOTS" in ts
    assert "export function encodeFactored" in ts
    assert "export function decodeFactored" in ts
    assert "export function isValidHarte" in ts
    assert "export async function assertAlphabetSha" in ts
    assert "AlphabetDriftError" in ts

    fixture = json.loads(workspace["json_out"].read_text(encoding="utf-8"))
    assert fixture["alphabet_version"] == "y1-v1.5-factored"
    assert len(fixture["roots"]) == 12
    assert len(fixture["quality_labels"]) == 25
    assert len(fixture["bass_labels"]) == 13
    # TS and JSON SHAs must agree on the same value.
    import re

    m = re.search(r'export\s+const\s+ALPHABET_SHA\s*=\s*"([^"]+)"', ts)
    assert m is not None
    assert m.group(1) == fixture["alphabet_sha"]


def test_check_only_passes_on_match(workspace: dict[str, Path]) -> None:
    _run_codegen(workspace["source"], workspace["ts_out"], workspace["json_out"])
    result = _run_codegen(
        workspace["source"],
        workspace["ts_out"],
        workspace["json_out"],
        "--check-only",
    )
    assert result.returncode == 0, result.stderr
    assert "in sync" in result.stdout


def test_check_only_fails_when_ts_modified(workspace: dict[str, Path]) -> None:
    _run_codegen(workspace["source"], workspace["ts_out"], workspace["json_out"])
    # Append a stray line to the TS file.
    workspace["ts_out"].write_text(
        workspace["ts_out"].read_text(encoding="utf-8") + "// stray edit\n",
        encoding="utf-8",
    )
    result = _run_codegen(
        workspace["source"],
        workspace["ts_out"],
        workspace["json_out"],
        "--check-only",
    )
    assert result.returncode == 2
    assert "out of sync" in result.stderr


def test_check_only_fails_when_json_modified(workspace: dict[str, Path]) -> None:
    _run_codegen(workspace["source"], workspace["ts_out"], workspace["json_out"])
    # Mutate the JSON.
    data = json.loads(workspace["json_out"].read_text(encoding="utf-8"))
    data["roots"] = list(reversed(data["roots"]))
    workspace["json_out"].write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    result = _run_codegen(
        workspace["source"],
        workspace["ts_out"],
        workspace["json_out"],
        "--check-only",
    )
    assert result.returncode == 2


def test_check_only_fails_when_file_missing(workspace: dict[str, Path]) -> None:
    _run_codegen(workspace["source"], workspace["ts_out"], workspace["json_out"])
    workspace["ts_out"].unlink()
    result = _run_codegen(
        workspace["source"],
        workspace["ts_out"],
        workspace["json_out"],
        "--check-only",
    )
    assert result.returncode == 2
    assert "missing" in result.stderr


def test_check_only_fails_on_hand_edited_sha(workspace: dict[str, Path]) -> None:
    """The TS file's ALPHABET_SHA was hand-edited; everything else matches."""
    _run_codegen(workspace["source"], workspace["ts_out"], workspace["json_out"])
    ts_text = workspace["ts_out"].read_text(encoding="utf-8")
    # Replace the SHA literal with a bogus 64-hex. The rest of the file is
    # unchanged, but the codegen's parse_ts_sha pass should catch this.
    import re

    bogus = "0" * 64
    ts_text_mutated = re.sub(
        r'(export\s+const\s+ALPHABET_SHA\s*=\s*)"[^"]+"',
        r'\1"' + bogus + '"',
        ts_text,
        count=1,
    )
    # This file, with a bogus SHA, is no longer a valid re-run of codegen —
    # so it will fail the "bytes equal" check first. Verify that still trips.
    workspace["ts_out"].write_text(ts_text_mutated, encoding="utf-8")
    result = _run_codegen(
        workspace["source"],
        workspace["ts_out"],
        workspace["json_out"],
        "--check-only",
    )
    assert result.returncode == 2


def test_cross_validation_catches_mismatched_python_sha(tmp_path: Path) -> None:
    """A Python alphabet.py whose ALPHABET_SHA constant is stale fails codegen."""
    source = tmp_path / "alphabet.py"
    # Fixture alphabet with a hardcoded wrong SHA.
    bad_fixture = FIXTURE_ALPHABET.replace(
        "ALPHABET_SHA = _compute_alphabet_sha()",
        'ALPHABET_SHA = "0" * 64  # intentionally stale',
    )
    source.write_text(bad_fixture, encoding="utf-8")
    ts_out = tmp_path / "alphabet.ts"
    json_out = tmp_path / "alphabet.v1.5.json"
    result = _run_codegen(source, ts_out, json_out)
    assert result.returncode != 0
    assert "does not match the SHA recomputed from its label lists" in result.stderr


def test_codegen_runs_against_real_alphabet_if_present() -> None:
    """When PR-Y1.4b is merged, the real alphabet.py is on disk and emits cleanly."""
    real = REPO_ROOT / "apps" / "training" / "model" / "alphabet.py"
    if not real.is_file():
        pytest.skip("apps/training/model/alphabet.py not on this branch (PR-Y1.4b not merged)")
    ts_target = REPO_ROOT / "apps" / "web" / "src" / "chord" / "alphabet.ts"
    json_target = REPO_ROOT / "apps" / "web" / "public" / "alphabet.v1.5.json"
    result = subprocess.run(
        [sys.executable, str(CODEGEN), "--check-only"],
        capture_output=True,
        text=True,
        check=False,
        cwd=REPO_ROOT,
    )
    assert result.returncode == 0, (
        f"codegen_alphabet --check-only failed against the real alphabet.py. "
        f"stdout={result.stdout!r} stderr={result.stderr!r}"
    )
    assert ts_target.is_file()
    assert json_target.is_file()
