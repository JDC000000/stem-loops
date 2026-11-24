"""Tests for .claude/settings.json deny list (#389). Tightening-only guard.

fnmatch is only an approximation of Claude Code's permission matcher; the deny
list is not a security boundary (see the F9 caveat in settings.json comment).
"""
import fnmatch
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SETTINGS = json.loads((ROOT / ".claude" / "settings.json").read_text())
ALLOW = SETTINGS["permissions"]["allow"]
DENY = SETTINGS["permissions"]["deny"]

ORIGINAL_DENY = [
    "Bash(git push * main)",
    "Bash(git push * v3/main)",
    "Bash(git push --force* main)",
    "Bash(git push --force* v3/main)",
    "Bash(gh pr merge --admin*)",
    "Bash(git push --force *)",
    "Bash(git push -f *)",
    "Bash(git reset --hard*)",
    "Bash(rm -rf *)",
]
ORIGINAL_ALLOW = [
    "Bash(scripts/safe_merge.sh *)",
    "Bash(git push origin v3/phase-*)",
    "Bash(git push origin v3-phase-*)",
]
NEW_DENY = [
    "Bash(git push --force*)",
    "Bash(git push * --force*)",
    "Bash(git push * --force-with-lease*)",
    "Bash(git push * -f)",
    "Bash(git push * -f *)",
    "Bash(git push * +*)",
    "Bash(git push --mirror*)",
    "Bash(git push * --mirror*)",
    "Bash(git push * --delete *)",
    "Bash(git reset * --hard*)",
    "Bash(rm -fr *)",
    "Bash(rm -r -f *)",
    "Bash(rm -f -r *)",
    "Bash(rm -Rf *)",
    "Bash(rm -rF *)",
]
BYPASS = [
    "git push origin br --force",
    "git push origin br --force-with-lease",
    "git push origin br -f",
    "git push -f origin br",
    "git push origin +HEAD:br",
    "git push --mirror origin",
    "git push origin --mirror",
    "git push origin --delete br",
    "git push origin :br",
    "git -c push.negotiate=true push origin br --force",
    "git reset HEAD~1 --hard",
    "git reset --hard HEAD~1",
    "rm -fr /tmp/x",
    "rm -r -f /tmp/x",
    "rm -f -r /tmp/x",
    "rm -Rf /tmp/x",
    "rm -rF /tmp/x",
    "rm --recursive --force /tmp/x",
]
NORMAL = [
    "git -c push.negotiate=true push origin HEAD:v3-agentic-settings-deny-389",
    "git push -u origin HEAD:v3-agentic-settings-deny-389",
    "git push origin HEAD:v3-agentic-settings-deny-389",
    "git reset HEAD file.txt",
    "git reset --soft HEAD~1",
    "rm -r /tmp/x",
    "rm -f /tmp/x",
    "rm /tmp/x",
]


def matches(rule, cmd):
    assert rule.startswith("Bash(") and rule.endswith(")")
    return fnmatch.fnmatchcase(cmd, rule[5:-1])


def denied(cmd):
    return any(matches(r, cmd) for r in DENY)


class SettingsDenyTest(unittest.TestCase):
    def test_original_deny_entries_kept(self):
        for r in ORIGINAL_DENY:
            self.assertIn(r, DENY)

    def test_new_deny_entries_present(self):
        for r in NEW_DENY:
            self.assertIn(r, DENY)

    def test_allow_unchanged(self):
        self.assertEqual(sorted(ALLOW), sorted(ORIGINAL_ALLOW))

    def test_no_duplicate_deny(self):
        self.assertEqual(len(DENY), len(set(DENY)))

    def test_bypass_commands_denied(self):
        for c in BYPASS:
            self.assertTrue(denied(c), c)

    def test_normal_commands_not_denied(self):
        for c in NORMAL:
            self.assertFalse(denied(c), c)


if __name__ == "__main__":
    unittest.main()
