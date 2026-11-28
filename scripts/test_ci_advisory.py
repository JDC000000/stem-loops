"""Offline tests for scripts/ci_advisory.py (the advisory CI jobs, Jon L7). Stdlib unittest; uses this repo's scripts/or4-merge.sh
as the gate (library mode) and a throwaway mutation manifest. Run: python3 -m unittest scripts/test_ci_advisory.py
"""
import json
import os
import re
import stat
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

    def test_empty_file_list_is_unknown_not_standard(self):  # R1 sonnet B2
        cls, md = ca.classify(b"", str(GATE), None)
        self.assertEqual(cls, "unknown")
        self.assertNotIn("standard", "\n".join(md))

    def test_cli_always_exits_0_even_on_missing_gate(self):
        f = self.write("f0", nul("docs/x.md"))
        p = self.run_cli("classify", "--files", f, "--gate", str(self.tmp / "nope.sh"))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("could not run", p.stdout)

    def test_cli_usage_error_is_2(self):
        self.assertEqual(self.run_cli("classify").returncode, 2)


class Limits(Base):
    """R1 fable N8: pin the caps and the worker-suite filter."""
    def test_max_list_truncates(self):
        paths = [f"apps/web/billing/{i}.ts" for i in range(ca.MAX_LIST + 5)]
        _, md = ca.classify(nul(*paths), str(GATE), None)
        self.assertEqual(md.count("- … and 5 more"), 2)  # money and protected sections (billing is in both regexes)
        self.assertEqual(sum(1 for line in md if line.startswith("- `apps/web/billing/")), ca.MAX_LIST * 2)

    def test_shared_caps_20_files_per_pr(self):
        files = [f"f{i:02}" for i in range(25)]
        md = "\n".join(ca.shared(files, {"501": files}, "500"))
        self.assertIn("`f19`", md)
        self.assertNotIn("`f20`", md)
        self.assertIn("… +5", md)

    def test_web_suite_entry_never_selected(self):
        os.chdir(self.tmp)
        ids, _ = ca.select_mutants(nul("apps/worker/src/lib/billing/providers/stripe.ts",
                                       "apps/web/src/lib/billing/providers/stripe.ts"), str(GATE), "apps/worker", 12)
        self.assertNotIn("web-1", ids)

    def test_negative_max_selects_nothing(self):  # #515: cleanup.py has 3 entries, so an unclamped chosen[:-1] keeps 2
        os.chdir(self.tmp)
        files = nul("apps/worker/src/worker/cleanup.py")
        self.assertEqual(len(ca.select_mutants(files, str(GATE), "apps/worker", 12)[0]), 3)
        self.assertEqual(ca.select_mutants(files, str(GATE), "apps/worker", -1)[0], [])
        f = self.write("f0", files)
        out = self.tmp / "ids.txt"
        p = self.run_cli("mutants", "--files", f, "--gate", str(GATE), "--worker", "apps/worker", "--max", "-1", "--ids-out", str(out))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(out.read_text(), "")


class Workflow(unittest.TestCase):
    """R1 fable N8: pin the workflow-shell invariants of the three advisory jobs. Plain-text parse (stdlib only: the CI step
    that runs this file installs nothing and allows no skips)."""
    @classmethod
    def setUpClass(cls):
        text = (HERE.parent / ".github" / "workflows" / "ci.yml").read_text()
        cls.adv = text.split("\n  advisory-pr-class:", 1)[1]
        cls.jobs = {}
        name = "advisory-pr-class"
        for line in ("  advisory-pr-class:" + cls.adv).splitlines():
            if line.startswith("  ") and not line.startswith("   ") and line.rstrip().endswith(":") and not line.lstrip().startswith("#"):
                name = line.strip()[:-1]
            cls.jobs.setdefault(name, []).append(line)
        cls.jobs = {k: "\n".join(v) for k, v in cls.jobs.items() if k.startswith("advisory-")}

    @staticmethod
    def run_blocks(job):
        out, cur, ind = [], None, None
        for line in job.splitlines():
            if cur is not None:
                if line.strip() == "" or (len(line) - len(line.lstrip())) > ind:
                    cur.append(line); continue
                out.append("\n".join(cur)); cur = None
            if line.strip() == "run: |":
                cur, ind = [], len(line) - len(line.lstrip())
        if cur is not None:
            out.append("\n".join(cur))
        return out

    def test_three_jobs_read_only_pull_request_only(self):
        self.assertEqual(sorted(self.jobs), ["advisory-diff-mutants", "advisory-pr-class", "advisory-shared-files"])
        for name, job in self.jobs.items():
            self.assertIn("if: github.event_name == 'pull_request'", job, name)
            self.assertIn("    permissions:\n      contents: read", job, name)
            self.assertNotIn("write", "\n".join(l for l in job.splitlines() if not l.lstrip().startswith("#")), name)
            self.assertEqual(job.count("uses: "), job.count("continue-on-error: true"), name)

    def test_every_run_block_ends_exit_0_and_has_no_expression(self):
        n = 0
        for name, job in self.jobs.items():
            for blk in self.run_blocks(job):
                n += 1
                self.assertEqual(blk.strip().splitlines()[-1].strip(), "exit 0", (name, blk[:80]))
                self.assertNotIn("${{", blk, name)
                if "set -u" in blk:
                    self.assertIn("set -u +e +o pipefail", blk, name)
        self.assertGreaterEqual(n, 5)

    def test_diffs_use_no_renames(self):
        self.assertNotIn("git diff --name-only", self.adv)
        self.assertGreaterEqual(self.adv.count("git diff --no-renames --name-only"), 2)

    def test_every_gh_api_call_has_a_timeout(self):  # #515 (R2 fable N1): an unbounded call would also lower the budget sum
        calls = re.findall(r"(\S+ \S+ )?gh api", self.adv)
        self.assertGreaterEqual(len(calls), 3)
        self.assertEqual(len(re.findall(r"\btimeout \d+ gh api", self.adv)), len(calls), calls)

    def test_run_steps_are_blocks_with_one_strict_mode_line(self):  # #515: no one-line run:, no set -e / -o pipefail back
        for name, job in self.jobs.items():
            for line in job.splitlines():
                if re.match(r"\s*(- )?run:", line):
                    self.assertEqual(line.split("run:", 1)[1].strip(), "|", (name, line))
            for blk in self.run_blocks(job):
                lines = [l.strip() for l in blk.splitlines() if l.strip()]
                self.assertEqual(lines[0], "set -u +e +o pipefail", (name, lines[0]))
                self.assertEqual(re.findall(r"(?:^[ \t]*|[;&|{(][ \t]*)(set\s[^;\n]*)", blk, re.M), ["set -u +e +o pipefail"], name)
                self.assertNotIn("errexit", blk, name)

    def test_summary_appends_are_literal_or_capped(self):  # #515: a huge report cannot break the step
        n = 0
        for name, job in self.jobs.items():
            total = job.count('"$GITHUB_STEP_SUMMARY"')
            ok = re.findall(r'(?:echo "[^"$`]*"|head -c (\d+) "\$[A-Z_]+/[a-z0-9.]+") >> "\$GITHUB_STEP_SUMMARY"', job)
            self.assertEqual(len(ok), total, name)
            caps = [int(c) for c in ok if c]
            self.assertTrue(caps and all(c <= 200000 for c in caps), (name, caps))
            n += len(caps)
        self.assertEqual(n, 4)  # class, shared, select, mutant run

    def test_checkouts_keep_no_credentials_and_report_failure(self):  # #515
        for name, job in self.jobs.items():
            self.assertEqual(job.count("uses: actions/checkout@"), 1, name)
            self.assertIn("      - id: checkout\n        uses: actions/checkout@", job, name)
            self.assertRegex(job, r"\n          fetch-depth: 0\n          persist-credentials: false[ \n]", name)
            self.assertIn("          CHECKOUT: ${{ steps.checkout.outcome }}\n", job, name)

    def test_shared_files_wiring(self):  # #515 (R2 sonnet NB3, fable N1): $OPENFLAG / --unreadable shell half
        job = self.jobs["advisory-shared-files"]
        self.assertIn('OPENFLAG=""; UNREAD=""', job)
        self.assertRegex(job, r'pulls\?state=open[^\n]*\|\| \{ : > "\$T/open"; OPENFLAG=--open-unreadable; \}')
        self.assertRegex(job, r'pulls/\$n/files[^\n]*\|\| \{ UNREAD="\$UNREAD,\$n"; continue; \}')
        self.assertIn('$OPENFLAG --unreadable "${UNREAD#,}"', job)

    def test_mutant_ids_passed_as_one_argument(self):  # #515 (R1 fable N6)
        self.assertIn('--ids="$IDS"', self.jobs["advisory-diff-mutants"])
        self.assertNotIn('--ids "$IDS"', self.adv)

    def test_shared_budget_fits_timeout(self):
        job = self.jobs["advisory-shared-files"]
        self.assertIn("timeout-minutes: 10", job)
        t = [int(x) for x in __import__("re").findall(r"timeout (\d+) gh api", job)]
        budget = int(__import__("re").search(r"end=\$\(\( \$\(date \+%s\) \+ (\d+) \)\)", job).group(1))
        self.assertLess(sum(t) + budget, 600 - 120, (t, budget))  # 2 min headroom for checkout and setup


GH_STUB = """#!/bin/bash
case "$*" in
  *"pulls/500/files"*) echo a.ts ;;
  *"pulls?state=open"*) [ "$STUB_MODE" = openfail ] && exit 1; printf '500\\n501\\n502\\n' ;;
  *"pulls/501/files"*) echo a.ts ;;
  *"pulls/502/files"*) [ "$STUB_MODE" = prfail ] && exit 1; echo z ;;
  *) exit 1 ;;
esac
"""


class StepRun(unittest.TestCase):
    """#515: run the real advisory run blocks from ci.yml under bash with a stub gh (bash, jq and coreutils only)."""
    @classmethod
    def setUpClass(cls):
        Workflow.setUpClass.__func__(cls)

    def run_step(self, job, idx, **env):
        blk = textwrap.dedent(Workflow.run_blocks(self.jobs[job])[idx])
        tmp = Path(tempfile.mkdtemp())
        (tmp / "bin").mkdir()
        gh = tmp / "bin" / "gh"
        gh.write_text(GH_STUB); gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
        (tmp / "rt").mkdir()
        summ, outp = tmp / "summary.md", tmp / "out"
        summ.write_text(""); outp.write_text("")
        e = {"PATH": f"{tmp / 'bin'}:{os.environ.get('PATH', '/usr/bin:/bin')}", "HOME": str(tmp), "RUNNER_TEMP": str(tmp / "rt"),
             "GITHUB_STEP_SUMMARY": str(summ), "GITHUB_OUTPUT": str(outp), "GITHUB_EVENT_PATH": str(tmp / "none.json"),
             "BASE_SHA": "0" * 40, "HEAD_SHA": "1" * 40, "PR": "500", "REPO": "o/r", "GH_TOKEN": "x"}
        e.update(env)
        p = subprocess.run(["bash", "-c", blk], cwd=HERE.parent, env=e, capture_output=True, text=True, timeout=120)
        return p, summ.read_text(), outp.read_text()

    def test_failed_checkout_says_so_in_each_job(self):
        for job, idx in (("advisory-pr-class", 0), ("advisory-shared-files", 0), ("advisory-diff-mutants", 0)):
            for outcome in ("failure", "cancelled", ""):
                p, summ, out = self.run_step(job, idx, CHECKOUT=outcome)
                self.assertEqual(p.returncode, 0, (job, p.stderr))
                self.assertIn("could not check (checkout failed)", summ, (job, outcome))
                if job == "advisory-diff-mutants":
                    self.assertEqual(out, "ids=\n")

    def test_shared_open_list_unreadable(self):
        p, summ, _ = self.run_step("advisory-shared-files", 0, CHECKOUT="success", STUB_MODE="openfail")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("The list of open PRs could not be read", summ)
        self.assertNotIn("No other open PR", summ)

    def test_shared_one_pr_unreadable_is_named(self):
        p, summ, _ = self.run_step("advisory-shared-files", 0, CHECKOUT="success", STUB_MODE="prfail")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("**#501**: `a.ts`", summ)
        self.assertIn("Not checked (file list unreadable): #502", summ)

    def test_shared_all_readable(self):
        p, summ, _ = self.run_step("advisory-shared-files", 0, CHECKOUT="success")
        self.assertIn("**#501**: `a.ts`", summ)
        self.assertNotIn("Not checked", summ)
        self.assertNotIn("checkout failed", summ)


class Shared(Base):
    def test_overlap_listed_self_skipped(self):
        md = "\n".join(ca.shared(["a.ts", "b.md"], {"500": ["a.ts"], "501": ["a.ts", "z"], "502": ["z"], "x": ["a.ts"]}, "500"))
        self.assertIn("**#501**: `a.ts`", md)
        self.assertNotIn("#500", md)
        self.assertNotIn("#502", md)
        self.assertNotIn("#x", md)

    def test_empty_own_list_is_could_not_check(self):  # R1 sonnet B1
        md = "\n".join(ca.shared([], {"501": ["a.ts"]}, "500"))
        self.assertIn("could not check", md)
        self.assertNotIn("No other open PR", md)

    def test_open_list_unreadable_is_could_not_check(self):
        md = "\n".join(ca.shared(["a.ts"], {}, "500", open_unreadable=True))
        self.assertIn("could not check", md)
        self.assertNotIn("No other open PR", md)

    def test_unreadable_prs_are_named(self):
        md = "\n".join(ca.shared(["a.ts"], {"501": ["b.ts"]}, "500", unreadable=["502", "x"]))
        self.assertIn("Not checked (file list unreadable): #502", md)
        self.assertNotIn("#x", md)

    def test_cli_flags(self):
        mine = self.write("mine", "a.ts\n")
        oth = self.write("oth", "{}")
        p = self.run_cli("shared", "--mine", mine, "--others", oth, "--pr", "500", "--open-unreadable")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("could not check", p.stdout)
        p = self.run_cli("shared", "--mine", mine, "--others", oth, "--pr", "500", "--unreadable", "503,504")
        self.assertIn("#503, #504", p.stdout)

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

    def test_empty_file_list_is_could_not_check(self):
        os.chdir(self.tmp)
        ids, md = ca.select_mutants(b"", str(GATE), "apps/worker", 12)
        self.assertEqual(ids, [])
        self.assertIn("could not check", md[0])

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
