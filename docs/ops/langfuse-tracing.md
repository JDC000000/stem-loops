# Langfuse per-tool-call tracing (local Claude Code CLI)

Fleet Playbook Move 2. Emits one Langfuse trace per Claude Code tool call so
Jon can see tool-use latency, frequency, and digest-metadata on a dashboard
without plumbing a full APM.

## What this does

- `.claude/hooks.json` registers a `PostToolUse` hook (`matcher: "*"`) that
  runs after every tool invocation in the Claude Code CLI.
- The hook runs `scripts/langfuse-trace.sh`, which:
  - Reads the three env vars Claude Code sets per the hook contract:
    `CLAUDE_TOOL_NAME`, `CLAUDE_TOOL_INPUT`, `CLAUDE_TOOL_RESULT`.
  - **Hashes** the input and result bodies with `sha256sum` — the raw
    bodies never leave the machine.
  - Redacts common secret-name tokens (`cookie|token|bearer|session|
    password|api_key|secret`, case-insensitive) from the tool name before it
    is sent.
  - POSTs a single `trace-create` event to
    `${LANGFUSE_HOST}/api/public/ingestion` with Basic auth. Trace id is
    `GITHUB_RUN_ID` when present, otherwise `<epoch>-<pid>`.
  - **Fails open**: `curl --max-time 2`, no `set -e`, every error path
    logs one line to stderr and exits 0. A slow or unreachable Langfuse
    never blocks a tool call.

## What this does NOT do

- **Cowork sessions are not traced.** `.claude/hooks.json` is only read by
  the local Claude Code CLI on Jon's Mac. Cowork (claude.ai) sessions do
  not execute this hook, so tool-use inside a Cowork task leaves no trace
  in Langfuse. This is a known limitation of the hook mechanism.
- **CI runs are not traced** unless `LANGFUSE_PUBLIC_KEY` /
  `LANGFUSE_SECRET_KEY` are set as repo secrets AND the CI step uses the
  Claude Code CLI with hooks enabled. We do neither today.
- **No bodies are transmitted** — only sha256 digests of input/result and
  the sanitized tool name. If you need to correlate a trace back to a
  specific call, re-run locally and compare digests.

## Where the keys live

Langfuse credentials are **secrets**. They are NOT committed anywhere in
the repo. `.env.example` lists the variable names with blank values.

| Variable | Where |
|---|---|
| `LANGFUSE_HOST` | `~/.zshrc` (or shell env). Defaults to `https://us.cloud.langfuse.com` if unset. |
| `LANGFUSE_PUBLIC_KEY` | `~/.zshrc`. Also: Vercel + Fly secrets, IF the app ever calls Langfuse server-side (not today). |
| `LANGFUSE_SECRET_KEY` | `~/.zshrc`. Also: Vercel + Fly secrets, same condition. |

Retrieve the current values from the Langfuse project settings for
`stem-loops` at <https://us.cloud.langfuse.com>.

Local setup (one-time):

```sh
# in ~/.zshrc (or ~/.zprofile)
export LANGFUSE_HOST="https://us.cloud.langfuse.com"
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
```

Then `source ~/.zshrc` (or open a new shell) before launching `claude`.

## Acceptance test

In a terminal on the repo root, with the three env vars exported:

```sh
claude -p "list open PRs in this repo"
```

Within a few seconds, at least one trace named `tool:<tool_name>` should
appear under the `stem-loops` project at
<https://us.cloud.langfuse.com>. Each trace carries metadata:

- `input_hash` — sha256 of the tool input.
- `result_hash` — sha256 of the tool result.
- `source` — `claude-code-posttooluse`.

If no trace appears, check `stderr` of the Claude Code session for a line
starting `langfuse-trace:`. The most common causes are: keys unset, keys
wrong, or `us.cloud.langfuse.com` unreachable from the machine.

## How to disable

Either of these is enough; pick whichever leaves the smallest diff:

1. **Unset the keys.** `unset LANGFUSE_PUBLIC_KEY` in the current shell
   (or remove the export from `~/.zshrc`). The script will short-circuit
   with a single stderr warning and exit 0.
2. **Comment out the hook.** In `.claude/hooks.json`, wrap the
   `PostToolUse` block in a way that makes the JSON invalid-for-the-hook
   (e.g., rename the key to `_PostToolUse_disabled`). Claude Code reloads
   `.claude/hooks.json` on each session start.

## Rollback

Revert the PR. The hook config and script are additive and leave no
state: no DB rows, no cron, no committed credentials. The Vercel/Fly
secret store is untouched by this change.
