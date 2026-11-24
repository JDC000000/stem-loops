"""Tests for the in-job path gate of the `chord-chip-browser-gate` job in .github/workflows/ci.yml (#368).

The gate is a shell step (id: gate). It is NOT extracted into a separate script (that would change the
workflow's behaviour surface); instead this test pulls the step's `run:` block out of ci.yml verbatim and
executes it with bash inside throwaway git repos built from fixture file lists, then reads GITHUB_OUTPUT.
So the test always exercises the shipped logic, with no copy to drift.

Each scenario builds: base commit (HEAD^1) -> change commit (HEAD), the shape of a PR merge-commit checkout.
Run: python3 -m unittest scripts/test_chord_chip_path_gate.py   (stdlib only)
"""
import os
import re
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CI_YML = os.path.join(ROOT, ".github", "workflows", "ci.yml")


def extract_gate_script():
    """Return the `run: |` body of the step with `id: gate` inside job chord-chip-browser-gate."""
    with open(CI_YML, encoding="utf-8") as f:
        lines = f.read().split("\n")
    start = next(i for i, l in enumerate(lines) if l.rstrip() == "  chord-chip-browser-gate:")
    end = next((i for i in range(start + 1, len(lines)) if re.match(r"^  [A-Za-z0-9_-]+:\s*$", lines[i])), len(lines))
    job = lines[start:end]
    gate = next(i for i, l in enumerate(job) if l.strip() == "id: gate")
    run = next(i for i in range(gate, len(job)) if job[i].strip() == "run: |")
    indent = len(job[run]) - len(job[run].lstrip()) + 2
    body = []
    for l in job[run + 1:]:
        if l.strip() and (len(l) - len(l.lstrip())) < indent:
            break
        body.append(l[indent:] if l.strip() else "")
    script = "\n".join(body).strip("\n") + "\n"
    assert "git diff" in script and "GITHUB_OUTPUT" in script, "gate script extraction failed"
    return script


GATE = extract_gate_script()


def git(cwd, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
               GIT_COMMITTER_EMAIL="t@t", GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null")
    subprocess.run(["git", *args], cwd=cwd, env=env, check=True, capture_output=True)


def write(root, rel, text):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p) or root, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)


def run_gate(base_files, mutate, event="pull_request", n_commits=2):
    """base_files: {path: content} at HEAD^1. mutate(root): edits the worktree (writes, git mv, rm).
    Returns (run_value, stdout)."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = os.path.join(tmp, "repo")
        rt = os.path.join(tmp, "rt")
        os.makedirs(repo)
        os.makedirs(rt)
        git(repo, "init", "-q")
        git(repo, "config", "core.quotepath", "true")  # worst case: git would quote non-ASCII without -z
        for rel, text in base_files.items():
            write(repo, rel, text)
        if not base_files:
            write(repo, "README.md", "x")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "base")
        if n_commits == 2:
            mutate(repo)
            git(repo, "add", "-A")
            git(repo, "commit", "-q", "--allow-empty", "-m", "change")
        out_file = os.path.join(tmp, "out")
        with open(out_file, "w"):
            pass
        env = dict(os.environ, EVENT_NAME=event, RUNNER_TEMP=rt, GITHUB_OUTPUT=out_file)
        p = subprocess.run(["bash", "-e", "-c", GATE], cwd=repo, env=env, capture_output=True, text=True)
        assert p.returncode == 0, p.stderr
        with open(out_file) as f:
            vals = re.findall(r"^run=(\w+)$", f.read(), re.M)
        assert len(vals) == 1, (vals, p.stdout, p.stderr)
        return vals[0], p.stdout


def touch(*paths):
    def m(root):
        for rel in paths:
            write(root, rel, "changed\n")
    return m


class GateTests(unittest.TestCase):
    def decide(self, base, mutate, **kw):
        return run_gate(base, mutate, **kw)[0]

    # --- paths that must trigger a run ---
    def test_chord_paths_run(self):
        for rel in [
            "apps/web/src/chord/ChordOverlay.tsx", "packages/web-browser-gate/test/chord-chip-fit.test.mjs",
            "packages/types/src/x.ts", "fixtures/contracts/harte-labels.json", ".github/actions/setup/action.yml",
            "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", ".nvmrc",
            ".github/workflows/ci.yml",
        ]:
            with self.subTest(path=rel):
                self.assertEqual(self.decide({rel: "a\n"}, touch(rel)), "true")

    def test_ci_yml_itself_runs_even_alone(self):
        self.assertEqual(self.decide({"README.md": "a"}, touch(".github/workflows/ci.yml")), "true")

    def test_lockfile_only_runs(self):
        self.assertEqual(self.decide({"pnpm-lock.yaml": "a\n", "docs/a.md": "a\n"}, touch("pnpm-lock.yaml")), "true")

    # --- paths that must skip ---
    def test_unrelated_paths_skip(self):
        base = {"docs/a.md": "a\n", "apps/worker/src/w.py": "a\n", "scripts/x.sh": "a\n", ".github/workflows/other.yml": "a\n"}
        self.assertEqual(self.decide(base, touch("docs/a.md", "apps/worker/src/w.py", "scripts/x.sh", ".github/workflows/other.yml")), "false")

    def test_lookalike_prefixes_skip(self):
        # anchored regex: these must NOT match
        paths = ["apps/webby/x.ts", "docs/apps/web/x.md", "xpackages/a.ts", "sub/package.json", "fixtures2/a.json",
                 ".github/actionsX/a.yml", "pnpm-lock.yaml.bak", ".github/workflows/ci.yml.orig"]
        for rel in paths:
            with self.subTest(path=rel):
                self.assertEqual(self.decide({rel: "a\n"}, touch(rel)), "false")

    def test_new_file_in_gated_dir_runs(self):
        self.assertEqual(self.decide({"docs/a.md": "a\n"}, touch("apps/web/src/new.tsx")), "true")

    # --- renames (R1 false green, PR #362) ---
    def test_rename_out_of_chord_path_forces_run(self):
        base = {"apps/web/src/chord/ChordOverlay.tsx": "same content\n" * 20}

        def m(root):
            os.makedirs(os.path.join(root, "docs"), exist_ok=True)
            git(root, "mv", "apps/web/src/chord/ChordOverlay.tsx", "docs/ChordOverlay.tsx")
        self.assertEqual(self.decide(base, m), "true")

    def test_rename_into_chord_path_runs(self):
        base = {"docs/Chord.tsx": "same content\n" * 20}

        def m(root):
            os.makedirs(os.path.join(root, "apps/web/src"), exist_ok=True)
            git(root, "mv", "docs/Chord.tsx", "apps/web/src/Chord.tsx")
        self.assertEqual(self.decide(base, m), "true")

    def test_rename_between_unrelated_paths_skips(self):
        base = {"docs/a.md": "same\n" * 20}

        def m(root):
            git(root, "mv", "docs/a.md", "docs/b.md")
        self.assertEqual(self.decide(base, m), "false")

    # --- deletes ---
    def test_delete_of_chord_file_runs(self):
        base = {"apps/web/src/chord/Old.tsx": "a\n", "docs/a.md": "a\n"}
        self.assertEqual(self.decide(base, lambda r: os.remove(os.path.join(r, "apps/web/src/chord/Old.tsx"))), "true")

    def test_delete_of_unrelated_file_skips(self):
        base = {"docs/old.md": "a\n", "docs/a.md": "a\n"}
        self.assertEqual(self.decide(base, lambda r: os.remove(os.path.join(r, "docs/old.md"))), "false")

    # --- quoted / non-ASCII / odd names ---
    def test_non_ascii_name_in_chord_path_runs(self):
        rel = "apps/web/src/chord/Cmélodie コード.tsx"
        self.assertEqual(self.decide({"docs/a.md": "a\n"}, touch(rel)), "true")

    def test_non_ascii_name_outside_chord_path_skips(self):
        rel = "docs/café コード.md"
        self.assertEqual(self.decide({"docs/a.md": "a\n"}, touch(rel)), "false")

    def test_non_ascii_rename_out_of_chord_path_runs(self):
        base = {"apps/web/src/chord/éè.tsx": "same\n" * 20}

        def m(root):
            os.makedirs(os.path.join(root, "docs"), exist_ok=True)
            os.rename(os.path.join(root, "apps/web/src/chord/éè.tsx"), os.path.join(root, "docs/éè.tsx"))
        self.assertEqual(self.decide(base, m), "true")

    def test_space_and_quote_in_name(self):
        rel = 'apps/web/src/a "quoted" name.tsx'
        self.assertEqual(self.decide({"docs/a.md": "a\n"}, touch(rel)), "true")

    # --- mixed lists ---
    def test_mixed_one_gated_path_among_many_runs(self):
        base = {"docs/a.md": "a\n", "apps/worker/w.py": "a\n"}
        self.assertEqual(self.decide(base, touch("docs/a.md", "apps/worker/w.py", "packages/x/y.ts")), "true")

    def test_anchoring_not_per_line_confusion(self):
        # a filename that contains a newline then a gated prefix must not be able to spoof via line anchors:
        # with -z the whole NUL record is the unit, so "docs/x\napps/web/y" starts with "docs/" and must skip.
        rel = "docs/x\napps/web/y.md"
        self.assertEqual(self.decide({"docs/a.md": "a\n"}, touch(rel)), "false")

    # --- fail-safe / non-PR ---
    def test_push_event_always_runs(self):
        self.assertEqual(self.decide({"docs/a.md": "a\n"}, touch("docs/a.md"), event="push"), "true")

    def test_empty_diff_fails_safe_to_run(self):
        self.assertEqual(self.decide({"docs/a.md": "a\n"}, lambda r: None), "true")

    def test_no_parent_commit_fails_safe_to_run(self):
        self.assertEqual(self.decide({"docs/a.md": "a\n"}, None, n_commits=1), "true")


class WiringTests(unittest.TestCase):
    """The workflow wiring around the gate (not just its script body)."""

    @classmethod
    def setUpClass(cls):
        with open(CI_YML, encoding="utf-8") as f:
            cls.text = f.read()
        lines = cls.text.split("\n")
        start = next(i for i, l in enumerate(lines) if l.rstrip() == "  chord-chip-browser-gate:")
        end = next((i for i in range(start + 1, len(lines)) if re.match(r"^  [A-Za-z0-9_-]+:\s*$", lines[i])), len(lines))
        cls.job = lines[start:end]

    def test_script_test_step_exists_and_cannot_be_softened(self):
        lines = self.text.split("\n")
        start = next(i for i, l in enumerate(lines) if l.rstrip() == "  python-syntax-and-markers:")
        end = next((i for i in range(start + 1, len(lines)) if re.match(r"^  [A-Za-z0-9_-]+:\s*$", lines[i])), len(lines))
        job = lines[start:end]
        s = next(i for i, l in enumerate(job) if l.strip() == "- name: Script unit tests (scripts/test_*.py, stdlib unittest)")
        e = next((i for i in range(s + 1, len(job)) if job[i].lstrip().startswith("- ")), len(job))
        step = "\n".join(job[s:e])
        self.assertIn("unittest discover", step)
        self.assertIn("timeout-minutes: 5", step)
        self.assertNotIn("|| true", step)
        self.assertNotIn("continue-on-error", step)
        self.assertNotRegex(step, r"(?m)^\s+if:")
        self.assertNotIn("continue-on-error", "\n".join(job))
        self.assertIn("set -euo pipefail", step)
        self.assertIn("python -u -m unittest discover", step)
        self.assertRegex(step, r"-ge (10[5-9]|1[1-9]\d|[2-9]\d\d|\d{4,}) \]")
        self.assertIn("expected failures|unexpected successes", step)
        self.assertIn('= "OK" ]', step)
        self.assertIn("= 1 ]", step)
        self.assertNotRegex(step, r"set \+[a-z]*e|\|\|\s*(:|true\b|echo\b)")
        self.assertIn("-s scripts -p 'test_*.py'", step)
        self.assertNotRegex("\n".join(job), r"(?m)^    if:")

    def test_sweep_steps_keep_gate_condition(self):
        gate = next(i for i, l in enumerate(self.job) if l.strip() == "id: gate")
        # step boundaries after the gate step
        steps, cur = [], None
        for l in self.job[gate:]:
            if re.match(r"^      - ", l):
                cur = [l]
                steps.append(cur)
            elif cur is not None:
                cur.append(l)
        self.assertGreaterEqual(len(steps), 7)
        for st in steps:
            with self.subTest(step=st[0].strip()):
                self.assertIn("        if: steps.gate.outputs.run == 'true'", st)
        self.assertIn("          EVENT_NAME: ${{ github.event_name }}", self.job)
        self.assertNotRegex("\n".join(self.job), r"(?m)^    if:")
        self.assertNotIn("continue-on-error", "\n".join(self.job))


if __name__ == "__main__":
    unittest.main()
