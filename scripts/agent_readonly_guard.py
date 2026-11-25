#!/usr/bin/env python3
"""PreToolUse hook: keep the `code-reviewer` and `security` agents read-only (#389).

Wired from the `hooks:` block in `.claude/agents/code-reviewer.md` and
`.claude/agents/security.md` (frontmatter hooks run only while that subagent
is active, https://code.claude.com/docs/en/sub-agents). Those agents keep Bash
because reviews must run tests and executed mutants, so this hook vetoes the
Bash calls that could change repo history, a remote, or GitHub state.

Design (R3 + #446, fail closed by construction)
------------------------------------------------
0. Coarse pre-filter (`_coarse`, #446 R1). Delete quotes and backslashes
   from the command (so g''it, g\\it and "git" all read as git). If that text
   names any guarded program (git, gh, curl, wget, git-*, a shell, an
   interpreter, eval, source, `.`, exec wrappers such as env/flock/xargs/
   timeout/trap, find -exec) AND the raw command has any of `$(`, `$((`,
   `${`, `$[`, a backtick, `<<<`, `<(`/`>(`, a heredoc whose delimiter is not
   fully single-quoted, a pipe into sh/bash/./source, /dev/stdin, eval, trap,
   source, `-c` after a shell or flock, or does not parse, it is blocked
   outright. The one exemption is the body of `cat > <file> <<'EOF'` (alone
   on its line, delimiter fully single-quoted, closed): it is data. Only what
   passes this filter reaches the finer rules below.
1. A small shell lexer splits the command into simple commands (on
   ; & | && || ( ) newline) and words, removing quotes. While lexing it marks
   a command UNRESOLVED when it contains anything whose value the lexer cannot
   know: an unquoted or double-quoted `$` (variables, `${..}`, `$(..)`,
   `$'..'`, `$((..))`), a backtick, an unquoted `{` `}` (brace expansion,
   groups) or glob `* ? [`, a redirect `<` `>` (incl. `<(..)`/`>(..)`, a
   here-string and an unclosed heredoc), and `$`/backtick expansion inside a
   heredoc whose delimiter is unquoted (bash expands that body). `$(..)`,
   backticks (also inside an unquoted heredoc body), `<(..)`/`>(..)` bodies
   and `#` comments are also scanned as commands of their own. The heredoc
   delimiter is read with bash's quote removal (`<<E"O"F` ends at `EOF`). A
   parse error (unclosed quote or substitution) blocks if the text mentions a
   guarded program at all.
2. A command is GUARDED when any literal word names git, gh, curl or wget
   (by basename, so absolute paths count, and git's dashed programs such as
   /usr/lib/git-core/git-push are checked as `git push`), a shell or
   interpreter (bash/sh/..., python/node/perl/ruby/php/bun/deno/lua), or
   when its command word is an exec wrapper (env, flock, timeout, xargs,
   find, trap, ...). Shell option values (`-o pipefail`, `-euo pipefail`)
   and interpreter option values (`node -r x`, `ruby -I d`) are skipped so
   the inline code after them is found; code loaded by `--require`/`--import`
   values is checked too.
3. Block when: a guarded command is UNRESOLVED; the command word itself is
   not literal (`$X push`, `"$G" pr merge`); a variable is assigned a guarded
   program name (`X=git`, `alias g=git`) or GIT_CONFIG_*; a guarded program
   is run by xargs/parallel (arguments from stdin); a shell or interpreter
   reads code from a pipe (`... | sh`, `... | python3`).
4. Only fully literal argument lists reach the per-program rules:
   - git: subcommand allowlist (reads and local working-tree ops); every
     value-taking global option is skipped as option + value; `-c alias.*`,
     config writes, remote writes, branch delete/move/force, reflog writes
     are blocked; anything off the allowlist (push, commit, send-pack, an
     alias, ...) is blocked.
   - gh: read allowlist; `gh api` only as GET (any non-GET -X/--method, or a
     body flag -f/-F/--field/--raw-field/--input without -X GET, blocks;
     short-flag clusters such as -iX/-if are expanded; every value option,
     short or long, consumes its value, so `--jq -XGET` is not a method; a
     body flag next to an unknown long option blocks); never graphql;
     `gh auth status --show-token`/`-t` blocks (prints a token).
   - git long options also match as abbreviations (`branch --del`,
     `config --uns`, `fetch --upload-pa`, `clone --conf`, `init --templ`);
     program names match case-insensitively and with a trailing `/`.
   - curl: no write method, body (-d/-F/-T/--data*/--form*/--json/
     --upload-file), config (-K/--config), --variable, and `--expand-<opt>`
     is treated as `--<opt>`. Short-flag clusters are expanded.
   - wget: no -e/--execute (wgetrc commands such as method=POST), and no
     --method/--post-*/--body-*/--config or any GNU-style prefix of them.
   - inline interpreter code (python -c, node -e, perl -e, ruby -e, php -r,
     or a heredoc / stdin body) that mentions process or network APIs
     (subprocess, os.system, urllib, http.client, requests, socket,
     child_process, fetch, exec/eval/__import__, ...) is blocked.
   - every other literal word that contains spaces or shell operators is
     re-scanned as a command (so `bash -c "git push"`, `eval "git push"`,
     `python3 -c '["git","push"]'` are caught), and so is its tail after a
     short option, `=` or `!` (`env -S"git push"`, `--opt=exec='git push'`,
     `vim -c ':!git push'`). A non-literal word of that kind that mentions a
     guarded program blocks (`trap "git -C $W push" EXIT`).
   - curl long options match any prefix (`--js` = `--json`, `--up` =
     `--upload-file`); `git clone -c` takes only the `git -c` key allowlist;
     `git config --comment` is a write; `wget --use-askpass` is blocked.
5. Heredoc bodies of `cat`/`tee` are data (only when closed; with an unquoted
   delimiter their `$(..)`/backtick parts are commands, rule 1); of a shell
   they are commands; of an interpreter they are code (rule 4), and an
   unquoted delimiter with any expansion in the body blocks; of anything else
   they are re-scanned.

Over-blocking is the price of failing closed. Rephrase a blocked read:
literal values instead of `$VAR`/`$(..)`/`{owner}` next to git/gh/curl/wget
(`gh api repos/JDC000000/stem-loops/...`), a pipe instead of a redirect
(`git log | tee /tmp/x`), quoted globs (`git diff -- 'scripts/*.py'`), and
`grep push f` instead of `grep "git push" f` (a word that only mentions a
blocked command is still blocked).

Hook contract (https://code.claude.com/docs/en/hooks): JSON on stdin with
`tool_name` and `tool_input.command`; only exit 2 blocks the call. Every
failure in here (bad JSON, missing command, internal error, nesting too deep)
exits 2, and the frontmatter wrapper maps a missing python3, a missing guard
file and any other non-zero exit to 2.

Known limits (a tripwire, not a sandbox): a script file written first and run
later (`cat > p.sh <<EOF ...`, then `sh p.sh` or `python3 p.py`; scripts
named on the command line are not read); HTTP or git clients other than
git/gh/curl/wget and the listed interpreters (e.g. `http`/httpie, `aria2c`,
`nc`, `openssl s_client`, `ssh`, `rsync`, `awk` system(), `make` targets,
`npm`/`pnpm`/`bun run` scripts, compiled binaries); code that hides a module
or function name from the NET_CODE pattern in a listed language (the pattern
now also covers `http`/`https` module names, `node:` specifiers, ESM
`import .. from`, `data:` URLs, `file_get_contents`/`stream_context`/`fopen`,
`Bun.`/`Deno.`; string-built names are still missed); git options newer than
the installed git that write (the allowlist is by subcommand); a shell that
does not honour `#` comments (comment text is scanned, so only a write split
across a comment and the next word would be missed); and, when
$CLAUDE_PROJECT_DIR has no guard file, a guard edited by the PR under review
(the wrapper then uses the cwd's git toplevel). The settings.json deny list
still applies on top.
"""
import json
import re
import sys

GUARDED = ("git", "gh", "curl", "wget")
SHELLS = {"bash", "sh", "dash", "zsh", "ksh", "mksh", "ash", "busybox"}
INTERP_RE = re.compile(r"^(python[0-9.]*|pypy[0-9.]*|node|nodejs|perl[0-9.]*|"
                       r"ruby[0-9.]*|php[0-9.]*|bun|deno|lua[0-9.]*|luajit)$")
INLINE_FLAGS = {"python": "c", "pypy": "c", "node": "ep", "perl": "eE",
                "ruby": "e", "php": "r", "bun": "ep", "deno": "", "lua": "e"}
INLINE_LONG = {"--eval", "--print"}
# short flags whose value is the next word (so it is not read as a script name)
VALUE_FLAGS = {"python": "WXQ", "pypy": "WXQ", "node": "r", "perl": "IMmx",
               "ruby": "rICEFKTWx", "php": "cdz", "bun": "r", "deno": "",
               "lua": "l"}
# long options whose value is the next word; values that load code are checked
VALUE_LONG = {"--require", "--import", "--loader", "--experimental-loader",
              "--conditions", "--input-type", "--preload", "--config", "--cwd",
              "--env-file"}
CODE_LONG = {"--require", "--import", "--loader", "--experimental-loader",
             "--preload"}
WRAPPERS = {"env", "flock", "timeout", "xargs", "nohup", "sudo", "doas",
            "nice", "ionice", "stdbuf", "time", "command", "exec", "builtin",
            "watch", "find", "parallel", "script", "strace", "ltrace",
            "setsid", "taskset", "unbuffer", "chronic", "eval", "chroot",
            "runuser", "su", "ssh", "fakeroot", "unshare", "nsenter",
            "trap"}
KEYWORDS = {"then", "do", "else", "elif", "if", "while", "until", "!", "{",
            "time"}
ASSIGN_PREFIX = {"env", "export", "declare", "local", "readonly", "typeset",
                 "alias"}
NET_CODE = re.compile(
    r"urllib|http\.client|httplib|\brequests\b|httpx|aiohttp|\bsocket|"
    r"subprocess|os\s*\.\s*(system|popen|exec|spawn|fork|posix_spawn)|"
    r"\bpty\b|__import__|importlib|\bexec\s*\(|\beval\s*\(|\bcompile\s*\(|"
    r"child_process|require\s*\(|\bimport\s*\(|\bfetch\s*\(|XMLHttpRequest|"
    r"Net::|LWP|HTTP::|IO::Socket|open-uri|Open3|\bsystem\b|\bspawn\b|"
    r"popen|\bexec\b|`|%x|\bcurl_|fsockopen|proc_open|shell_exec|passthru|"
    r"\bhttps?\b(?!://)|node:|\bdata:|file_get_contents|stream_context|"
    r"\b(exec|spawn)[lv]p?e?\b|\bforkpty\b|\bfopen\b|\bBun\.|\bDeno\.|\bimport\s+[\w{}*,\s]+?\s+from\s",
    re.I)
MENTION = re.compile(r"\b(git|gh|curl|wget|python[0-9.]*|node|perl|ruby|php|"
                     r"bun|deno|lua|bash|sh|zsh|eval)\b")

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
GIT_CONFIG_WRITES = {"--add", "--comment", "--unset", "--unset-all", "--replace-all",
                     "--rename-section", "--remove-section", "--edit", "-e",
                     "set", "unset", "edit", "rename-section", "remove-section"}
GIT_REFLOG_WRITES = {"expire", "delete", "drop"}
# `git -c key=value`: only these keys (others can run commands, e.g.
# core.sshCommand, credential.helper=!cmd, core.hooksPath, diff.external).
GIT_C_KEYS = {"safe.directory", "core.quotepath", "color.ui", "core.abbrev",
              "advice.detachedhead", "log.showsignature", "user.name",
              "user.email", "init.defaultbranch", "core.pager"}
# git options that make git run a program of the caller's choice
GIT_EXEC_OPTS = {"--upload-pack", "--receive-pack", "--exec", "--template",
                 "--open-files-in-pager", "--ext-diff", "--extcmd", "--tool"}
# environment that makes git/gh/shells run something else
DANGEROUS_ENV = re.compile(r"^(GIT_.*|GH_.*|.*PAGER|EDITOR|VISUAL|LESSOPEN|"
                           r"LESSCLOSE|BASH_ENV|ENV|LD_PRELOAD|LD_LIBRARY_PATH|"
                           r"PATH|SSH_ASKPASS|PYTHONSTARTUP|PYTHONPATH|"
                           r"NODE_OPTIONS|PERL5OPT|RUBYOPT|BROWSER)$")

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
GH_API_VALUE_SHORT = set("XfFHpqt")
GH_API_BODY_LONG = {"--field", "--raw-field", "--input"}

CURL_VALUE_SHORT = set("AbcCdDeEFHKmoPQrTuUwxXyYzt")
CURL_BODY_SHORT = set("dFT")
CURL_BLOCKED_LONG = {"--data", "--data-raw", "--data-binary", "--data-urlencode",
                     "--data-ascii", "--form", "--form-string", "--upload-file",
                     "--json", "--config", "--variable"}
WGET_BLOCKED_LONG = {"--post-data", "--post-file", "--method", "--body-data",
                     "--body-file", "--config", "--execute",
                     "--use-askpass"}

ENV_ASSIGN = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", re.S)
RESCAN = re.compile(r"[\s;&|(){}<>$`\[\],]")
MAX_DEPTH = 8


class Blocked(Exception):
    pass


class ParseError(Exception):
    pass


class Cmd:
    """One simple command: words after quote removal, and what is unresolved."""

    def __init__(self):
        self.words = []
        self.literal = []
        self.unresolved = []
        self.heredocs = []       # (body, closed)

    def add_word(self, text, literal):
        self.words.append(text)
        self.literal.append(literal)


def _match_close(text, i, open_ch, close_ch):
    """Index of the bracket closing text[i] (== open_ch), honouring quotes."""
    depth, j, q = 0, i, None
    while j < len(text):
        c = text[j]
        if q:
            if c == "\\" and q == '"':
                j += 1
            elif c == q:
                q = None
        elif c in ("'", '"'):
            q = c
        elif c == "\\":
            j += 1
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return j
        j += 1
    raise ParseError("unclosed %s" % open_ch)


def _backtick_end(text, i):
    j = i + 1
    while j < len(text):
        if text[j] == "\\":
            j += 2
            continue
        if text[j] == "`":
            return j
        j += 1
    raise ParseError("unclosed backtick")


def _heredoc_word(text, i):
    """Parse the heredoc delimiter word at text[i:] the way bash does: quote
    removal over the whole word (`E"O"F` is `EOF`), quoted if any quote or
    backslash appears. Return (delimiter, quoted, index after the word)."""
    n = len(text)
    while i < n and text[i] in " \t":
        i += 1
    out, quoted = [], False
    while i < n and not text[i].isspace() and text[i] not in "<>;&|()":
        c = text[i]
        if c == "'":
            k = text.find("'", i + 1)
            if k < 0:
                raise ParseError("unclosed ' in heredoc delimiter")
            out.append(text[i + 1:k])
            quoted, i = True, k + 1
        elif c == '"':
            k = i + 1
            while k < n and text[k] != '"':
                if text[k] == "\\" and k + 1 < n:
                    k += 1
                out.append(text[k])
                k += 1
            if k >= n:
                raise ParseError('unclosed " in heredoc delimiter')
            quoted, i = True, k + 1
        elif c == "\\":
            if i + 1 < n:
                out.append(text[i + 1])
            quoted, i = True, i + 2
        else:
            out.append(c)
            i += 1
    if not out:
        raise ParseError("bad heredoc")
    return "".join(out), quoted, i


def _heredoc_expansions(body):
    """An unquoted-delimiter heredoc body is expanded by the shell: return
    (substitution bodies to scan as commands, whether anything expands)."""
    subs, expands, j, n = [], False, 0, len(body)
    while j < n:
        c = body[j]
        if c == "\\":
            j += 2
            continue
        if c == "$" and j + 1 < n and (body[j + 1] in "({'" or body[j + 1] == "_"
                                       or body[j + 1].isalnum()
                                       or body[j + 1] in "#?@*!$-"):
            expands = True
            if body[j + 1] == "(":
                end = _match_close(body, j + 1, "(", ")")
                inner = body[j + 2:end]
                if not inner.startswith("("):
                    subs.append(inner)
                j = end + 1
                continue
            if body[j + 1] == "{":
                j = _match_close(body, j + 1, "{", "}") + 1
                continue
        elif c == "`":
            end = _backtick_end(body, j)
            subs.append(body[j + 1:end])
            expands = True
            j = end + 1
            continue
        j += 1
    return subs, expands


def _lex(text, nested):
    """Return (commands, substitution bodies). Raises ParseError."""
    cmds, subs = [], []
    state = {"cur": Cmd(), "word": [], "has": False, "lit": True}
    pending = []
    blanks = set("[],") if nested else set()
    n = len(text)

    def cur():
        return state["cur"]

    def add(s):
        state["word"].append(s)
        state["has"] = True

    def unresolved(reason):
        state["lit"] = False
        cur().unresolved.append(reason)

    def end_word():
        if state["has"]:
            cur().add_word("".join(state["word"]), state["lit"])
        state["word"], state["has"], state["lit"] = [], False, True

    def end_cmd():
        end_word()
        c = cur()
        if (c.words or c.unresolved or c.heredocs) and c not in cmds:
            cmds.append(c)
        state["cur"] = Cmd()

    def dollar(j, in_dq):
        """Handle `$` at text[j]; return the index of the last consumed char."""
        unresolved("$ expansion")
        state["has"] = True
        nxt = text[j + 1] if j + 1 < n else ""
        if nxt == "(":
            end = _match_close(text, j + 1, "(", ")")
            inner = text[j + 2:end]
            if not inner.startswith("("):      # $(( )) is arithmetic
                subs.append(inner)
            add("$(..)")                         # its body is scanned on its own
            return end
        if nxt == "{":
            end = _match_close(text, j + 1, "{", "}")
            add(text[j:end + 1])
            return end
        if nxt == "'" and not in_dq:
            k = text.find("'", j + 2)
            if k < 0:
                raise ParseError("unclosed $'")
            add(text[j + 2:k])
            return k
        add("$")
        return j

    i = 0
    while i < n:
        c = text[i]
        if c == "#" and not state["has"] and not nested:
            # a comment runs to the end of the line; its text is still
            # scanned as a command (fail closed if a shell does not honour it)
            k = text.find("\n", i)
            k = n if k < 0 else k
            subs.append(text[i + 1:k])
            i = k
            continue
        if c == "'":
            k = text.find("'", i + 1)
            if k < 0:
                raise ParseError("unclosed '")
            add(text[i + 1:k])
            i = k + 1
            continue
        if c == '"':
            state["has"] = True
            j = i + 1
            while True:
                if j >= n:
                    raise ParseError('unclosed "')
                d = text[j]
                if d == '"':
                    break
                if d == "\\" and j + 1 < n and text[j + 1] in '"\\$`\n':
                    if text[j + 1] != "\n":
                        add(text[j + 1])
                    j += 2
                    continue
                if d == "$":
                    j = dollar(j, True) + 1
                    continue
                if d == "`":
                    end = _backtick_end(text, j)
                    subs.append(text[j + 1:end])
                    unresolved("backtick")
                    j = end + 1
                    continue
                add(d)
                j += 1
            i = j + 1
            continue
        if c == "\\":
            if i + 1 < n and text[i + 1] != "\n":
                add(text[i + 1])
            i += 2
            continue
        if c == "$":
            i = dollar(i, False) + 1
            continue
        if c == "`":
            end = _backtick_end(text, i)
            subs.append(text[i + 1:end])
            state["has"] = True
            unresolved("backtick")
            i = end + 1
            continue
        if c in "<>":
            end_word()
            if i + 1 < n and text[i + 1] == "(":
                end = _match_close(text, i + 1, "(", ")")
                subs.append(text[i + 2:end])
                cur().unresolved.append("process substitution")
                i = end + 1
                continue
            if text.startswith("<<", i) and not text.startswith("<<<", i):
                strip_tabs = text.startswith("<<-", i)
                delim, quoted, i = _heredoc_word(text, i + (3 if strip_tabs else 2))
                pending.append((delim, strip_tabs, quoted, cur()))
                continue
            cur().unresolved.append("redirect")
            if text.startswith("<<<", i):       # here-string: the word is lexed
                i += 3
                continue
            i += 1
            while i < n and text[i] in "&>|":
                i += 1
            continue
        if c == "\n" and pending:
            end_cmd()
            pos = i + 1
            for delim, strip_tabs, quoted, owner in pending:
                lines, closed = [], False
                while pos < n:
                    nl = text.find("\n", pos)
                    line = text[pos:] if nl < 0 else text[pos:nl]
                    pos = n if nl < 0 else nl + 1
                    if (line.lstrip("\t") if strip_tabs else line) == delim:
                        closed = True
                        break
                    lines.append(line)
                body = "\n".join(lines)
                owner.heredocs.append((body, closed))
                if not quoted:
                    # unquoted delimiter: bash expands $.. and `..` in the body
                    inner, expands = _heredoc_expansions(body)
                    subs.extend(inner)
                    if expands:
                        owner.unresolved.append("expansion in an unquoted heredoc")
                if not closed:
                    owner.unresolved.append("unclosed heredoc")
                if owner not in cmds:
                    cmds.append(owner)
            pending = []
            i = pos
            continue
        if c in ";&|()\n":
            end_cmd()
            i += 1
            continue
        if c.isspace() or c in blanks:
            end_word()
            i += 1
            continue
        if c in "{}*?[" and not nested:
            m = re.match(r"(\[\[|\[|\{|\})(?=[\s;&|]|$)", text[i:])
            if not state["has"] and m:
                add(m.group(1))         # test `[ ]` or a `{ ...; }` group
                i += m.end()
                continue
            unresolved("brace/glob")
        add(c)
        i += 1
    end_cmd()
    for _, _, _, owner in pending:
        owner.unresolved.append("unclosed heredoc")
        owner.heredocs.append(("", False))
        if owner not in cmds:
            cmds.append(owner)
    return cmds, subs


def _base(w):
    return w.rstrip("/").rsplit("/", 1)[-1]


GIT_DASHED = re.compile(r"^git-([a-z][a-z0-9-]*)$", re.I)


def _git_dashed(w):
    """`git-push` (e.g. /usr/lib/git-core/git-push) runs as `git push`."""
    m = GIT_DASHED.match(_base(w))
    sub = m.group(1).lower() if m else None
    return sub if sub and sub != "core" else None


def _name(w):
    b = _base(w).lower()                # case-insensitive file systems
    if b in GUARDED:
        return b
    return "git" if _git_dashed(w) else None


def _interp_family(w):
    m = INTERP_RE.match(_base(w))
    if not m:
        return None
    for fam in INLINE_FLAGS:
        if m.group(1).startswith(fam):
            return fam
    return None


def _inline_code(words, i, fam):
    """Return (code or None, reads_stdin) for the interpreter at words[i]."""
    flags, vflags = INLINE_FLAGS[fam], VALUE_FLAGS[fam]
    k = i + 1
    while k < len(words):
        a = words[k]
        if a in INLINE_LONG:
            return (words[k + 1] if k + 1 < len(words) else ""), False
        if a.startswith("--eval=") or a.startswith("--print="):
            return a.split("=", 1)[1], False
        if a == "-":
            return None, True
        if a.startswith("--"):
            name, eq, val = a.partition("=")
            if name in VALUE_LONG and not eq:
                k += 1
                val = words[k] if k < len(words) else ""
            if name in CODE_LONG:
                _check_code(val, words[i] + " " + name)
        elif a.startswith("-") and len(a) > 1:
            for p, ch in enumerate(a[1:]):
                if ch in flags:
                    rest = a[p + 2:]
                    if rest:
                        return rest, False
                    return (words[k + 1] if k + 1 < len(words) else ""), False
                if ch in vflags:
                    if not a[p + 2:]:
                        k += 1          # the value is the next word
                    break
            if fam in ("python", "pypy") and a == "-m":
                return None, False
        elif fam == "deno" and a == "eval":
            return (words[k + 1] if k + 1 < len(words) else ""), False
        else:
            return None, False          # a script file: not read (known limit)
        k += 1
    return None, True                   # no script: code comes from stdin


def _shell_code(words, i):
    """Return (code or None, reads_stdin) for the shell at words[i]."""
    rest = words[i + 1:]
    saw_c = saw_s = False
    p = 0
    while p < len(rest):
        a = rest[p]
        if a == "-" or a == "--":
            p += 1
            break
        if a.startswith("--"):
            if a in ("--rcfile", "--init-file") and p + 1 < len(rest):
                p += 1
        elif a[:1] in ("-", "+") and len(a) > 1:
            for ch in a[1:]:
                if ch == "c":
                    saw_c = True
                elif ch == "s":
                    saw_s = True
                elif ch in "oO":        # -o pipefail, -euo pipefail, +O x
                    p += 1
        else:
            break
        p += 1
    if saw_c:
        return (rest[p] if p < len(rest) else ""), False
    if saw_s or p >= len(rest):
        return None, True
    return None, False                  # a script file: not read (known limit)


GIT_PREFIX_EXEMPT = {"--to", "--to-cover", "--exclude", "--conflict",
                     "--contains", "--column", "--color", "--format", "--follow"}


def _git_long_hit(opt, options):
    """`opt` names one of `options` exactly or as an abbreviation (git accepts
    unique prefixes of long options)."""
    name = opt.split("=", 1)[0]
    if not name.startswith("--") or name == "--":
        return None
    if name in options:
        return name
    if len(name) >= 3 and name not in GIT_PREFIX_EXEMPT:
        for o in sorted(options):
            if o.startswith("--") and o.startswith(name):
                return o
    return None


def _check_git(toks, i):
    j = i + 1
    while j < len(toks) and toks[j].startswith("-"):
        name, eq, val = toks[j].partition("=")
        if name in GIT_OPTS_WITH_VALUE and not eq:
            j += 1
            if j >= len(toks):
                raise Blocked("git %s without a value" % name)
            val = toks[j]
        if name in ("-c", "--config-env") and val.lower().startswith("alias."):
            raise Blocked("git -c alias.* (an alias can hide a write)")
        if name == "-c" and (val.split("=", 1)[0].lower() not in GIT_C_KEYS
                             or (val.lower().startswith("core.pager")
                                 and val.split("=", 1)[-1] not in ("cat", ""))):
            raise Blocked("git -c %s (only display/identity keys allowed)"
                          % val.split("=", 1)[0])
        if name in ("--config-env", "--exec-path"):
            raise Blocked("git " + name)
        j += 1
    if j >= len(toks):
        return
    sub = toks[j]
    rest = toks[j + 1:]
    if sub not in GIT_ALLOWED:
        raise Blocked("git " + sub + ("" if sub in GIT_BLOCKED
                                       else " (not on the read-only git allowlist)"))
    for p, r in enumerate(rest):
        if sub == "clone" and (r == "-c" or _git_long_hit(r, {"--config"})
                               or (r.startswith("-c") and not r.startswith("--"))):
            val = (r.split("=", 1)[1] if r.startswith("--") and "=" in r
                   else r[2:] if len(r) > 2 and r[1] == "c"
                   else rest[p + 1] if p + 1 < len(rest) else "")
            if val.split("=", 1)[0].lower() not in GIT_C_KEYS:
                raise Blocked("git clone -c %s (only display/identity keys allowed)"
                              % val.split("=", 1)[0])
        opt = r.split("=", 1)[0]
        if _git_long_hit(opt, GIT_EXEC_OPTS - {"--tool"}) or opt == "--tool" or (sub in ("clone", "fetch", "ls-remote")
                                    and opt == "-u") or (
                sub == "grep" and opt.startswith("-O")):
            raise Blocked("git %s %s (runs a program)" % (sub, opt))
    if sub == "bisect" and rest and rest[0] == "run":
        raise Blocked("git bisect run (runs a program)")
    positional = [r for r in rest if not r.startswith("-")]
    if sub == "remote" and positional and positional[0] in GIT_REMOTE_WRITES:
        raise Blocked("git remote " + positional[0])
    if sub == "config":
        if any(r in GIT_CONFIG_WRITES or _git_long_hit(r, GIT_CONFIG_WRITES)
               for r in rest):
            raise Blocked("git config (write)")
        if not any(r in GIT_CONFIG_READS for r in rest) and len(positional) >= 2:
            raise Blocked("git config (write)")
    if sub == "reflog" and positional and positional[0] in GIT_REFLOG_WRITES:
        raise Blocked("git reflog " + positional[0])
    if sub == "branch":
        for r in rest:
            if _git_long_hit(r, {"--delete", "--move", "--copy", "--force",
                                 "--set-upstream-to", "--unset-upstream",
                                 "--edit-description"}) or (
                    r.startswith("-") and not r.startswith("--")
                    and set(r[1:]) & set("dDmMcCf")):
                raise Blocked("git branch (delete/move/copy/force)")


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
    if group == "auth" and any(a == "-t" or a.startswith("--show") or
                               (a.startswith("-") and not a.startswith("--")
                                and "t" in a[1:]) for a in rest[1:]):
        raise Blocked("gh auth status --show-token (prints a token)")
    allowed = GH_ALLOW.get(group)
    if allowed is None:
        raise Blocked("gh " + group)
    if "*" in allowed:
        return
    action = rest[1] if len(rest) > 1 else ""
    if action not in allowed:
        raise Blocked(("gh %s %s" % (group, action)).strip())


GH_API_VALUE_LONG = {"--method", "--field", "--raw-field", "--header",
                     "--preview", "--jq", "--template", "--input", "--cache",
                     "--hostname"}
GH_API_FLAG_LONG = {"--include", "--paginate", "--silent", "--slurp",
                    "--verbose", "--help"}


def _check_gh_api(args):
    """Every value option consumes its value (so `--jq -XGET` is a jq filter,
    not a method). A body flag needs an explicit GET; an unknown long option
    next to a body flag blocks (its value could hide the real method)."""
    methods, body, unknown = [], None, None
    k = 0
    while k < len(args):
        a = args[k]
        if a == "--":
            break
        if a.startswith("--"):
            name, eq, val = a.partition("=")
            if name in GH_API_VALUE_LONG and not eq:
                k += 1
                val = args[k] if k < len(args) else ""
            elif name not in GH_API_VALUE_LONG and name not in GH_API_FLAG_LONG:
                unknown = name
            if name == "--method":
                methods.append(val)
            elif name in GH_API_BODY_LONG:
                body = name
        elif a.startswith("-") and len(a) > 1:
            cluster = a[1:]
            for p, c in enumerate(cluster):
                if c in GH_API_VALUE_SHORT:
                    val = cluster[p + 1:]
                    if not val:
                        k += 1
                        val = args[k] if k < len(args) else ""
                    if c == "X":
                        methods.append(val)
                    elif c in "fF":
                        body = "-" + c
                    break
        elif _base(a) == "graphql":
            raise Blocked("gh api graphql")
        k += 1
    bad = [m for m in methods if m.upper() != "GET"]
    if bad:
        raise Blocked("gh api -X " + bad[0])
    if body and not methods:
        raise Blocked("gh api with a body flag %s (defaults to POST)" % body)
    if body and unknown:
        raise Blocked("gh api with a body flag %s and unknown option %s"
                      % (body, unknown))


def _long_prefix(name, options, minimum):
    """Exact long option, or a prefix of one (GNU getopt_long style)."""
    if name in options:
        return name
    if len(name) >= minimum:
        for o in sorted(options):
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
            if name.startswith("--expand-"):
                name = "--" + name[len("--expand-"):]
            if _long_prefix(name, {"--request"}, 3):
                if not eq:
                    k += 1
                    val = args[k] if k < len(args) else ""
                if val.upper() not in ("GET", "HEAD"):
                    raise Blocked("curl --request " + val)
            else:
                hit = _long_prefix(name, CURL_BLOCKED_LONG, 3)
                if hit:
                    raise Blocked("curl " + hit)
        elif a.startswith("-") and len(a) > 1:
            cluster = a[1:]
            for p, c in enumerate(cluster):
                if c == "K":
                    raise Blocked("curl -K (config file)")
                if c in CURL_BODY_SHORT:
                    raise Blocked("curl -" + c + " (request body)")
                if c in CURL_VALUE_SHORT:
                    val = cluster[p + 1:]
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
            hit = _long_prefix(a.split("=", 1)[0], WGET_BLOCKED_LONG, 3)
            if hit:
                raise Blocked("wget " + hit)
        elif a.startswith("-") and len(a) > 1 and "e" in a[1:]:
            raise Blocked("wget -e (wgetrc command, e.g. method=POST)")


CHECKS = {"git": _check_git, "gh": _check_gh, "curl": _check_curl,
          "wget": _check_wget}


def _check_code(code, where):
    m = NET_CODE.search(code or "")
    if m:
        raise Blocked("inline code for %s uses %r (process/network API)"
                      % (where, m.group(0)))


def _eval_cmd(cmd, depth, text):
    words, lit = cmd.words, cmd.literal
    ci = 0
    while ci < len(words) and (ENV_ASSIGN.match(words[ci])
                               or (lit[ci] and words[ci] in KEYWORDS)):
        ci += 1
    for k, w in enumerate(words):
        m = ENV_ASSIGN.match(w)
        if m and all(ENV_ASSIGN.match(t) or t in ASSIGN_PREFIX for t in words[:k]):
            var, val = m.groups()
            val = val.strip()
            if var.startswith("GIT_CONFIG"):
                raise Blocked(var + " (environment git config can define aliases)")
            if DANGEROUS_ENV.match(var) and not (var.endswith("PAGER") and val in ("cat", "")):
                raise Blocked(var + " (environment can make git/gh/a shell run a program)")
            if _name(val) or _base(val) in SHELLS or _interp_family(val):
                raise Blocked("variable %s holds a guarded program name" % var)
    if ci < len(words) and not lit[ci]:
        raise Blocked("command name is not literal (%s)" % words[ci])

    guarded = []
    for k, w in enumerate(words):
        if not lit[k]:
            continue
        if _name(w):
            guarded.append(("prog", k))
        elif _base(w) in SHELLS:
            guarded.append(("shell", k))
        elif _interp_family(w):
            guarded.append(("interp", k))
    head = _base(words[ci]) if ci < len(words) else ""
    # shells/interpreters count only when they run inline code or stdin
    inline = {}
    for kind, k in guarded:
        if kind == "shell":
            inline[k] = _shell_code(words, k)
        elif kind == "interp":
            inline[k] = _inline_code(words, k, _interp_family(words[k]))
    active = [(kind, k) for kind, k in guarded
              if kind == "prog" or inline[k][0] is not None or inline[k][1]]
    if (active or head in WRAPPERS) and cmd.unresolved:
        what = words[active[0][1]] if active else head
        raise Blocked("%s with an unresolved %s (use literal values)"
                      % (what, cmd.unresolved[0]))

    for kind, k in guarded:
        before = [_base(b) for b in words[:k]]
        if "xargs" in before or "parallel" in before:
            raise Blocked("%s run by xargs (its arguments come from stdin)" % words[k])
        if kind == "prog":
            sub = _git_dashed(words[k])
            if sub:
                _check_git(words[:k] + ["git", sub] + words[k + 1:], k)
            else:
                CHECKS[_name(words[k])](words, k)
        elif kind == "shell":
            code, stdin = inline[k]
            if code is not None:
                _scan(code, depth + 1)
            elif stdin:
                if cmd.heredocs:
                    for body, _closed in cmd.heredocs:
                        _scan(body, depth + 1)
                else:
                    raise Blocked("%s reads commands from stdin" % words[k])
        else:
            code, stdin = inline[k]
            if code is not None:
                _check_code(code, words[k])
            elif stdin:
                if cmd.heredocs:
                    for body, _closed in cmd.heredocs:
                        _check_code(body, words[k])
                elif k == ci:
                    raise Blocked("%s reads code from stdin" % words[k])

    if cmd.heredocs and not any(kind in ("shell", "interp") for kind, _ in guarded):
        for body, closed in cmd.heredocs:
            if head not in ("cat", "tee") or not closed:
                _scan(body, depth + 1)

    if "eval" in [_base(w) for w in words[:ci + 1]]:
        _scan(" ".join(words[ci + 1:]), depth + 1)
    for k, w in enumerate(words):
        if not RESCAN.search(w):
            continue
        if not lit[k]:
            m = MENTION.search(w)
            if m:
                raise Blocked("argument with an unresolved expansion mentions %s "
                              "(use literal values)" % m.group(0))
            continue
        if w.strip() != text.strip():
            _scan(w, depth + 1, nested=True)
        # a command glued to an option: env -S"git ..", --opt=exec=git ..,
        # vim -c ':!git ..'
        tails = set()
        if re.match(r"^[-+][A-Za-z]", w) and not w.startswith("--"):
            tails.add(w[2:])
        for m in re.finditer(r"[=!]", w):
            tails.add(w[m.end():])
        for t in tails:
            if RESCAN.search(t) and t.strip() and t.strip() != text.strip():
                _scan(t, depth + 1, nested=True)


def _scan(text, depth, nested=False):
    if depth > MAX_DEPTH:
        raise Blocked("command nested too deeply to check")
    try:
        cmds, subs = _lex(text, nested)
    except ParseError as exc:
        m = MENTION.search(text)
        if m:
            raise Blocked("cannot parse (%s) and it mentions %s" % (exc, m.group(0)))
        return
    for inner in subs:
        _scan(inner, depth + 1)
    for cmd in cmds:
        _eval_cmd(cmd, depth, text)


# --- coarse pre-filter (#446 R1): fail closed by construction ----------------
_TOK_PRE = r"(?:^|(?<=[\s;&|()`=/{,!]))"
_TOK_POST = r"(?=$|[\s;&|()<>`])"
COARSE_TOKEN = re.compile(
    _TOK_PRE + r"(git|gh|curl|wget|git-[A-Za-z0-9-]+|python[0-9.]*|pypy[0-9.]*|"
    r"node|nodejs|perl[0-9.]*|ruby[0-9.]*|php[0-9.]*|bun|deno|lua[0-9.]*|luajit|"
    r"sh|bash|dash|zsh|ksh|mksh|ash|busybox|eval|source|exec|xargs|parallel|env|"
    r"flock|trap|timeout|nohup|sudo|doas|nice|ionice|stdbuf|setsid|watch|"
    r"script|strace|ltrace|taskset|unbuffer|chronic|chroot|runuser|su|ssh|"
    r"fakeroot|unshare|nsenter|builtin)" + _TOK_POST, re.I)
COARSE_DOT = re.compile(r"(?:^|[;&|(\n])\s*\.(?=\s)")
COARSE_FIND = re.compile(_TOK_PRE + r"find" + _TOK_POST + r".*\s-(exec|execdir|ok|okdir)\b",
                         re.S)
COARSE_RISKY = [
    (re.compile(r"\$\("), "$( or $(( substitution"),
    (re.compile(r"`"), "backtick"),
    (re.compile(r"\$\{"), "${..} expansion"),
    (re.compile(r"\$\["), "$[..] arithmetic"),
    (re.compile(r"<<<"), "here-string"),
    (re.compile(r"[<>]\("), "process substitution"),
    (re.compile(r"\|&?\s*(sh|bash|dash|zsh|ksh|mksh|ash|busybox|source)\b"
                r"|\|&?\s*\.(?=\s|$)"), "pipe into a shell"),
    (re.compile(r"/dev/(stdin|fd/|tcp|udp)"), "/dev/stdin or /dev/fd"),
    (re.compile(_TOK_PRE + r"(eval|trap|source)" + _TOK_POST), "eval/trap/source"),
    (re.compile(_TOK_PRE + r"(sh|bash|dash|zsh|ksh|mksh|ash|busybox|flock)"
                + _TOK_POST + r"[^;&|\n]*?\s[-+][A-Za-z]*c[A-Za-z]*" + _TOK_POST),
     "-c after a shell or flock"),
]
HEREDOC_OP = re.compile(r"(?<!<)<<(?!<)-?[ \t]*([^\s;&|()<>]*)")
CAT_QUOTED_HEREDOC = re.compile(
    r"^[ \t]*(?:cat|tee(?:[ \t]+-a)?)[ \t]+(?:>>?[ \t]*)?[^\s;&|<>$`'\"\\(){}]+[ \t]+"
    r"<<(-?)'([A-Za-z0-9_.-]+)'[ \t]*$"
    r"|^[ \t]*cat[ \t]+<<(-?)'([A-Za-z0-9_.-]+)'[ \t]+>>?[ \t]*[^\s;&|<>$`'\"\\(){}]+[ \t]*$")


def _strip_review_heredocs(text):
    """Drop the body of `cat > file <<'EOF'` (one heredoc on its line, delimiter
    fully single-quoted, so bash does not expand it): that body is data. Any
    other heredoc body stays in the text the coarse filter looks at."""
    lines = text.split("\n")
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        m = CAT_QUOTED_HEREDOC.match(line)
        if m and len(HEREDOC_OP.findall(line)) == 1:
            tabs = bool(m.group(1) or m.group(3))
            delim = m.group(2) or m.group(4)
            j = i + 1
            while j < len(lines) and (lines[j].lstrip("\t") if tabs
                                      else lines[j]) != delim:
                j += 1
            if j < len(lines):           # closed: keep the cat line only
                out.append(line)
                i = j + 1
                continue
        out.append(line)
        i += 1
    return "\n".join(out)


def _coarse(command):
    """Reason to block, or None. A command that names any guarded program
    (after deleting quotes and backslashes, so g''it / g\\it / "git" count) and
    contains any construct whose effect the parser could misjudge is blocked
    outright; only the rest reaches the per-program rules."""
    raw = _strip_review_heredocs(command)
    norm = re.sub(r"\\\n", "", raw)
    norm = re.sub(r"['\"\\]", "", norm)
    tok = COARSE_TOKEN.search(norm)
    if tok:
        name = tok.group(1)
    elif COARSE_DOT.search(norm):
        name = "."
    elif COARSE_FIND.search(norm):
        name = "find -exec"
    else:
        return None
    for rx, what in COARSE_RISKY:
        if rx.search(raw):
            return "%s together with %s (fail closed; use literal values)" % (name, what)
    for m in HEREDOC_OP.finditer(raw):
        if not re.fullmatch(r"'[^']*'", m.group(1)):
            return ("%s together with an unquoted heredoc (quote the delimiter: "
                    "<<'EOF')" % name)
    try:
        _lex(command, False)
    except ParseError as exc:
        return "%s and the command cannot be parsed (%s)" % (name, exc)
    return None


def violation(command):
    """Return a reason string if `command` could write, else None."""
    if re.search(r"/dev/(tcp|udp)/", command):
        return "bash /dev/tcp or /dev/udp network redirect"
    why = _coarse(command)
    if why:
        return why
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
            "(#389; AGENTS.md reviewer rules): no git/GitHub writes. Use literal "
            "values, a pipe instead of a redirect, or rephrase a command that only "
            "mentions these words.\n" % why)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
