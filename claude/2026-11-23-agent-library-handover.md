# Handover — Agent library port + Parallel Work Rules (2026-11-23)

**For:** the "Stem_Loops Orchestrator Nov 22_18" session and every later orchestrator session.
**From:** a Claude session working with Jon on 2026-11-23 (outside the Project).
**Status:** PR open; it needs Jon's merge because it touches `.claude/**` (a CODEOWNERS path).

## TL;DR (read this first)
1. **New rulebook:** `claude/parallel-work-rules.md` (v3.3). It governs how you fan work out. AGENTS.md still wins.
2. **4 new agents** in `.claude/agents/`: `orchestrator`, `task-splitter`, `release-ops`, `batch-runner`.
3. **Critical bug fixed in the 4 existing agents.** Their `disallowedTools: - Bash(...)` entries removed **Bash entirely**. Per the Claude Code docs, a specifier entry "still removes the whole tool", so `developer`, `tester`, `code-reviewer` and `security` could not run `make test`, `gh` or `git`. The entries are deleted, and the repo-wide destructive denies (force-push, `reset --hard`, `rm -rf`) moved to `.claude/settings.json` `permissions.deny`. `code-reviewer` now uses the M-9 verdict instead of the retired ≥93 bar.
4. **Agents never merge (M-8).** Two merge paths exist: Jon running `scripts/safe_merge.sh <N>` (every merge Nov 18–23 was by `JDC000000`), or labels → server-side `auto-merge.yml`. `release-ops` routes to one or the other.
5. **Jon's standing rule (2026-11-23):** run as much parallel work as possible, and tell him when and how to unlock more.

## Onboarding checklist (do these in order)
- [ ] Read AGENTS.md §11 (M-1 to M-11).
- [ ] Read `claude/parallel-work-rules.md` (rules and roster).
- [ ] Skim the 8 files in `.claude/agents/`.
- [ ] Get GitHub API access per M-10. Use the REST API (`gh api`); GraphQL `gh pr list/create/view` fails here.
- [ ] Check `v3/main` CI is green before dispatching anything (M-5).
- [ ] Start the first cycle at 5 parallel agents (rules §10), and log the cycle metrics (rules §13).

## What changed and why

| Item | Change | Why |
|---|---|---|
| `claude/parallel-work-rules.md` | New, v3.2 | Jon asked for one simple rule set for maximum parallel work with cheaper models. It went through 4 independent review rounds (71 → 88 → 92 → v3.2 review below). |
| `.claude/agents/orchestrator.md` | New (sonnet) | Splits, dispatches and checks proof. Ported from CRHQ `development-orchestrator`, but parallel instead of one-specialist-per-stage. |
| `.claude/agents/task-splitter.md` | New (sonnet) | A good split (disjoint file ownership) is what makes parallel work safe. Ported from `scope-to-task-agent`; the Asana output was dropped. |
| `.claude/agents/release-ops.md` | New (sonnet) | Parallel PRs need one serial merge owner. Ported from `developer-ops`; the MyZone deploy duties were dropped. |
| `.claude/agents/batch-runner.md` | New (haiku) | Cheap leaf worker for lint, sweeps and checks. Ported from `batch-executor`. |
| `docs/agent-registry.md` | Appended a roster mapping | Maps CRHQ role names to the agent files here. |

## Decisions made this session (with evidence)
1. **The merge method is `scripts/safe_merge.sh`, run by Jon.** The ~40 most recent merged PRs (Nov 18–23) were all merged by user `JDC000000`. AGENTS.md M-8 says in-session agents cannot merge (`gh pr merge --admin` needs GraphQL; a REST merge is classifier-blocked). The last bot merge was #335 (2026-11-22, fast-path), and #346 retired the fast-path on 2026-11-23. The STANDARD label path in `auto-merge.yml` still exists, but recent runs show `skipped`.
2. **The developer agent is `developer`.** CRHQ retired `developer-custom` (it's not in the CRHQ agent export, and its last activity was 2026-07-01). It collapsed to a single worker, `developer-opus`, on 2026-06-20. Here that worker is the existing `developer.md`. Its frontmatter is unchanged (opus); the orchestrator passes `model: sonnet` for routine tickets.
3. **The CRHQ library is a source, not a runtime.** Its 129 agents depend on MyZone's `cr-api`, Slack pairings and platform rules. Only the 8 dev-pipeline roles were ported. Everything else (marketing, onboarding, fleet-ops, the Roblox game studio) is out of scope for this repo.

## How to run the orchestrator
Run the orchestrator as the main session: `claude --agent orchestrator`. Subagents can nest up to 3 layers, but running it as the main session keeps the full depth available for workers. Then dispatch the other 7 agents from there.

## Open items / known inconsistencies (not fixed in this PR — flagged)
| # | Item | Owner |
|---|---|---|
| O-1 | **Fixed in this PR:** `code-reviewer.md` used the retired ≥93 bar; it now uses the M-9 verdict. | Done |
| O-2 | R-7 needs a **different model family** reviewer, but `code-reviewer` and `security` are Claude (sonnet). No different-family reviewer is wired into Claude Code here. Decide: use a GPT/codex reviewer, or record the residue. | Jon decision |
| O-3 | `docs/agent-registry.md`'s top table still lists the CRHQ names. The new mapping section resolves them; the table itself was left as is. | Low |
| O-4 | `.claude/settings.json` F9 (the wrapper script runs a denied command) is still open. Also, `Bash(gh pr merge --admin*)` does not match `gh pr merge 123 --admin`. Don't treat deny-rules as a security boundary. | Level-3 retro |
| O-6 | **Before merge:** smoke-test by running `claude --agent release-ops -p "run: echo ok"` and the same for `developer`. Confirm Bash is available. (Not possible in the authoring session: the CLI there was unauthenticated.) | Jon or the orchestrator, before merge |
| O-7 | `developer.md` still lists the `Agent` tool, so a developer can fan out and exceed the cap of 10. Briefs tell it not to delegate. Removing `Agent` would make the cap hard. | Jon decision |
| O-8 | `auto-merge.yml` `CO_RE` and CODEOWNERS cover only `*_v3_commercial*` migrations; other migrations are Jon-only in prose only. Widen both to `apps/worker/migrations/**`. | Jon (workflow + CODEOWNERS) |
| O-9 | Unattended rebase pushes (`git push --force-with-lease origin v3-phase-*`) are neither allowed nor denied, so they will stop on a permission prompt. Adding them to `allow` is a permission widening, so this PR deliberately does not do it. | Jon decision |
| O-10 | The label step in `release-ops` hasn't been tested against the agent-side classifier (M-8 "Auto-Mode Bypass"). If it's refused, the PR falls back to Jon's list. | First cycle |
| O-5 | The 5 → 10 ramp and the time budgets are guesses until a measured cycle exists. Log cycle 1 and tune. | Orchestrator |

## Doc manifest
| Doc | Version | Date |
|---|---|---|
| `claude/parallel-work-rules.md` | v3.3 | 2026-11-23 |
| `.claude/agents/{developer,tester,code-reviewer,security}.md` | `disallowedTools` removed; code-reviewer moved to the M-9 verdict | 2026-11-23 |
| `.claude/settings.json` | +4 deny rules | 2026-11-23 |
| `.claude/agents/orchestrator.md` | v1.1 | 2026-11-23 |
| `.claude/agents/task-splitter.md` | v1.0 | 2026-11-23 |
| `.claude/agents/release-ops.md` | v1.1 (never merges) | 2026-11-23 |
| `.claude/agents/batch-runner.md` | v1.0 | 2026-11-23 |
| `docs/agent-registry.md` | + roster section | 2026-11-23 |

## Source
CRHQ agent library: `JDC000000/crhq-platform-backup` (backup generated 2026-10-31), `agent-brains/<key>/identity.md`.
