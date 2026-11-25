"""Tests for .claude/settings.json deny list (#389). Tightening-only guard.

The matcher models the documented Claude Code Bash rule semantics
(https://code.claude.com/docs/en/permissions): `*` matches any text including
spaces, text before the first `*` is literal, a trailing ` *` (sole wildcard)
also matches the bare command, and a trailing `:*` is the legacy prefix suffix.
It is a model, not the real matcher; the deny list is not a security boundary
(F9 caveat in the settings.json comment).
"""
import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SETTINGS = json.loads((ROOT / ".claude" / "settings.json").read_text())
ALLOW = SETTINGS["permissions"]["allow"]
DENY = SETTINGS["permissions"]["deny"]

# #430: the settings.json comment before #389 (git show 600cd9d:.claude/settings.json); #389 only appended to it.
BASE_COMMENT = "T1 subagent guardrails. Session-7 (2026-11-05). See claude/merge-autonomy-recommendations.md Decision box for the allow/deny rationale. These rules apply to subagents and to the main session alike; the main session merging via scripts/safe_merge.sh satisfies M-1 even though --admin itself is denied below. || DEFERRED TO LEVEL 3 (2026-11-05, audit finding F9): this file denies Bash(gh pr merge --admin*) while allowing Bash(scripts/safe_merge.sh *), and that script's final line is `exec gh pr merge \"$PR\" --admin ...`. So an allowed wrapper executes a denied command. THE OPEN QUESTION, for the Level-3 reviewer at the 72h retro: does the permission layer inspect subprocesses spawned by an allowed script, or only the Bash invocation it was given? If only the invocation, then EVERY deny rule in this file is circumventable by a wrapper script, which matters far beyond merging. Not tested as of 2026-11-05 because testing it means attempting a blocked merge. Do not treat the deny list as a security boundary until this is answered. Retro task: trig_017AKZq6MEVFDioEbEwpHM1g."
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
    "Bash(git push --force-with-lease*)",
    "Bash(git push -f)",
    "Bash(git push * -f)",
    "Bash(git push * -f *)",
    "Bash(git push -f*)",
    "Bash(git push * +*)",
    "Bash(git push --mirror*)",
    "Bash(git push * --mirror*)",
    "Bash(git push --delete *)",
    "Bash(git push * --delete *)",
    "Bash(git push * -d *)",
    "Bash(git push * :**)",
    "Bash(git -c * push * --force*)",
    "Bash(git -c * push * -f)",
    "Bash(git -c * push * -f *)",
    "Bash(git -c * push * +*)",
    "Bash(git -c * push * --mirror*)",
    "Bash(git reset * --hard*)",
    "Bash(git -c * reset * --hard*)",
    "Bash(rm -fr *)",
    "Bash(rm -r -f *)",
    "Bash(rm -f -r *)",
    "Bash(rm -Rf *)",
    "Bash(rm -fR *)",
    "Bash(rm -rF *)",
    "Bash(rm -Fr *)",
    "Bash(rm -R -f *)",
    "Bash(rm -f -R *)",
    "Bash(rm -r --force *)",
    "Bash(rm --force -r *)",
    "Bash(rm --recursive --force *)",
    "Bash(rm --force --recursive *)",
    "Bash(git push -d *)",
    "Bash(git -c * push * :**)",
    "Bash(git -c * push --force*)",
    "Bash(git -c * push -f*)",
    "Bash(git -c * push --force-with-lease*)",
    "Bash(git -c * push --mirror*)",
    "Bash(git -c * push --delete *)",
    "Bash(git -c * push * --delete *)",
    "Bash(git -c * push -d *)",
    "Bash(git -c * push * -d *)",
    "Bash(git -c * reset --hard*)",
    "Bash(rm -rf*)",
    "Bash(rm -fr*)",
    "Bash(rm -Rf*)",
    "Bash(rm -fR*)",
    "Bash(rm -rF*)",
    "Bash(rm -Fr*)",
    "Bash(rm -vrf *)",
    "Bash(rm -vfr *)",
    "Bash(rm -vRf *)",
    "Bash(rm -vfR *)",
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
    "git push -d origin br",
    "git push origin :br",
    "git -c a=b push -f origin br",
    "git -c a=b push --force origin br",
    "git -c a=b push --force-with-lease origin br",
    "git -c a=b push --mirror origin",
    "git -c a=b push origin --delete br",
    "git -c a=b push -d origin br",
    "git -c a=b push origin :br",
    "git -c a=b reset --hard HEAD",
    "rm -rfv /tmp/x",
    "rm -vrf /tmp/x",
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
    "git push --follow-tags origin HEAD:br",
    "git push origin v3/phase-2",
    "git push origin fix-delete-button",
    "git -c a=b reset HEAD file.txt",
    "git reset HEAD file.txt",
    "git reset --soft HEAD~1",
    "rm -r /tmp/x",
    "rm -f /tmp/x",
    "rm /tmp/x",
]


def matches(rule, cmd):
    assert rule.startswith("Bash(") and rule.endswith(")")
    p = rule[5:-1]
    m = re.match(r"^(.+):\*$", p, re.S)
    if m:  # legacy prefix suffix: the rest is literal
        pre = m.group(1).rstrip()
        return cmd == pre or cmd.startswith(pre + " ")
    if "*" not in p:
        return cmd == p
    # #430: decide the bare-command case on the RULE text, before the literal-prefix check (which would
    # reject the bare command), not on re.escape output: since Python 3.7 re.escape no longer escapes a
    # space, so the old `rx.endswith(r"\ .*")` test was never true and this branch was dead.
    if p.endswith(" *") and p.count("*") == 1:
        pre = p[:-2]
        return cmd == pre or cmd.startswith(pre + " ")
    lit = p[: p.index("*")]
    if not cmd.startswith(lit):
        return False
    rx = re.escape(p).replace(r"\*", ".*")
    return re.match("^" + rx + "$", cmd, re.S) is not None


def denied(cmd):
    return any(matches(r, cmd) for r in DENY)


class SettingsDenyTest(unittest.TestCase):
    def test_key_sets_exact(self):
        self.assertEqual(set(SETTINGS), {"$schema", "comment", "permissions"})
        self.assertEqual(set(SETTINGS["permissions"]), {"allow", "deny"})

    def test_comment_keeps_caveats(self):
        c = SETTINGS["comment"]
        # #430: the whole pre-#389 comment is kept verbatim as a prefix (not just a few substrings of it)
        self.assertTrue(c.startswith(BASE_COMMENT + " "), "settings.json comment no longer starts with the full base comment")
        self.assertIn("Retro task: trig_017AKZq6MEVFDioEbEwpHM1g.", c)
        self.assertIn("not a security boundary", c)
        self.assertIn("#389", c)

    def test_original_deny_entries_kept_in_order(self):
        self.assertEqual(DENY[: len(ORIGINAL_DENY)], ORIGINAL_DENY)

    def test_new_deny_entries_exact(self):
        self.assertEqual(DENY[len(ORIGINAL_DENY):], NEW_DENY)

    def test_no_dead_colon_star_rule(self):
        for r in DENY:
            self.assertFalse(r.endswith(" :*)"), r)

    def test_allow_unchanged(self):
        self.assertEqual(sorted(ALLOW), sorted(ORIGINAL_ALLOW))

    def test_no_duplicate_deny(self):
        self.assertEqual(len(DENY), len(set(DENY)))

    def test_bypass_commands_denied(self):
        for c in BYPASS:
            self.assertTrue(denied(c), c)

    def test_matcher_model_semantics(self):
        # #430: pins the model itself, so a dead branch cannot hide again
        self.assertTrue(matches("Bash(rm -rf *)", "rm -rf"))  # sole trailing ` *` also matches the bare command
        self.assertTrue(matches("Bash(rm -rf *)", "rm -rf /tmp/x"))
        self.assertFalse(matches("Bash(rm -rf *)", "rm -rfv"))  # ...but not a longer word
        self.assertFalse(matches("Bash(git push * main)", "git push main"))  # two wildcards: no bare-command form
        self.assertTrue(matches("Bash(git push * main)", "git push origin main"))
        self.assertTrue(matches("Bash(git push -f*)", "git push -f"))
        self.assertTrue(matches("Bash(git push -f)", "git push -f"))
        self.assertFalse(matches("Bash(git push -f)", "git push -f origin"))
        self.assertTrue(matches("Bash(git push:*)", "git push"))
        self.assertTrue(matches("Bash(git push:*)", "git push origin"))
        self.assertFalse(matches("Bash(git push:*)", "git pushx"))

    def test_bare_commands_denied(self):
        # #430: with the bare-command branch live, every ` *`-suffixed deny rule also denies the bare command
        for c in ("rm -rf", "rm -fr", "rm -Rf", "rm -r -f", "rm --recursive --force", "git push -d", "git push --delete"):
            self.assertTrue(denied(c), c)

    def test_normal_commands_not_denied(self):
        for c in NORMAL:
            self.assertFalse(denied(c), c)


if __name__ == "__main__":
    unittest.main()
