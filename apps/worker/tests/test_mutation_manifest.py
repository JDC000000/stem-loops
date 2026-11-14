"""The mutation manifest must stay true to the code it mutates (fast; no mutant is run here).

`tests/mutation/manifest.py` turns this PR's "test X kills mutant Y" sentences into data, and
`tests/mutation/run_mutants.py` runs them (about 15-40 s each, not part of the normal suite).
This file is the cheap half that DOES run in the normal suite, and is what stops the manifest
rotting: it fails when an anchor no longer occurs exactly once (the code moved, so the entry no
longer tests what it says), when a mutant does not compile, when an id repeats, or when a named
killer test does not exist. It does not prove that any mutant dies; only the runner does.

It also tests the runner's CLASSIFICATION, because a kill that is really a crash is the mistake
round 3 made (13 failures, 12 of them crashes): a mutant killed by an ImportError says nothing
about the test that was meant to catch it.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from tests.mutation.manifest import MUTANTS, SURVIVORS
from tests.mutation.run_mutants import classify_junit, node_matches, root_of, verdict

ENTRIES = [(m, "KILL") for m in MUTANTS] + [(s, "SURVIVE") for s in SURVIVORS]


def _ids(entries):
    return [m.id for m, _ in entries]


def test_ids_are_unique():
    ids = _ids(ENTRIES)
    assert len(ids) == len(set(ids)), sorted({i for i in ids if ids.count(i) > 1})


@pytest.mark.parametrize("entry", ENTRIES, ids=_ids(ENTRIES))
def test_the_anchor_occurs_exactly_once_and_the_mutant_compiles(entry):
    spec, _ = entry
    path = root_of(spec.suite) / spec.file
    text = path.read_text()
    n = text.count(spec.anchor)
    assert n == 1, (
        f"{spec.id}: anchor occurs {n} times in {spec.file}; the code moved, so this entry no "
        "longer mutates what its claim says. Re-anchor it, then run tests/mutation/run_mutants.py."
    )
    assert spec.replacement != spec.anchor
    if spec.file.endswith(".py"):
        compile(text.replace(spec.anchor, spec.replacement), spec.file, "exec")


def _defined_tests(py: Path) -> set[str]:
    tree = ast.parse(py.read_text())
    return {
        n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


@pytest.mark.parametrize("entry", ENTRIES, ids=_ids(ENTRIES))
def test_every_named_killer_exists(entry):
    spec, _ = entry
    killers = tuple(getattr(spec, "killers", ())) or tuple(spec.tests)
    assert killers, f"{spec.id} names no test"
    for node in killers:
        path, _, name = node.partition("::")
        if spec.suite == "web":
            src = (root_of("web") / path).read_text()
            assert re.search(
                r"test\(\s*'" + re.escape(name), src
            ), f"{spec.id}: no web test starts {name!r}"
        else:
            f = root_of("worker") / path
            assert f.exists(), f"{spec.id}: {path} does not exist"
            if name:  # a bare file or directory ("tests/") means "everything in it"
                assert name.split("[", 1)[0] in _defined_tests(
                    f
                ), f"{spec.id}: {path} has no test {name!r}"


# ------------------------------------------------- the runner's own classification


def _junit(*cases: str) -> str:
    return "<testsuites><testsuite>" + "".join(cases) + "</testsuite></testsuites>"


PASS = '<testcase classname="tests.test_x" name="test_a"/>'
ASSERT = (
    '<testcase classname="tests.test_x" name="test_a"><failure message="assert 1 == 2">t</failure>'
    "</testcase>"
)
CRASH = (
    '<testcase classname="tests.test_x" name="test_a"><failure message="psycopg.OperationalError: '
    'connection refused">t</failure></testcase>'
)
SETUP_ERROR = '<testcase classname="tests.test_x" name="test_a"><error message="ImportError">t</error></testcase>'
XFAIL = '<testcase classname="tests.test_x" name="test_a"><skipped message="xfail"/></testcase>'
KILLERS = ("tests/test_x.py::test_a",)


@pytest.mark.parametrize(
    "case, want",
    [
        (PASS, "SURVIVED"),
        (ASSERT, "KILLED"),
        (CRASH, "CRASH"),
        (SETUP_ERROR, "CRASH"),
        (XFAIL, "SURVIVED"),
    ],
)
def test_only_a_clean_assertion_failure_is_a_kill(case, want):
    assert verdict(KILLERS, classify_junit(_junit(case))) == want


def test_pytest_fail_counts_as_a_clean_failure_but_an_unrelated_test_does_not_count():
    failed = '<testcase classname="tests.test_x" name="test_a"><failure message="Failed: REGRESSED">t</failure></testcase>'
    other = '<testcase classname="tests.test_x" name="test_b"><failure message="assert 0">t</failure></testcase>'
    assert verdict(KILLERS, classify_junit(_junit(failed))) == "KILLED"
    assert verdict(KILLERS, classify_junit(_junit(PASS, other))) == "SURVIVED"
    assert verdict(KILLERS, classify_junit(_junit(other))) == "MISSING"


def test_a_parametrized_test_matches_its_node_id():
    assert node_matches("tests/test_x.py::test_a", "tests.test_x::test_a[case-1]")
    assert not node_matches("tests/test_x.py::test_a", "tests.test_x::test_ab")
