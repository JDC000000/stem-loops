# Parallel Work Rules (v3.3 — 2026-11-23)

**For:** the stem-loops orchestrator session and any agent it dispatches.
**Precedence:** AGENTS.md wins over this file. If project rules contradict each other, don't guess; put it in the decision brief.
**Standing rule from Jon (2026-11-23):** always run as much parallel work as these rules allow, and tell him when and how he can unlock more.

1. **Split, then label.** Break the work into tasks. Tag each PARALLEL (no shared files, no dependency) or SERIAL. Research splits must not overlap: one segment per agent. For anything bigger than a few tasks, the `task-splitter` agent does the split.
2. **Fan out only where allowed.** Run PARALLEL tasks at the same time and SERIAL ones in order. Never skip or run ahead of a human gate. If a stage is one-specialist-only, don't fan out inside it; parallelise independent tickets or research instead.
3. **One agent, one task, one branch.** Each brief is self-contained: goal, files it may touch, definition of done, output path, turn budget. Agents write details to files and return a summary of 10 lines or fewer.
4. **Use the repo's agent roster first.** Dispatch the named agents in `.claude/agents/` for their roles (table below). Their tools and models are pinned, and agents that write run in worktrees. Repo-wide destructive commands are denied in `.claude/settings.json`; per-role limits are rules, not enforcement. Use a generic agent only when no role fits, and say so in the handover. The MyZone/CRHQ library (`JDC000000/crhq-platform-backup`) is a source to port from, never a runtime dependency. New or changed agent files go through CODEOWNERS (Jon merges).
5. **Protect hot files and money.**
   - One writer at a time: migrations, generated files, lockfiles, shared config, AGENTS.md. Regenerate generated files and lockfiles (`make types-generate`, `pnpm install`); never hand-edit or hand-merge them.
   - Never arm auto-merge on anything `needs-jon-approval`, on a CODEOWNERS path (billing, entitlements, workflows, AGENTS.md, CLAUDE.md, `.claude/**`, SKILL.md, `scripts/**`), on any migration, or on anything touching secrets. Jon merges these.
   - No agent calls paid APIs (Replicate, Klangio, Batch API credits) without a budget Jon approved. Otherwise it uses `fixtures/` or mocks.
6. **Use the cheapest model that can do the job.** The model is pinned in each agent file. Override it per dispatch only like this:
   - Haiku: search, extraction, classification, lint and format, mechanical batches (`batch-runner`)
   - Sonnet: most coding, tests, docs, orchestration. Pass `model: sonnet` to `developer` for routine tickets.
   - Opus: architecture, hard bugs, cross-stack changes, final synthesis (`developer`'s default)
   - Fable: safety-critical review only

   If a tier is unavailable, step up one.
7. **Check the proof yourself.** The orchestrator opens the evidence before marking a task done. For code: the PR exists, the diff isn't empty, tests ran. For research: the output file exists, covers its segment and cites sources. "Acknowledged" or "planned" is not done.
8. **Independent review by the repo's bar.** Every PR gets review before merge from a fresh agent on a **different model from the author, always**: Opus-authored → Sonnet or Fable; Sonnet-authored → Opus. R-7 wants a different model *family*. None is wired in (open item O-2, Jon's decision). Until he rules, name it as residue on each PR; on M-11 PRs, only Jon accepts it. Code (M-9): no false green the reviewer can demonstrate, and the reviewer ran the tests itself; the score ranks findings but does not gate the merge. Security (M-11): 90 or above, hard. The author tests every fix a reviewer suggests before applying it. Maximum 3 rounds, then accept and record the residue, or report. For M-11, only Jon accepts residue. Research and mechanical outputs get only the rule 7 check.
9. **Merge one at a time; agents never merge** (M-8). `release-ops` owns the queue. It checks review evidence on the current SHA, then confirms all required checks are present and passing. Then: (a) if the diff (not the title) has no Jon-only path, it applies `rollback-safe` + `adversarial-reviewed` so `auto-merge.yml` merges server-side; (b) for the rest, it gives Jon the list of `scripts/safe_merge.sh <N>` commands (the live path, confirmed 2026-11-23). The next PR is rebased by `developer` in its worktree, then re-checked. If `v3/main` goes red, all work stops until the hotfix lands (M-5).
10. **Start at 5, cap at 10.** Allow at most 2 concurrent git network operations (proxy cap, M-10), so stagger pushes. Add 2 after a clean cycle (no rate limit hit, no conflict). Halve the number after a rate limit or 2 conflicts. A platform governor or load balancer overrides these numbers. Jobs of 100+ mechanical items go to an overnight scheduled run on Haiku or Sonnet. Don't poll or schedule check-ins. The hard budget is each agent file's `maxTurns`; a brief may state a smaller one. A partial result without evidence counts as a failure.
11. **Jon's attention is the bottleneck.** Batch all questions into one decision brief per cycle (decision, pros/cons, impact, recommendation). Never re-ask what's already approved. Only interrupt for real-money spend, red-line merges or irreversible actions. End every cycle with one line on what would unlock more parallelism.
12. **Stop rules.** On a failure, one retry may step up a model tier; a second failure stops and reports. If usage or spend nears its limit, let running agents finish and start no new ones. When context gets heavy, write the handover and tell Jon to start a new chat.
13. **Measure every cycle.** Log agents run, models, tokens (marked as estimates if not reported), wall-clock time, tasks merged, review rounds, failed or hung agents, conflicts and questions asked of Jon. Log to `claude/cycles/<date>-<n>.md`, summarise them in the handover, and use them to tune rule 10.

## Agent roster (`.claude/agents/`)

| Agent | Role | Model | Writes code? | Ported from (CRHQ) |
|---|---|---|---|---|
| `orchestrator` | Splits, dispatches, checks proof, keeps the decision brief | sonnet | No | development-orchestrator |
| `task-splitter` | Phase or spec → PARALLEL/SERIAL tickets with file ownership | sonnet (opus for a whole phase) | No | scope-to-task-agent |
| `developer` | Implementation, one ticket per worktree | opus (sonnet for routine) | Yes | developer-custom → developer-opus |
| `tester` | Tests and QA reports | sonnet | Tests only | tester-custom |
| `code-reviewer` | M-9 adversarial review, read-only | sonnet* | No | code-review-agent |
| `security` | M-11 security review, read-only | sonnet* | No | security-agent |
| `release-ops` | Merge queue, CI triage, deploy verification | sonnet | No (CI fixes go to `developer`) | developer-ops |
| `batch-runner` | Mechanical batches: lint, sweeps, URL checks | haiku | No | batch-executor |

\* The reviewer runs on a different model from the author (rule 8). For an Opus-authored PR, sonnet is fine, or pass `model: fable`; for a Sonnet-authored PR, pass `model: opus`.

## Changelog
- **v3.3 (2026-11-23):** applied an independent review (71 → fixes). Agents never merge (M-8); `release-ops` routes merges to the bot or to Jon. The reviewer is always a different model. Only Jon accepts M-11 residue. All migrations and secrets are Jon-merge. Added the 2-concurrent-git-ops cap. Budgets are set as `maxTurns`. Moved deny-rules from `disallowedTools` (which removed Bash entirely) to `settings.json`. Re-review R1–R7: route by diff; R-7 residue is Jon's ruling; turn budgets clarified.
- **v3.2 (2026-11-23):** added the agent roster (rule 4 and the table); matched review to AGENTS.md M-9/M-11 instead of a flat 90; named `safe_merge.sh` as the live merge path; added the CODEOWNERS list; added Jon's standing max-parallel rule and the end-of-cycle unlock line.
- **v3.1 (2026-11-23):** independent review 92/100. Added proof checks for research, the timeout fix and token estimates.
- **v3.0:** fixed 11 defects from review (auto-merge exclusions, the fail-twice conflict, M-1/M-5 strength, paid APIs, the cap).
- **v2.1:** first full draft, scored 71.
