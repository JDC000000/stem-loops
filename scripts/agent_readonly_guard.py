#!/usr/bin/env python3
"""PreToolUse hook: keep the `code-reviewer` and `security` agents read-only (#389).

Wired from the `hooks:` block in `.claude/agents/code-reviewer.md` and
`.claude/agents/security.md` (frontmatter hooks run only while that subagent
is active, https://code.claude.com/docs/en/sub-agents). Those agents keep Bash
because reviews must run tests and executed mutants, so this hook vetoes the
Bash calls that would change the repo history, a remote, or GitHub state:

- git: push, commit, merge, rebase, reset, cherry-pick, revert, am, tag,
  update-ref, filter-branch/-repo, replace, notes, commit-tree, config writes,
  remote add/set-url/..., and any `-c alias.*` (an alias could hide a push);
- gh: everything outside a read-only allowlist; `gh api` only as GET
  (no -X/--method other than GET, no -f/-F/--field/--raw-field/--input
  unless `-X GET`), never `gh api graphql`;
- curl/wget with a write method or a body.

Hook contract (https://code.claude.com/docs/en/hooks): JSON on stdin with
`tool_name` and `tool_input.command`; exit 2 blocks the call and stderr is
shown to the agent. It fails closed: bad JSON, a missing command or any
internal error also exits 2.

Detection is token-based and deliberately over-broad: quotes and backslashes
are dropped and shell operators split segments, so `bash -c "git push"`,
`g''it push`, `flock L git -C x push` and `$(git push)` are caught. Text that
merely mentions a blocked command (e.g. `grep "git push" f`) is also blocked;
rephrase it (`grep push f`). Heredoc bodies written with `cat`/`tee` to a file
are data and are not scanned. This is a tripwire against accidental or
prompt-injected writes, not a sandbox: a program that builds the command at
run time (python subprocess with string concatenation, an env var holding
"push") is not caught. The settings.json deny list still applies on top.
"""
import json
import re
import sys

GIT_BLOCKED = {
    "push", "commit", "merge", "rebase", "reset", "cherry-pick", "revert",
    "am", "tag", "update-ref", "filter-branch", "filter-repo", "replace",
    "notes", "commit-tree", "send-email", "symbolic-ref", "pull",
}
GIT_OPTS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace",
                       "--config-env", "--super-prefix"}
GIT_REMOTE_WRITES = {"add", "remove", "rm", "rename", "set-url", "set-head",
                     "set-branches", "prune", "update"}
GIT_CONFIG_READS = {"--get", "--get-all", "--get-regexp", "--get-urlmatch",
                    "--list", "-l", "get", "list"}

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
GH_API_BODY_FLAGS = {"-f", "-F", "--field", "--raw-field", "--input"}

CURL_BODY_FLAGS = {"-d", "--data", "--data-raw", "--data-binary",
                   "--data-urlencode", "--data-ascii", "-F", "--form",
                   "--form-string", "-T", "--upload-file", "--json"}

SEP = re.compile(r"[;&|()`{}<>\n$]")
HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def _strip_data_heredocs(cmd):
    """Drop heredoc bodies fed to `cat`/`tee` (file data, not commands).

    A heredoc whose header line pipes anywhere, or whose command is not
    cat/tee, keeps its body so `bash <<EOF ... EOF` is still scanned.
    """
    lines = cmd.split("\n")
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = HEREDOC.search(line)
        i += 1
        if not m:
            continue
        head = line.strip().split()
        is_data = (head and head[0] in ("cat", "tee") and "|" not in line
                   and len(HEREDOC.findall(line)) == 1)
        if not is_data:
            continue
        delim = m.group(2)
        while i < len(lines) and lines[i].strip() != delim:
            i += 1
        i += 1  # skip the delimiter line itself
    return "\n".join(out)


def _segments(cmd):
    flat = cmd.replace("\\\n", " ")
    flat = flat.replace("'", "").replace('"', "").replace("\\", "")
    for seg in SEP.split(flat):
        toks = seg.split()
        if toks:
            yield toks


def _base(tok):
    return tok.rsplit("/", 1)[-1]


def _check_git(toks, i):
    j = i + 1
    while j < len(toks) and toks[j].startswith("-"):
        opt = toks[j]
        name, _, val = opt.partition("=")
        if name in GIT_OPTS_WITH_VALUE:
            if not _:
                j += 1
                val = toks[j] if j < len(toks) else ""
            if name in ("-c", "--config-env") and val.lower().startswith("alias."):
                return "git -c alias.* (an alias can hide a write)"
        j += 1
    if j >= len(toks):
        return None
    sub = toks[j]
    if sub in GIT_BLOCKED:
        return "git " + sub
    rest = toks[j + 1:]
    if sub == "remote" and rest and rest[0] in GIT_REMOTE_WRITES:
        return "git remote " + rest[0]
    if sub == "config":
        if not any(r in GIT_CONFIG_READS for r in rest):
            return "git config (write)"
    if sub == "branch" and any(r in ("-d", "-D", "--delete", "-m", "-M", "--move",
                                     "-c", "-C", "--copy", "-f", "--force")
                               for r in rest):
        return "git branch (delete/move/force)"
    return None


def _check_gh(toks, i):
    rest = toks[i + 1:]
    # skip gh global flags such as -R owner/repo / --repo x
    while rest and rest[0].startswith("-") and rest[0] not in ("--version",):
        if rest[0] in ("-R", "--repo", "--hostname") and len(rest) > 1:
            rest = rest[2:]
        else:
            rest = rest[1:]
    if not rest:
        return None
    group = rest[0]
    if group == "api":
        args = rest[1:]
        if any(_base(a) == "graphql" for a in args):
            return "gh api graphql"
        method = None
        for k, a in enumerate(args):
            if a in ("-X", "--method"):
                method = args[k + 1] if k + 1 < len(args) else ""
            elif a.startswith("--method="):
                method = a.split("=", 1)[1]
            elif a.startswith("-X") and len(a) > 2:
                method = a[2:]
        if method is not None and method.upper() != "GET":
            return "gh api -X " + method
        if method is None:
            for a in args:
                name = a.split("=", 1)[0]
                if name in GH_API_BODY_FLAGS or (
                        len(a) > 2 and a[:2] in ("-f", "-F") and not a.startswith("--")):
                    return "gh api with a body flag (defaults to POST)"
        return None
    allowed = GH_ALLOW.get(group)
    if allowed is None:
        return "gh " + group
    if "*" in allowed:
        return None
    action = rest[1] if len(rest) > 1 else ""
    if action not in allowed:
        return ("gh %s %s" % (group, action)).strip()
    return None


def _check_curl(toks, i):
    args = toks[i + 1:]
    for k, a in enumerate(args):
        name = a.split("=", 1)[0]
        if a in ("-X", "--request"):
            m = args[k + 1] if k + 1 < len(args) else ""
            if m.upper() not in ("GET", "HEAD"):
                return "curl -X " + m
        elif a.startswith("-X") and len(a) > 2 and a[2:].upper() not in ("GET", "HEAD"):
            return "curl " + a
        elif name in CURL_BODY_FLAGS:
            return "curl with a body (" + name + ")"
    return None


def _check_wget(toks, i):
    for a in toks[i + 1:]:
        name = a.split("=", 1)[0]
        if name in ("--post-data", "--post-file", "--method", "--body-data",
                    "--body-file"):
            return "wget " + name
    return None


CHECKS = {"git": _check_git, "gh": _check_gh, "curl": _check_curl,
          "wget": _check_wget}


def violation(command):
    """Return a reason string if `command` would write, else None."""
    for toks in _segments(_strip_data_heredocs(command)):
        for i, tok in enumerate(toks):
            fn = CHECKS.get(_base(tok))
            if fn:
                why = fn(toks, i)
                if why:
                    return why
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
