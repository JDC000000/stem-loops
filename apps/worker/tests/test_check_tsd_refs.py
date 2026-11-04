"""Unit tests for scripts/check_tsd_refs.py (Fleet Playbook Move 4 CI gate).

The script extracts every `TSD §N.M` reference from a PR body and verifies
each one resolves to a heading in `04-tsd-and-workplan/**/*.md`. These tests
build a temporary TSD directory per case (so they don't depend on the real
04-tsd-and-workplan/ content drifting), then drive the script's `main()`
through stdin + the `--tsd-dir` flag.
"""

from __future__ import annotations

import importlib.util
import io
import sys
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "check_tsd_refs.py"
_spec = importlib.util.spec_from_file_location("check_tsd_refs", _SCRIPT)
assert _spec is not None and _spec.loader is not None  # for type-checker
check_tsd_refs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_tsd_refs)


# ---- Pure-function tests (extract_refs / find_heading) ----------------------


def test_extract_refs_simple():
    body = "Implements TSD §1.2a and TSD §3.1 cleanly."
    assert check_tsd_refs.extract_refs(body) == ["1.2a", "3.1"]


def test_extract_refs_section_symbol_optional():
    # `§` is optional — both `TSD §1.2a` and `TSD 1.2a` count.
    body = "Per TSD 1.2a (no section char) and TSD §4.5."
    assert check_tsd_refs.extract_refs(body) == ["1.2a", "4.5"]


def test_extract_refs_nested_sections():
    # Edge: nested sections like §1.2.3.4a.
    body = "Deep ref TSD §1.2.3.4a works."
    assert check_tsd_refs.extract_refs(body) == ["1.2.3.4a"]


def test_extract_refs_deduplicates_preserving_order():
    body = "TSD §1.2a, TSD §3.1, TSD §1.2a again."
    assert check_tsd_refs.extract_refs(body) == ["1.2a", "3.1"]


def test_extract_refs_empty_body():
    assert check_tsd_refs.extract_refs("") == []


def test_extract_refs_no_tsd_mentions():
    # §1.2a on its own, without the `TSD` lead-in, is NOT a reference.
    assert check_tsd_refs.extract_refs("See §1.2a or section 1.2.") == []


def test_extract_refs_handles_utf8_section_symbol(tmp_path: Path):
    # Real U+00A7 round-trips cleanly through a UTF-8 file.
    pr = tmp_path / "body.md"
    pr.write_text("fixes TSD §1.2a", encoding="utf-8")
    body = pr.read_text(encoding="utf-8")
    assert check_tsd_refs.extract_refs(body) == ["1.2a"]


# ---- Heading-matcher: flexible match across the three required shapes -------


@pytest.mark.parametrize(
    "heading",
    [
        "## 1.2a Processor Separation",
        "### §1.2a",
        "#### 1.2a — Processor Separation",
        "# 1.2a",
        "###### 1.2a - something",
        "## §1.2a Processor Separation",
    ],
)
def test_find_heading_accepts_common_shapes(tmp_path: Path, heading: str):
    (tmp_path / "doc.md").write_text(f"{heading}\nbody\n", encoding="utf-8")
    assert check_tsd_refs.find_heading("1.2a", tmp_path) is True


def test_find_heading_rejects_prefix_collision(tmp_path: Path):
    # A heading for `1.20` must not resolve a `1.2` reference.
    (tmp_path / "doc.md").write_text("## 1.20 Twenty\n", encoding="utf-8")
    assert check_tsd_refs.find_heading("1.2", tmp_path) is False


def test_find_heading_rejects_letter_suffix_collision(tmp_path: Path):
    # A heading for `1.2ab` must not resolve a `1.2a` reference.
    (tmp_path / "doc.md").write_text("## 1.2ab Something\n", encoding="utf-8")
    assert check_tsd_refs.find_heading("1.2a", tmp_path) is False


def test_find_heading_walks_subdirectories(tmp_path: Path):
    nested = tmp_path / "sub" / "deep"
    nested.mkdir(parents=True)
    (nested / "x.md").write_text("### 3.1 Deep heading\n", encoding="utf-8")
    assert check_tsd_refs.find_heading("3.1", tmp_path) is True


def test_find_heading_ignores_non_markdown(tmp_path: Path):
    (tmp_path / "x.txt").write_text("## 1.2a not markdown\n", encoding="utf-8")
    assert check_tsd_refs.find_heading("1.2a", tmp_path) is False


def test_find_heading_ignores_section_number_in_body_only(tmp_path: Path):
    (tmp_path / "x.md").write_text(
        "# Doc\nSee §1.2a in the body, but no heading.\n",
        encoding="utf-8",
    )
    assert check_tsd_refs.find_heading("1.2a", tmp_path) is False


# ---- main() end-to-end: happy / failure / zero-refs -------------------------


def _run_main(monkeypatch, body: str, tsd_dir: Path) -> int:
    """Pipe `body` through stdin and invoke main() with --tsd-dir."""

    monkeypatch.setattr(sys, "stdin", io.StringIO(body))
    return check_tsd_refs.main(["--tsd-dir", str(tsd_dir)])


def test_main_happy_path_exit_zero(tmp_path: Path, monkeypatch, capsys):
    (tmp_path / "tsd.md").write_text("## 1.2a Processor Separation\n", encoding="utf-8")
    rc = _run_main(monkeypatch, "fixes TSD §1.2a cleanly", tmp_path)
    out = capsys.readouterr().out
    assert rc == 0
    assert out == ""  # no failure messages


def test_main_failure_path_exit_one_with_message(tmp_path: Path, monkeypatch, capsys):
    # Empty TSD dir → every reference fails.
    (tmp_path / "empty.md").write_text("# nothing here\n", encoding="utf-8")
    rc = _run_main(monkeypatch, "touches TSD §99.99 which is fake", tmp_path)
    out = capsys.readouterr().out
    assert rc == 1
    assert "PR references TSD §99.99 but no heading found in 04-tsd-and-workplan/" in out


def test_main_zero_refs_exit_zero(tmp_path: Path, monkeypatch, capsys):
    # No TSD references at all → exit 0 regardless of TSD dir contents.
    (tmp_path / "x.md").write_text("# unrelated\n", encoding="utf-8")
    rc = _run_main(monkeypatch, "plain PR body with no TSD mentions", tmp_path)
    assert rc == 0
    assert capsys.readouterr().out == ""


def test_main_empty_body_exit_zero(tmp_path: Path, monkeypatch, capsys):
    # Totally empty body is still legal (gh pr view can return empty on draft).
    rc = _run_main(monkeypatch, "", tmp_path)
    assert rc == 0
    assert capsys.readouterr().out == ""


def test_main_unicode_section_symbol_handled(tmp_path: Path, monkeypatch, capsys):
    # The `§` (U+00A7) character must round-trip cleanly through stdin.
    (tmp_path / "tsd.md").write_text("## 1.2a Processor\n", encoding="utf-8")
    rc = _run_main(monkeypatch, "per TSD §1.2a", tmp_path)
    assert rc == 0
    assert capsys.readouterr().out == ""


def test_main_nested_section_resolves(tmp_path: Path, monkeypatch, capsys):
    (tmp_path / "tsd.md").write_text(
        "### 1.2.3.4a Nested leaf heading\n",
        encoding="utf-8",
    )
    rc = _run_main(monkeypatch, "TSD §1.2.3.4a is covered", tmp_path)
    assert rc == 0
    assert capsys.readouterr().out == ""


def test_main_multiple_refs_partial_failure(tmp_path: Path, monkeypatch, capsys):
    # One ref resolves, one doesn't: exit 1, print only the failing line.
    (tmp_path / "tsd.md").write_text("## 1.2a OK\n", encoding="utf-8")
    rc = _run_main(
        monkeypatch,
        "mix TSD §1.2a (good) and TSD §9.9 (bad)",
        tmp_path,
    )
    out = capsys.readouterr().out
    assert rc == 1
    assert "TSD §9.9" in out
    assert "TSD §1.2a" not in out  # the resolved one is silent


def test_main_missing_tsd_dir_with_zero_refs_exit_zero(tmp_path: Path, monkeypatch, capsys):
    # No refs + no TSD dir → still fine (edge: fresh checkout, no workplan yet).
    bogus = tmp_path / "does-not-exist"
    rc = _run_main(monkeypatch, "no refs here", bogus)
    assert rc == 0


def test_main_missing_tsd_dir_with_refs_exit_one(tmp_path: Path, monkeypatch, capsys):
    bogus = tmp_path / "does-not-exist"
    rc = _run_main(monkeypatch, "TSD §1.2a somewhere", bogus)
    assert rc == 1


# ---- Realistic PR body (shape CI will actually see) -------------------------


def test_main_realistic_pr_body(tmp_path: Path, monkeypatch, capsys):
    (tmp_path / "tsd.md").write_text(
        "# TSD\n\n"
        "## 1.2a Processor Separation\n\n"
        "### §3.1 Decoder architecture\n\n"
        "#### 1.2.3.4a — nested leaf\n",
        encoding="utf-8",
    )
    body = (
        "## Summary\n\n"
        "Implements the paid-tier split per TSD §1.2a.\n\n"
        "Engine portion per TSD §3.1; nested invariant per TSD §1.2.3.4a.\n\n"
        "No new scope.\n"
    )
    rc = _run_main(monkeypatch, body, tmp_path)
    assert rc == 0
    assert capsys.readouterr().out == ""
