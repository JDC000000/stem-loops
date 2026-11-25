"""Tests for scripts/agent_readonly_guard.py and the read-only frontmatter of
the code-reviewer and security agents (#389). Stdlib unittest only."""
import json
import pathlib
import re
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
GUARD = ROOT / "scripts" / "agent_readonly_guard.py"
AGENTS = ROOT / ".claude" / "agents"
READ_ONLY_AGENTS = ("code-reviewer", "security")
WRITE_TOOLS = {"Write", "Edit", "NotebookEdit", "MultiEdit", "Agent", "Task"}


def run_guard(payload):
    raw = payload if isinstance(payload, str) else json.dumps(payload)
    p = subprocess.run([sys.executable, "-I", str(GUARD)], input=raw,
                       capture_output=True, text=True, timeout=30)
    return p.returncode, p.stderr


def bash(cmd):
    return run_guard({"tool_name": "Bash", "tool_input": {"command": cmd}})


ALLOWED = [
    "git log --oneline -5",
    "git -C /home/claude/s22/wt git diff origin/v3/main...HEAD",
    "git --no-pager show HEAD:scripts/or4-merge.sh",
    "git fetch --depth=50 origin pull/12/head",
    "git worktree add /tmp/rv -b rv FETCH_HEAD",
    "git stash list && git status --porcelain",
    "git checkout -- scripts/x.py",
    "git config --get remote.origin.url",
    "git remote -v",
    "git branch --show-current",
    "gh pr view 12 --json headRefOid",
    "gh pr diff 12",
    "gh -R JDC000000/stem-loops pr checks 12",
    "gh api repos/JDC000000/stem-loops/pulls/12",
    "gh api repos/o/r/commits/abc/check-runs --jq '.check_runs[].conclusion'",
    "gh api -X GET search/issues -f q=repo:o/r",
    "gh issue view 389",
    "python3 -I -u -m unittest discover -v -s scripts -p 'test_*.py'",
    "cp scripts/x.py /tmp/m1.py && sed -i 's/>=/>/' /tmp/m1.py",
    "curl -sS https://example.com/health",
    "grep -n push .claude/settings.json",
    "cat > /home/claude/s22/reviews/R1.md <<'EOF'\nthe author ran git push; it's fine\ngh pr merge is not used\nEOF",
]

BLOCKED = [
    "git push origin HEAD:x",
    "git -C /x push origin y",
    "git -c push.negotiate=true push origin HEAD:b",
    "flock /home/claude/s22/git-net.lock git -c push.negotiate=true push origin HEAD:b",
    "bash -c \"git push origin x\"",
    "sh -c 'cd /x && git commit -m y'",
    "g''it push",
    "g\\it push",
    "echo $(git push)",
    "echo `git push`",
    "/usr/bin/git push",
    "git commit -am msg",
    "git merge origin/v3/main",
    "git rebase origin/v3/main",
    "git reset HEAD~1",
    "git tag v1",
    "git pull",
    "git update-ref refs/heads/x HEAD",
    "git -c alias.p=push p origin x",
    "git config alias.p push",
    "git remote set-url origin https://x",
    "git branch -D x",
    "git log && git push",
    "bash <<EOF\ngit push\nEOF",
    "cat <<EOF | bash\ngit push\nEOF",
    "gh pr merge 12 --squash",
    "gh pr comment 12 -b hi",
    "gh pr review 12 --approve",
    "gh pr edit 12 --add-label x",
    "gh pr ready 12",
    "gh issue comment 414 -b x",
    "gh issue create -t x",
    "gh label create x",
    "gh workflow run deploy.yml",
    "gh run rerun 1",
    "gh secret set X",
    "gh alias set m 'pr merge'",
    "gh api -X POST repos/o/r/issues/1/comments -f body=x",
    "gh api --method=PATCH repos/o/r/pulls/1",
    "gh api -XDELETE repos/o/r/labels/x",
    "gh api repos/o/r/issues/1/comments -f body=x",
    "gh api repos/o/r/pulls -F draft=true",
    "gh api repos/o/r/x --input body.json",
    "gh api graphql -f query='{viewer{login}}'",
    "curl -X POST https://api.github.com/x",
    "curl -d x=1 https://api.github.com/x",
    "curl --json {} https://x",
    "wget --post-data=x https://x",
]


class GuardCommands(unittest.TestCase):
    def test_allowed(self):
        for cmd in ALLOWED:
            with self.subTest(cmd=cmd):
                rc, err = bash(cmd)
                self.assertEqual(rc, 0, err)

    def test_blocked(self):
        for cmd in BLOCKED:
            with self.subTest(cmd=cmd):
                rc, err = bash(cmd)
                self.assertEqual(rc, 2, cmd)
                self.assertIn("agent_readonly_guard: blocked", err)

    def test_non_bash_tool_passes(self):
        rc, _ = run_guard({"tool_name": "Read", "tool_input": {"file_path": "/x"}})
        self.assertEqual(rc, 0)

    def test_fail_closed(self):
        for raw in ("", "not json", "[]",
                    json.dumps({"tool_name": "Bash", "tool_input": {}}),
                    json.dumps({"tool_name": "Bash", "tool_input": {"command": 3}})):
            with self.subTest(raw=raw):
                rc, err = run_guard(raw)
                self.assertEqual(rc, 2)
                self.assertIn("fail closed", err)


def frontmatter(name):
    text = (AGENTS / (name + ".md")).read_text()
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    assert m, name
    return m.group(1)


def list_field(fm, key):
    m = re.search(r"^%s:\s*\[(.*?)\]\s*$" % key, fm, re.M)
    if not m:
        return None
    return {t.strip() for t in m.group(1).split(",") if t.strip()}


class ReadOnlyFrontmatter(unittest.TestCase):
    def test_no_write_tools(self):
        for name in READ_ONLY_AGENTS:
            with self.subTest(agent=name):
                fm = frontmatter(name)
                tools = list_field(fm, "tools")
                self.assertIsNotNone(tools, "tools must be an explicit allowlist")
                self.assertEqual(tools & WRITE_TOOLS, set())
                self.assertTrue(tools <= {"Read", "Grep", "Glob", "Bash"}, tools)
                denied = list_field(fm, "disallowedTools") or set()
                self.assertTrue({"Write", "Edit", "NotebookEdit", "Agent"} <= denied, denied)

    def test_bash_hook_wired(self):
        for name in READ_ONLY_AGENTS:
            with self.subTest(agent=name):
                fm = frontmatter(name)
                self.assertRegex(fm, r"(?m)^hooks:\n  PreToolUse:\n    - matcher: \"Bash\"\n"
                                     r"      hooks:\n        - type: command\n"
                                     r"          command: .*scripts/agent_readonly_guard\.py")
                self.assertNotRegex(fm, r"(?m)^permissionMode:\s*(bypassPermissions|acceptEdits)")

    def test_hook_command_runs_guard(self):
        # Execute the exact hook command from the frontmatter, the way the CLI
        # would (sh -c, CLAUDE_PROJECT_DIR set), on one blocked and one allowed call.
        import os
        for name in READ_ONLY_AGENTS:
            fm = frontmatter(name)
            cmd = re.search(r"(?m)^          command: (.*)$", fm).group(1)
            cmd = json.loads(cmd) if cmd.startswith('"') else cmd
            env = dict(os.environ, CLAUDE_PROJECT_DIR=str(ROOT))
            for c, want in (("git push origin x", 2), ("git log -1", 0)):
                with self.subTest(agent=name, c=c):
                    p = subprocess.run(["sh", "-c", cmd], cwd=str(ROOT), env=env,
                                       input=json.dumps({"tool_name": "Bash",
                                                         "tool_input": {"command": c}}),
                                       capture_output=True, text=True, timeout=30)
                    self.assertEqual(p.returncode, want, p.stderr)
            # CLAUDE_PROJECT_DIR without the guard: falls back to the git
            # toplevel of cwd; with neither, every Bash call is blocked.
            env = dict(os.environ, CLAUDE_PROJECT_DIR="/nonexistent-389")
            for cwd, c, want in ((str(ROOT / "docs"), "git push", 2), (str(ROOT / "docs"), "git log", 0),
                                 ("/", "git log", 2)):
                with self.subTest(agent=name, cwd=cwd, c=c):
                    p = subprocess.run(["sh", "-c", cmd], cwd=cwd, env=env,
                                       input=json.dumps({"tool_name": "Bash",
                                                         "tool_input": {"command": c}}),
                                       capture_output=True, text=True, timeout=30)
                    self.assertEqual(p.returncode, want, p.stderr)


if __name__ == "__main__":
    unittest.main()
