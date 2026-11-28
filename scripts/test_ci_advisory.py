"""Offline tests for scripts/ci_advisory.py (the advisory CI jobs, Jon L7). Stdlib unittest; uses this repo's scripts/or4-merge.sh
as the gate (library mode) and a throwaway mutation manifest. Run: python3 -m unittest scripts/test_ci_advisory.py
"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = HERE / "ci_advisory.py"
GATE = HERE / "or4-merge.sh"
sys.path.insert(0, str(HERE))
import ci_advisory as ca  # noqa: E402

MANIFEST = textwrap.dedent('''
    from dataclasses import dataclass, field

    @dataclass(frozen=True)
    class Mutant:
        id: str
        file: str
        anchor: str
        replacement: str
        killers: tuple
        claim: str
        suite: str = "worker"
        env: dict = field(default_factory=dict, hash=False, compare=False)

    MUTANTS = [
        Mutant("cl-1", "src/worker/cleanup.py", "a", "b", ("t",), "c"),
        Mutant("cl-2", "src/worker/cleanup.py", "a", "b", ("t",), "c"),
        Mutant("co-1", "src/worker/consumer.py", "a", "b", ("t",), "c"),
        Mutant("hl-1", "src/worker/health.py", "a", "b", ("t",), "c"),
        Mutant("web-1", "src/lib/billing/providers/stripe.ts", "a", "b", ("t",), "c", suite="web"),
    ]
    SURVIVORS = [Mutant("cl-s", "src/worker/cleanup.py", "a", "b", ("t",), "c")]
''')


def nul(*paths):
    return ("\0".join(paths) + ("\0" if paths else "")).encode()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.worker = self.tmp / "apps" / "worker"
        (self.worker / "tests" / "mutation").mkdir(parents=True)
        (self.worker / "tests" / "mutation" / "manifest.py").write_text(MANIFEST)
        self._cwd = os.getcwd()
        self.addCleanup(os.chdir, self._cwd)

    def run_cli(self, *args):
        return subprocess.run([sys.executable, "-I", str(TOOL), *args], capture_output=True, text=True, timeout=120, cwd=self.tmp)

    def write(self, name, data):
        p = self.tmp / name
        p.write_bytes(data) if isinstance(data, bytes) else p.write_text(data)
        return str(p)


class Classify(Base):
    def test_money(self):
        cls, md = ca.classify(nul("apps/web/src/app/api/billing/webhook/route.ts", "docs/x.md"), str(GATE), None)
        self.assertEqual(cls, "money")
        self.assertIn("**money**", md[0])
        self.assertIn("- `apps/web/src/app/api/billing/webhook/route.ts`", md)

    def test_protected_not_money(self):
        cls, _ = ca.classify(nul(".github/workflows/ci.yml"), str(GATE), None)
        self.assertEqual(cls, "protected")

    def test_standard(self):
        cls, md = ca.classify(nul("docs/x.md", "apps/web/src/components/Button.tsx"), str(GATE), None)
        self.assertEqual(cls, "standard")
        self.assertIn("2 changed path(s) · 0 money · 0 protected", "\n".join(md))

    def test_billing_title_raises_to_money(self):
        t = self.write("t.json", json.dumps({"title": "[billing] fix copy"}))
        self.assertEqual(ca.classify(nul("docs/x.md"), str(GATE), t)[0], "money")
        t2 = self.write("t2.json", json.dumps({"title": "fix copy"}))
        self.assertEqual(ca.classify(nul("docs/x.md"), str(GATE), t2)[0], "standard")

    def test_unparsable_title_fails_closed_to_money(self):
        t = self.write("t.json", "{not json")
        self.assertEqual(ca.classify(nul("docs/x.md"), str(GATE), t)[0], "money")

    def test_non_ascii_path_is_money(self):
        self.assertEqual(ca.classify(nul("docs/ﬁle.md"), str(GATE), None)[0], "money")

    def test_backtick_in_path_cannot_break_markdown_code(self):
        _, md = ca.classify(nul("apps/web/billing`x.ts"), str(GATE), None)
        self.assertTrue(any("billingˋx.ts" in line for line in md), md)

    def test_cli_always_exits_0_even_on_missing_gate(self):
        f = self.write("f0", nul("docs/x.md"))
        p = self.run_cli("classify", "--files", f, "--gate", str(self.tmp / "nope.sh"))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("could not run", p.stdout)

    def test_cli_usage_error_is_2(self):
        self.assertEqual(self.run_cli("classify").returncode, 2)


class Shared(Base):
    def test_overlap_listed_self_skipped(self):
        md = "\n".join(ca.shared(["a.ts", "b.md"], {"500": ["a.ts"], "501": ["a.ts", "z"], "502": ["z"], "x": ["a.ts"]}, "500"))
        self.assertIn("**#501**: `a.ts`", md)
        self.assertNotIn("#500", md)
        self.assertNotIn("#502", md)
        self.assertNotIn("#x", md)

    def test_no_overlap(self):
        md = "\n".join(ca.shared(["a.ts"], {"501": ["b.ts"]}, "500"))
        self.assertIn("No other open PR changes a file", md)

    def test_cli_bad_json_exits_0(self):
        mine = self.write("mine", "a.ts\n")
        oth = self.write("oth", "[1,2]")
        p = self.run_cli("shared", "--mine", mine, "--others", oth, "--pr", "500")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("could not run", p.stdout)


class Mutants(Base):
    def test_selects_worker_entries_on_changed_money_files(self):
        os.chdir(self.tmp)
        ids, md = ca.select_mutants(nul("apps/worker/src/worker/cleanup.py", "apps/worker/src/worker/consumer.py", "docs/x.md"),
                                    str(GATE), "apps/worker", 12)
        self.assertEqual(ids, ["cl-1", "cl-2", "co-1", "cl-s"])
        self.assertIn("running 4", md[2])

    def test_cap_and_gap_and_web_note(self):
        os.chdir(self.tmp)
        ids, md = ca.select_mutants(nul("apps/worker/src/worker/cleanup.py", "apps/worker/src/worker/reaper.py",
                                        "apps/web/src/lib/billing/providers/stripe.ts"), str(GATE), "apps/worker", 2)
        self.assertEqual(ids, ["cl-1", "cl-2"])
        text = "\n".join(md)
        self.assertIn("(capped at 2)", text)
        self.assertIn("- `apps/worker/src/worker/reaper.py`", text)  # money (reaper) with no entry → gap
        self.assertIn("not run by this job", text)
        self.assertNotIn("- `apps/worker/src/worker/cleanup.py`", text.split("coverage gap")[-1])

    def test_non_money_change_selects_nothing(self):
        os.chdir(self.tmp)
        ids, md = ca.select_mutants(nul("apps/worker/src/worker/health.py"), str(GATE), "apps/worker", 12)
        self.assertEqual(ids, [])  # health.py is not a MONEY_RE path, so its manifest mutant is not selected
        self.assertIn("No money path changed", "\n".join(md))

    def test_cli_writes_ids_and_empty_on_error(self):
        f = self.write("f0", nul("apps/worker/src/worker/consumer.py"))
        out = self.tmp / "ids.txt"
        p = self.run_cli("mutants", "--files", f, "--gate", str(GATE), "--worker", "apps/worker", "--ids-out", str(out))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(out.read_text(), "co-1")
        p = self.run_cli("mutants", "--files", f, "--gate", str(GATE), "--worker", "nope", "--ids-out", str(out))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(out.read_text(), "")
        self.assertIn("could not run", p.stdout)


class RealManifest(unittest.TestCase):
    def test_repo_manifest_loads_and_consumer_is_selected(self):
        cwd = os.getcwd()
        try:
            os.chdir(HERE.parent)
            ids, _ = ca.select_mutants(nul("apps/worker/src/worker/consumer.py"), str(GATE), "apps/worker", 100)
        finally:
            os.chdir(cwd)
        self.assertGreater(len(ids), 0)


if __name__ == "__main__":
    unittest.main()
