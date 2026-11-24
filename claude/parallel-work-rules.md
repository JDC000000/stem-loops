---
name: parallel-work-rules
version: v3.5
date: 2026-11-24
author: session 19A orchestrator (Claude Opus 5.5)
source: repo copy of Project claude/handover-19/PARALLEL-WORK-RULES-v3.5-2026-11-24.md
supersedes: v3.4.2 (Project) and v3.4.3 (repo claude/parallel-work-rules.md, PR #388)
precedence: Jon's explicit decisions (ledger `JON` rows) > AGENTS.md > this file. A conflict goes into the decision brief, never resolved by guessing.
why: JON D-6, 2026-11-23 19:50 Vancouver (LEDGER-19A row 95), verbatim: "Update your merge rules. Do a review of all the times you've asked me this session to merge and update the rules so you can self-approve. Update all documentation, stop asking me to merge. Update the rules. Learn from this session." Evidence: claude/handover-19/MERGE-ASK-REVIEW-19A-2026-11-24.md.
---

# Parallel work rules v3.5

**Standing rules from Jon**
- JON 2026-11-23 11:03: always run the most parallel work these rules allow; end every cycle with one line on how Jon could unlock more.
- **JON D-6 2026-11-23 19:50: the orchestrator self-approves merges. Never ask Jon to approve a merge.**

## 1 · Merging (rewritten in v3.5)

**M-SA. Self-approval.** The canonical text is **AGENTS.md M-8, "M-SA"**; this section summarises it and must not diverge. The orchestrator (main session only; subagents never merge) merges a PR without asking Jon when ALL hold:
1. **Review:** a dispatched reviewer agent on a different model from the author wrote a review file with exactly one `VERDICT: PASS <91-100> HEAD <sha7>` line at the reviewed SHA, and ran the tests and ≥ 3 mutants. The orchestrator never writes, edits or converts a review file; the author's agent never reviews.
2. **Second reviewer** (third model, PASS > 90, same content) for **every PR in the gate's protected class**: a path matching `PROTECTED_RE` in `scripts/or4-merge.sh`, the label `needs-jon-approval`, or a `[billing]` title. Money / auth / secrets also need M-11 > 90 (report min(M-11, M-9)). The merge path (`scripts/or4-merge.sh`, `scripts/test_or4_merge.py`, workflows, CODEOWNERS, `.claude/settings.json`, rulesets, AGENTS.md M-SA, this §1) is inside that class.
3. **Gate:** `scripts/or4-merge.sh` ≥ v3.5, `DRY_RUN=1` first (only the literal `1`; issue #391), then the real run with `JON_ROW=95 JON_PR=<pr>` (D-6 standing row; JON_PR ties each run to one PR).
4. **CI** green on the PR head; protected PRs behind 0; others may use `ALLOW_BEHIND=1` (≤ 5, disjoint, no coupled/hot files). **Rule 9b:** if the PR content changed after review (not just an `update-branch`, which the patch-id check passes), a non-author agent writes a delta review at the new head first.
5. **Migrations:** a PR that adds a migration, or code depending on an unapplied one, merges only AFTER Jon has applied it to prod and staging and both DBs are verified (one bare SELECT each). A `DROP` migration goes to Jon as a file first. Hold without a merge question until his apply is on the ledger.

**Enforced by the gate (code):** marker in the one review file at the reviewed SHA, patch-id equality, not draft, ≥ 10 green check-runs and statuses, behind rules, protected class → numeric `JON_ROW` + matching `JON_PR`, no merge-bot labels.
**Process (orchestrator duty, not enforced):** reviewer model ≠ author, the second review exists (the gate takes one file), tests/mutants ran, the review was written by a reviewer agent, `DRY_RUN=1` first, main session only, the row is 95. The gate cannot verify the ledger row or reviewer identity. Before the real run, log both review files, models and scores. Never call a process item "checked by the gate".

**HELD for Jon, a control change not a merge ask:** a PR that removes or loosens a gate check, changes M-SA / this approval rule, CODEOWNERS, `.claude/settings.json`, rulesets, or the merge logic of workflows (`auto-merge.yml`, autonomy-class, the labellers). Do not self-merge; put one line in the cycle brief and wait for a JON row naming it. Tightening-only changes may be self-approved with two reviewers.

**Hard-rule items (never merge approvals; still Jon's):** applying a migration to prod/staging, any `DROP` migration, Stripe live mode, secrets/tokens/env, paid-API budgets, ruleset or repo-settings changes, deleting R2 data, irreversible prod data changes.

**After every self-approved merge:** log the ledger row (PR, reviewers + models + scores, gate version, merge SHA); watch `v3/main` CI at the merge SHA. If main goes red because of the merge: all merges stop (M-5), and a revert PR is opened, reviewed and self-merged under M-SA. Report merges to Jon in the cycle summary (no question).

**Stop and tell Jon (not a merge ask) when:** a reviewer FAILs the same PR 3 times; reviewers disagree across models by > 15 points; a classifier/permission/proxy refusal (OR-1). A gate-loosening PR is HELD (above), not merged.

**Removed in v3.5:** v3.4.3's "never skip or run ahead of a human gate" now means the HELD and hard-rule items; "protected PRs need Jon's named per-PR approval"; batching merge questions into decision briefs; the D-1(i) non-protected-only scope.

## 2 · Work rules (carried from v3.4.2, updated)

1. **Split, then label** PARALLEL / SERIAL; > 5 tasks → file-ownership table before dispatch.
2. **Two sessions.** 19A owns `.github/**`, `scripts/**`, `.claude/**`, `docs/agentic*`; 19B owns `apps/**`, `packages/**`, product docs. Cross-paths only via an issue. Chromium (2) and git-network (2) caps are shared: 1 each per session unless a hand-off is logged. **One merge gate** for both sessions (v3.5, #390); never fork a private gate copy — propose changes as a PR (lesson: #382 vs #385 diverged).
3. **One agent, one task, one worktree, one branch.** The orchestrator creates the worktree (an agent file may set `isolation: worktree`, but the platform denies it, so the orchestrator creates it). Brief = goal, files, done-definition, output path, COMMON-RULES pointer, turn budget. Agents reply ≤ 10 lines.
4. **Agent types:** the roster lives in `.claude/agents/` and `docs/agent-registry.md`. `developer` and `release-ops` passed the O-6 Bash smoke test; others use `general-purpose` until smoke-tested (issue #389).
5. **Hot files and money:** one writer at a time for migrations, generated files, lockfiles, shared config, AGENTS.md. No paid APIs without Jon's budget. After any Jon DB step verify **both** DBs.
6. **Model per task:** haiku (sweeps), sonnet (routine code/docs), opus (money, security, cross-stack, synthesis), fable (safety-critical second review).
7. **Check the proof yourself:** PR exists, diff non-empty, CI on the head SHA, gate evidence re-read from GitHub. Review markers are checked verbatim; never convert a malformed score (lesson: `PASS 9/10`).
8. **Review:** author ≠ reviewer model; PASS > 90; max 3 rounds per PR, then stop and report. Residue the PR admits → an issue. Reviewers get the previous round's harness; authors pre-run it.
9. **No label-based auto-merge, ever** (D-2; §11 R1 stopped after 4 failed reviews). Rebase only with `PUT …/update-branch` (D-3).
10. **Concurrency:** ≥ 5 agents when there is work, cap 10; background CI waits, no polling check-ins. Don't loop update-branch while another session merges: use `ALLOW_BEHIND=1` where eligible, else update once right before merge.
11. **Jon's attention:** one batched brief per cycle, only for decisions that are really his (hard-rule items in M-SA 5, product calls, refusals). Never re-ask what is approved. **Never ask for a merge.**
12. **Stop rules:** second failure of the same task → stop and report; near usage limit → no new agents; heavy context → write the handover.
13. **Measure every cycle** in the Project ledger: agents, models, merges, review rounds/scores, refusals, Jon asks (target: 0 merge asks), unlock line. Session notes never go into the repo.

## 3 · Lessons from session 19A (2026-11-23)

| # | Lesson | Rule |
|---|---|---|
| L1 | 4 merge asks, 8/8 PRs approved unchanged; each ask added ~6–90 min of wait | M-SA |
| L2 | Every real defect was caught by independent reviewers (9 FAIL rounds: or4 rename bypass, OR4_REPO forge, chord-gate false greens, R1 bypasses) | §2.8, second reviewer for gate changes |
| L3 | Most wall-clock went to update-branch loops while 19B merged | strict off (Jon) + v3.5 ALLOW_BEHIND + §2.10 |
| L4 | Two sessions built two different gates | §2.2 one gate |
| L5 | Real Jon touchpoints were refusals: add_repo (classifier), workflow edit (permission system), ruleset write (proxy) | OR-1 + ask Jon only for those |
| L6 | Scheduled tasks attach every account connector | Jon trims connectors on any new scheduled task |
| L7 | A test override (OR4_REPO) nearly became a bypass | test hooks must fail closed outside test mode |

## Changelog
- **v3.5 (2026-11-24):** JON D-6 self-approval (M-SA); second reviewer for high-risk classes and merge-path changes; standing JON_ROW=95; one shared gate v3.5; never ask Jon to merge; lessons table. Supersedes v3.4.2/v3.4.3.
- v3.4.3 (2026-11-24, PR #388): status block (D-1…D-5 decided; label route removed).
- v3.4.2 and earlier: see Project `claude/handover-19/PARALLEL-WORK-RULES-v3.4.2-2026-11-23.md`.
