# stem-loops V2 — Agent Registry

| Agent role | Scope | Input | Output |
|---|---|---|---|
| developer-custom | Full-stack implementation | tasks.md (by phase) | Working code, passing tests |
| code-review-agent | Per-milestone fresh-context review | Git diff | Review findings |
| tester-custom | QA (visual + functional + mobile) | Codebase | QA report |
| security-agent | Security pass (Tier 4) | Codebase | Security findings |

## Handoff packages

- **Phase 0 → Phase 1**: Spike results + Gate 0 sign-off (5 H-task decisions)
- **Phase 1 → Phase 2**: `make dev` working, stub job completes via UI
- **Phase 2 → Phase 3**: Real YouTube URL → loops on R2 in <60s p90
- **Phase 3 → Phase 4**: Friends can use it without help
- **Phase 4 → QA**: All 4 phases built, monitoring configured

## Module boundaries (no cross-module coupling except via types-contract)

- `web-ui` and `worker-core` NEVER share code directly — all contracts go through `packages/types`
- `audio-pipeline` is a pure function: `(job_id, youtube_url, stems, options) → loops[] on R2`
- `api-routes` never calls `audio-pipeline` directly — always via pg-boss queue

## Agent instructions

Each agent receives:
1. This registry (agent-registry.md)
2. AGENTS.md (root context)
3. The relevant phase tasks from tasks.md
4. The prior phase handoff package

Code-review-agent fires at each milestone boundary (Gates 1–4) with a fresh context — it reads the
git diff, not the session history. Security-review-agent fires once before Gate 4 cutover (T35).
