#!/usr/bin/env python3
"""PreToolUse hook: keep the `code-reviewer` and `security` agents read-only (#389).

Wired from the `hooks:` block in `.claude/agents/code-reviewer.md` and
`.claude/agents/security.md` (frontmatter hooks run only while that subagent
is active, https://code.claude.com/docs/en/sub-agents). Those agents keep Bash
because reviews must run tests and executed mutants, so this hook vetoes the
Bash calls that would change repo history, a remote, or GitHub state:

- git: only an allowlist of read / local-working-tree subcommands runs (log,
  diff, show, fetch, worktree, checkout, stash, ...). Everything else is
  blocked, including push, commit, merge, rebase, reset, revert, tag, pull,
  clean, send-pack, update-ref, and any alias (an alias is not on the list).
  Global options that take a value (-C, -c, --git-dir, --attr-source, ...) are
  skipped as option + value; `-c alias.*` and GIT_CONFIG_* env are blocked.
- gh: only a read allowlist; `gh api` only as GET (no -X/--method other than
  GET, no -f/-F/--field/--raw-field/--input unless every method is GET and
  one is given), never `gh api graphql`. Combined short flags (-iX, -if) are
  expanded.
- curl/wget: no write method, no body, no config file (-K/--config); curl
  short-flag clusters (-sX, -sSd, -dx=1) and wget option prefixes are handled.
- A variable assigned a guarded command name (`X=git`), a guarded command
  run by xargs, and a glob that matches a guarded name (`gi?`) are blocked.

Hook contract (https://code.claude.com/docs/en/hooks): JSON on stdin with
`tool_name` and `tool_input.command`; only exit 2 blocks the call (other
non-zero codes let it run), and stderr is shown to the agent. Inside this
script every failure (bad JSON, missing command, internal error, nesting too
deep) exits 2. The frontmatter wrapper also maps a missing python3, a missing
guard file and any other non-zero exit to 2.

Parsing is a small shell-like lexer: quotes group words (so `-C '/a b'` stays
one value) and are then removed (so `g''it` is `git`); backslashes escape;
`; & | ( ) { } < > $ backtick newline` split commands. Every word that itself
contains spaces or shell operators is scanned again as a command, so
`bash -c "git push"`, `"$(git push)"` and `python3 -c '...["git","push"]'`
are caught. That makes it deliberately over-broad: a word that only mentions a
blocked command (`grep "git push" f`) is blocked too; rephrase it
(`grep push f`). Heredoc bodies written by `cat`/`tee` to a file are data and
are not scanned, but only when the closing delimiter line is found.

This is a tripwire against accidental or prompt-injected writes, not a
sandbox. Not caught: a command assembled at run time from pieces (string
concatenation, `printf`/`base64` output), brace expansion `{git,push}`, a
script file written first and run later, and a guard file edited by the PR
under review when the hook falls back to the cwd's git toplevel (the wrapper
prefers $CLAUDE_PROJECT_DIR). The settings.json deny list still applies.
"""
import fnmatch
import json
import re
import sys

GUARDED = ("git", "gh", "curl", "wget")

# git subcommands that only read, or change only the local working tree /
# index of the reviewer's own checkout. Anything else is blocked.
GIT_ALLOWED = {
    "add", "apply", "archive", "bisect", "blame", "branch", "cat-file",
    "check-attr", "check-ignore", "check-mailmap", "check-ref-format",
    "checkout", "cherry", "clone", "column", "config", "count-objects",
    "describe", "diff", "diff-files", "diff-index", "diff-tree", "fetch",
    "for-each-ref", "format-patch", "fsck", "grep", "help", "init",
    "interpret-trailers", "log", "ls-files", "ls-remote", "ls-tree",
    "merge-base", "merge-tree", "mv", "name-rev", "patch-id", "range-diff",
    "reflog", "remote", "restore", "rev-list", "rev-parse", "rm",
    "shortlog", "show", "show-branch", "show-ref", "stash", "status",
    "stripspace", "switch", "var", "verify-commit", "verify-tag", "version",
    "whatchanged", "worktree",
}
# Named in messages and tests; all of these are outside GIT_ALLOWED.
GIT_BLOCKED = {
    "push", "commit", "merge", "rebase", "reset", "cherry-pick", "revert",
    "am", "tag", "update-ref", "filter-branch", "filter-repo", "replace",
    "notes", "commit-tree", "send-email", "symbolic-ref", "pull", "clean",
    "send-pack", "receive-pack", "http-push", "fast-import", "gc", "prune",
    "repack", "maintenance", "request-pull", "imap-send", "submodule",
}
GIT_OPTS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace",
                       "--config-env", "--super-prefix", "--attr-source",
                       "--exec-path", "--list-cmds"}
GIT_REMOTE_WRITES = {"add", "remove", "rm", "rename", "set-url", "set-head",
                     "set-branches", "prune", "update"}
GIT_CONFIG_READS = {"--get", "--get-all", "--get-regexp", "--get-urlmatch",
                    "--list", "-l", "get", "list"}
GIT_REFLOG_WRITES = {"expire", "delete", "drop"}

# gh <group> <action>: only these are allowed. "*" = any action.
GH_ALLOW = {
    "pr": {"view", "diff", "list", "checks", "status", "checkout"},
    "issue": {"view", "list", "status"},
    "run": {"view", "list", "watch", "download"},
    "workflow": {"view", "list"},
    "repo": {"view", "list", "clone"},
    "release": {"view", "list", "download"},
    "label": {"list"},
    "cache": {"list"},
    "ruleset": {"view", "list", "check"},
    "search": {"*"},
    "status": {"*"},
    "auth": {"status"},
    "version": {"*"},
    "--version": {"*"},
    "help": {"*"},
}
GH_API_VALUE_SHORT = set("XfFHpqt")   # short flags of `gh api` that take a value
GH_API_BODY_LONG = {"--field", "--raw-field", "--input"}

CURL_VALUE_SHORT = set("AbcCdDeEFHKmoPQrTuUwxXyYzt")
CURL_BODY_SHORT = set("dFT")
CURL_BODY_LONG = {"--data", "--data-raw", "--data-binary", "--data-urlencode",
                  "--data-ascii", "--form", "--form-string", "--upload-file",
                  "--json", "--config"}
WGET_BLOCKED_LONG = {"--post-data", "--post-file", "--method", "--body-data",
                     "--body-file", "--config"}

SEPARATORS = set(";&|(){}<>$`\n")
NESTED_EXTRA = set("[],")          # extra word breaks inside re-scanned words
WORD_NEEDS_RESCAN = re.compile(r"[\s;&|(){}<>$`\[\],]")
HEREDOC = re.compile(r"<<-?\s*(['\"]?)([^\s'\"<>;&|()]+)\1")
ENV_ASSIGN = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", re.S)
MAX_DEPTH = 6
ASSIGN_PREFIX = {"env", "export", "declare", "local", "readonly", "typeset"}


class Blocked(Exception):
    pass


def _strip_data_heredocs(cmd):
    """Drop heredoc bodies fed to `cat`/`tee` (file data, not commands).

    The body is dropped only when the header is `cat`/`tee` with exactly one
    heredoc and no pipe, and the closing delimiter line exists; otherwise the
    whole text is kept and scanned (so `bash <<EOF` and odd delimiters are).
    """
    lines = cmd.split("\n")
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        i += 1
        found = HEREDOC.findall(line)
        if not found:
            continue
        head = line.strip().split()
        is_data = (head and head[0] in ("cat", "tee") and "|" not in line
                   and len(found) == 1)
        if not is_data:
            continue
        delim = found[0][1]
        end = i
        while end < len(lines) and lines[end].strip() != delim:
            end += 1
        if end >= len(lines):
            continue  # no closing line: keep the body, scan it
        i = end + 1
    return "\n".join(out)


def _lex(cmd, nested):
    """Split into commands (lists of words). Quotes group, then vanish."""
    seps = SEPARATORS
    blanks = NESTED_EXTRA if nested else set()
    segs, words = [], []
    cur, has_word, quote, i = [], False, None, 0

    def end_word():
        nonlocal cur, has_word
        if has_word:
            words.append("".join(cur))
        cur, has_word = [], False

    def end_seg():
        nonlocal words
        end_word()
        if words:
            segs.append(words)
        words = []

    while i < len(cmd):
        ch = cmd[i]
        if quote:
            if ch == quote:
                quote = None
            elif ch == "\\" and quote == '"' and i + 1 < len(cmd):
                i += 1
                cur.append(cmd[i])
            else:
                cur.append(ch)
        elif ch in ("'", '"'):
            quote, has_word = ch, True
        elif ch == "\\":
            if i + 1 < len(cmd) and cmd[i + 1] != "\n":
                cur.append(cmd[i + 1])
                has_word = True
            i += 1
        elif ch in seps:
            end_seg()
        elif ch.isspace() or ch in blanks:
            end_word()
        else:
            cur.append(ch)
            has_word = True
        i += 1
    end_seg()
    return segs


def _name(tok):
    base = tok.rsplit("/", 1)[-1]
    if base in GUARDED:
        return base
    if any(c in base for c in "*?["):
        for g in GUARDED:
            if fnmatch.fnmatchcase(g, base):
                return g
    return None


def _check_git(toks, i):
    j = i + 1
    while j < len(toks) and toks[j].startswith("-"):
        name, eq, val = toks[j].partition("=")
        if name in GIT_OPTS_WITH_VALUE and not eq:
            j += 1
            val = toks[j] if j < len(toks) else ""
        if name in ("-c", "--config-env") and val.lower().startswith("alias."):
            raise Blocked("git -c alias.* (an alias can hide a write)")
        j += 1
    if j >= len(toks):
        return
    sub = toks[j]
    rest = toks[j + 1:]
    if sub not in GIT_ALLOWED:
        raise Blocked("git " + sub + ("" if sub in GIT_BLOCKED
                                       else " (not on the read-only git allowlist)"))
    if sub == "remote" and rest and rest[0] in GIT_REMOTE_WRITES:
        raise Blocked("git remote " + rest[0])
    if sub == "config" and not any(r in GIT_CONFIG_READS for r in rest):
        raise Blocked("git config (write)")
    if sub == "reflog" and rest and rest[0] in GIT_REFLOG_WRITES:
        raise Blocked("git reflog " + rest[0])
    if sub == "branch" and any(r in ("-d", "-D", "--delete", "-m", "-M", "--move",
                                     "-c", "-C", "--copy", "-f", "--force")
                               for r in rest):
        raise Blocked("git branch (delete/move/force)")


def _check_gh(toks, i):
    rest = toks[i + 1:]
    while rest and rest[0].startswith("-") and rest[0] != "--version":
        if rest[0] in ("-R", "--repo", "--hostname") and len(rest) > 1:
            rest = rest[2:]
        else:
            rest = rest[1:]
    if not rest:
        return
    group = rest[0]
    if group == "api":
        _check_gh_api(rest[1:])
        return
    allowed = GH_ALLOW.get(group)
    if allowed is None:
        raise Blocked("gh " + group)
    if "*" in allowed:
        return
    action = rest[1] if len(rest) > 1 else ""
    if action not in allowed:
        raise Blocked(("gh %s %s" % (group, action)).strip())


def _check_gh_api(args):
    methods, body = [], None
    k = 0
    while k < len(args):
        a = args[k]
        if a.startswith("--"):
            name, eq, val = a.partition("=")
            if name == "--method":
                if not eq:
                    k += 1
                    val = args[k] if k < len(args) else ""
                methods.append(val)
            elif name in GH_API_BODY_LONG:
                body = name
        elif a.startswith("-") and len(a) > 1:
            cluster = a[1:]
            for n, c in enumerate(cluster):
                if c in GH_API_VALUE_SHORT:
                    val = cluster[n + 1:]
                    if not val:
                        k += 1
                        val = args[k] if k < len(args) else ""
                    if c == "X":
                        methods.append(val)
                    elif c in "fF":
                        body = "-" + c
                    break
        elif a.rsplit("/", 1)[-1] == "graphql":
            raise Blocked("gh api graphql")
        k += 1
    bad = [m for m in methods if m.upper() != "GET"]
    if bad:
        raise Blocked("gh api -X " + bad[0])
    if body and not methods:
        raise Blocked("gh api with a body flag %s (defaults to POST)" % body)


def _long_match(name, options):
    """Exact long option, or a prefix of one (>= 5 chars, e.g. `--dat`)."""
    if name in options:
        return name
    if len(name) >= 5:
        for o in options:
            if o.startswith(name):
                return o
    return None


def _check_curl(toks, i):
    args = toks[i + 1:]
    k = 0
    while k < len(args):
        a = args[k]
        if a.startswith("--"):
            name, eq, val = a.partition("=")
            if name == "--request" or _long_match(name, {"--request"}):
                if not eq:
                    k += 1
                    val = args[k] if k < len(args) else ""
                if val.upper() not in ("GET", "HEAD"):
                    raise Blocked("curl --request " + val)
            else:
                hit = _long_match(name, CURL_BODY_LONG)
                if hit:
                    raise Blocked("curl " + hit)
        elif a.startswith("-") and len(a) > 1:
            cluster = a[1:]
            for n, c in enumerate(cluster):
                if c == "K":
                    raise Blocked("curl -K (config file)")
                if c in CURL_BODY_SHORT:
                    raise Blocked("curl -" + c + " (request body)")
                if c in CURL_VALUE_SHORT:
                    val = cluster[n + 1:]
                    if not val:
                        k += 1
                        val = args[k] if k < len(args) else ""
                    if c == "X" and val.upper() not in ("GET", "HEAD"):
                        raise Blocked("curl -X " + val)
                    break
        k += 1


def _check_wget(toks, i):
    for a in toks[i + 1:]:
        if a.startswith("--"):
            hit = _long_match(a.split("=", 1)[0], WGET_BLOCKED_LONG)
            if hit:
                raise Blocked("wget " + hit)


CHECKS = {"git": _check_git, "gh": _check_gh, "curl": _check_curl,
          "wget": _check_wget}


def _scan(command, depth):
    if depth > MAX_DEPTH:
        raise Blocked("command nested too deeply to check")
    text = _strip_data_heredocs(command) if depth == 0 else command
    for toks in _lex(text, nested=depth > 0):
        for i, tok in enumerate(toks):
            m = ENV_ASSIGN.match(tok)
            if m and all(ENV_ASSIGN.match(t) or t in ASSIGN_PREFIX
                         for t in toks[:i]):
                var, val = m.groups()
                if var.startswith("GIT_CONFIG"):
                    raise Blocked(var + " (environment git config can define aliases)")
                if _name(val.strip()):
                    raise Blocked("variable %s holds a guarded command name" % var)
            name = _name(tok)
            if name:
                if "xargs" in toks[:i] or "parallel" in toks[:i]:
                    raise Blocked("%s run by xargs (its arguments come from stdin)" % name)
                CHECKS[name](toks, i)
            if WORD_NEEDS_RESCAN.search(tok):
                _scan(tok, depth + 1)


def violation(command):
    """Return a reason string if `command` would write, else None."""
    try:
        _scan(command, 0)
    except Blocked as exc:
        return str(exc)
    return None


def main(stdin=None):
    try:
        data = json.loads((stdin or sys.stdin).read())
        if not isinstance(data, dict):
            raise ValueError("hook input is not a JSON object")
        if data.get("tool_name") != "Bash":
            return 0
        cmd = (data.get("tool_input") or {}).get("command")
        if not isinstance(cmd, str):
            raise ValueError("Bash call without a command string")
        why = violation(cmd)
    except Exception as exc:  # fail closed
        sys.stderr.write("agent_readonly_guard: blocked (fail closed): %s\n" % exc)
        return 2
    if why:
        sys.stderr.write(
            "agent_readonly_guard: blocked: %s. This agent is read-only "
            "(#389; AGENTS.md reviewer rules): no git/GitHub writes. If the "
            "command only mentions the words (e.g. grep), rephrase it.\n" % why)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
