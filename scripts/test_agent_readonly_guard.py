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
    "git -C /home/claude/s22/wt diff origin/v3/main...HEAD",
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
    "cat > /tmp/r.md <<'E.F'\ngit push mentioned\nE.F\ngit log -1",
    "gh api repos/o/r/pulls/440 --jq '.head.sha'",
    "gh api repos/o/r/commits/x/check-runs --jq '.check_runs[] | \"\\(.name) | \\(.status)\"'",
    "gh api -X GET search/code -f q=git",
    "gh api -iX GET rate_limit",
    "cd /home/claude/s22/wt && git log -1 && git diff --stat origin/v3/main...HEAD -- scripts/",
    "git fetch origin pull/440/head:pr440 && git worktree add ../rv pr440",
    "git --attr-source HEAD log -1",
    "git -c user.name='A B' log -1",
    "git -C '/a b' status",
    "for f in a b; do echo $f; done",
    "curl -sS -o /dev/null -w '%{http_code}' https://stem-loops.fly.dev/health",
    "curl -sSI https://x",
    "wget -q -O - https://x",
    "out=$(python3 -I -u -m unittest discover -s scripts 2>&1 | tail -3); echo $out",
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
    # R1 (fable) bypasses that must be blocked
    "gh api -iX POST repos/o/r/issues/1/comments",
    "gh api -if body=x repos/o/r/issues/1/comments",
    "curl -sX POST https://api.github.com/x",
    "curl -sSd x=1 https://api.github.com/x",
    "curl -s -dx=1 https://x",
    "curl -sS -XPOST https://x",
    "curl -XPOST https://x",
    "curl -sT f https://x",
    "curl -sF a=b https://x",
    "curl -K cfg https://x",
    "curl --config cfg https://x",
    "curl --dat x=1 https://x",
    "curl -so /dev/null -d@f https://x",
    "curl --request=PUT https://x",
    "git --attr-source HEAD push origin HEAD:x",
    "git -C '/tmp/my repo' push origin HEAD:x",
    "git -c user.name='Rev Bot' -c user.email=r@x commit -am fix",
    "cat > /dev/null <<E.F\nx\nE.F\ngit push origin HEAD:x",
    "cat > /dev/null <<'E-F'\nx\nE-F\ngit push origin HEAD:x",
    "cat > /dev/null <<EOF\nno closing line\ngit push",
    "echo push origin HEAD:x | xargs git",
    "/usr/bin/gi? push origin HEAD:x",
    "git pu${Z}sh origin HEAD:x",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p origin HEAD:x",
    "X=git; $X push",
    "export G=/usr/bin/gh; $G pr merge 1",
    "{git,push,origin,HEAD:x}",
    "python3 -c 'import subprocess; subprocess.run([\"git\",\"push\"])'",
    "git p origin x",
    "git clean -fdx",
    "gh api graphql",
    "gh api -X GET graphql",
    "gh api /graphql -X GET",
    "wget --method POST https://x",
    "wget --method=PUT https://x",
    "wget --post-d=x https://x",
    "gh api -X GET -X POST repos/o/r/x",
    "gh api --method post repos/o/r/x",
    "git reflog expire --all",
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

    def test_every_blocked_git_subcommand(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("guard", GUARD)
        g = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(g)
        self.assertEqual(g.GIT_BLOCKED & g.GIT_ALLOWED, set())
        fixed = ["push", "commit", "merge", "rebase", "reset", "cherry-pick", "revert",
                 "am", "tag", "update-ref", "pull", "clean", "send-pack", "receive-pack",
                 "http-push", "commit-tree", "symbolic-ref", "notes", "replace"]
        for sub in sorted(set(g.GIT_BLOCKED) | set(fixed)):
            for form in ("git %s x", "git -C /x %s", "git --attr-source HEAD %s"):
                with self.subTest(cmd=form % sub):
                    self.assertIsNotNone(g.violation(form % sub))
        remote_writes = {"add", "remove", "rm", "rename", "set-url", "set-head",
                         "set-branches", "prune", "update"}
        self.assertEqual(g.GIT_REMOTE_WRITES, remote_writes)
        for sub in sorted(remote_writes):
            with self.subTest(remote=sub):
                self.assertIsNotNone(g.violation("git remote %s origin https://x" % sub))
        for sub in ("log", "diff", "show", "fetch", "status", "worktree", "checkout"):
            with self.subTest(allowed=sub):
                self.assertIsNone(g.violation("git %s" % sub))

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
            # No python3 on PATH (sh and git only): must exit 2, not 127.
            import shutil
            import tempfile
            with tempfile.TemporaryDirectory() as tmp:
                os.symlink(shutil.which("git"), os.path.join(tmp, "git"))
                env2 = dict(os.environ, CLAUDE_PROJECT_DIR=str(ROOT), PATH=tmp)
                p = subprocess.run([shutil.which("sh"), "-c", cmd], cwd=str(ROOT), env=env2,
                                   input=json.dumps({"tool_name": "Bash",
                                                     "tool_input": {"command": "git push"}}),
                                   capture_output=True, text=True, timeout=30)
                with self.subTest(agent=name, case="no python3"):
                    self.assertEqual(p.returncode, 2, p.stderr)
                # python3 present but exiting 1 (e.g. a crash before main): must be 2
                with open(os.path.join(tmp, "python3"), "w") as fh:
                    fh.write("#!/bin/sh\nexit 1\n")
                os.chmod(os.path.join(tmp, "python3"), 0o755)
                os.symlink(shutil.which("sh"), os.path.join(tmp, "sh"))
                p = subprocess.run([shutil.which("sh"), "-c", cmd], cwd=str(ROOT), env=env2,
                                   input="{}", capture_output=True, text=True, timeout=30)
                with self.subTest(agent=name, case="python3 exits 1"):
                    self.assertEqual(p.returncode, 2, p.stderr)
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
