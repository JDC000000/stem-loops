#!/usr/bin/env bash
# PostToolUse hook: emit a single Langfuse trace per Claude Code tool call.
# Contract: Claude Code sets CLAUDE_TOOL_NAME, CLAUDE_TOOL_INPUT, CLAUDE_TOOL_RESULT.
# Fail OPEN: on any error, log one line to stderr and exit 0 — never block a tool.
# Caveat: fires only in local Claude Code CLI. Cowork sessions don't run this.
# Docs: docs/ops/langfuse-tracing.md
set -u
warn() { printf 'langfuse-trace: %s\n' "$*" >&2; }

LANGFUSE_HOST="${LANGFUSE_HOST:-https://us.cloud.langfuse.com}"
: "${LANGFUSE_PUBLIC_KEY:=}"; : "${LANGFUSE_SECRET_KEY:=}"
if [ -z "$LANGFUSE_PUBLIC_KEY" ] || [ -z "$LANGFUSE_SECRET_KEY" ]; then
  warn "LANGFUSE_PUBLIC_KEY/SECRET_KEY unset; skipping."; exit 0
fi

tool_name="${CLAUDE_TOOL_NAME:-unknown}"
redact='s/\(cookie\|token\|bearer\|session\|password\|api[_-]key\|secret\)/[REDACTED]/gI'
safe_tool="$(printf '%s' "$tool_name" | sed "$redact" | tr -c 'a-zA-Z0-9:_.-' '_' | cut -c1-120)"
in_hash="$(printf '%s' "${CLAUDE_TOOL_INPUT:-}" | sha256sum | awk '{print $1}')"
out_hash="$(printf '%s' "${CLAUDE_TOOL_RESULT:-}" | sha256sum | awk '{print $1}')"

now="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
trace_id="${GITHUB_RUN_ID:-$(date +%s)-$$}"
evt_id="evt-${trace_id}-$(date +%s%N 2>/dev/null || date +%s)-$$"

payload="{\"batch\":[{\"id\":\"${evt_id}\",\"timestamp\":\"${now}\",\"type\":\"trace-create\",\"body\":{\"id\":\"${trace_id}\",\"name\":\"tool:${safe_tool}\",\"timestamp\":\"${now}\",\"metadata\":{\"input_hash\":\"${in_hash}\",\"result_hash\":\"${out_hash}\",\"source\":\"claude-code-posttooluse\"}}}]}"

curl --max-time 2 -s -S -o /dev/null \
  -u "${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}" \
  -H 'Content-Type: application/json' \
  -X POST "${LANGFUSE_HOST%/}/api/public/ingestion" \
  -d "$payload" \
  || warn "ingestion POST failed (fail-open)."
exit 0
