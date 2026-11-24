---
name: parallel-work-rules
version: v3.4.3
date: 2026-11-24
author: session 18 orchestrator (Claude Opus 5.5), reconciling PR #356's v3.3 (another session) with S18 evidence and Jon's S18 decisions
supersedes: claude/parallel-work-rules.md v3.3 (PR #356, unmerged). When #356 merges, a follow-up PR replaces its file with this text.
precedence: Jon's explicit decisions (ledger `JON` rows) > AGENTS.md > this file. A conflict goes into the decision brief, never resolved by guessing.
goal: faster product development and a higher agentic level (L3 → L4: d5 ≥ 3 and d7 ≥ 3)
---

## Status as of 2026-11-24

- D-1...D-5 decided by Jon, all accepted as recommended.
- O-6 smoke test: PASS for `developer` and `release-ops`; the other agents are untested.
- Gate v3.4 merged (#382: overlap guard); Jon turned the ruleset's strict mode off on 11-23.
- #362 Chord chip fit path gate merged (fast path 6 s verified).
- §11 R1 stopped after 4 failed reviews; the bot-merge path is closed. Rule 9c's "until §11 R1 lands" therefore means: no label auto-merge at all.
- Agents never apply `rollback-safe` / `adversarial-reviewed`; the orchestrator merges only through `scripts/or4-merge.sh` (gate v3.4).
- Version bumped to v3.4.3 (front matter and changelog).

# Parallel work rules v3.4.3

**Standing rule (JON 2026-11-23 11:03 Vancouver):** always run the most parallel work these rules allow, and end every cycle with one line on how Jon could unlock more.

## Rules

1. **Split, then label.** Break the work into tasks and tag each PARALLEL (no shared files, no dependency) or SERIAL. Research segments must not overlap. Any split of more than about 5 tasks gets a written file-ownership table before dispatch.
2. **Two sessions at once (JON 11-23).** The Chromium (2) and git-network-op (2) caps in rule 10 are **shared across both sessions**: each session gets 1 of each unless its ledger records a hand-off.
   - Session A (agentic/ops) owns `.github/**`, `scripts/**`, `.claude/**`, `docs/agentic*`.
   - Session B (product) owns `apps/**` and `packages/**` (including design screenshots under them) and product docs, except shared hot files (rule 5). Migrations are a hot file for either session: announce in both ledgers before writing.
   - Either session may touch the other's paths only by opening an issue.
   - Each session keeps its own ledger. Both read the same Project.
3. **One agent, one task, one worktree, one branch.**
   - The orchestrator creates the worktree (`isolation:worktree` is denied).
   - Each brief holds: goal, files it may touch, definition of done, output path, a pointer to `COMMON-RULES.md`, and a turn budget.
   - Agents return 10 lines or fewer; details go to files.
4. **Agent types.**
   - Until #356 merges **and** a Bash smoke test passes for each named agent, shell work goes to `general-purpose` agents only (E-S18-1).
   - Root cause per #356: `disallowedTools: Bash(...)` removes the whole Bash tool.
   - After that, use the roster in `.claude/agents/` for its roles.
5. **Hot files and money.**
   - One writer at a time for migrations, generated files, lockfiles, shared config and AGENTS.md. Regenerate generated files and lockfiles; never hand-merge them.
   - No paid APIs (Replicate, Klangio, Batch credits) without a budget Jon has approved.
   - A migration with any `DROP` goes to Jon as a single file. After any Jon DB step, verify **both** DBs before dependent work.
6. **Cheapest model that does the job.** Pass `model:` per dispatch:
   - haiku: search, extraction, mechanical sweeps
   - sonnet: routine code, tests, docs, copy
   - opus: money paths, security, cross-stack changes, hard bugs, synthesis
   - fable: safety-critical second review
   - If a tier is unavailable, step up one.
7. **Check the proof yourself.**
   - Before calling a task done: the PR exists, the diff isn't empty, CI ran on the **head SHA**, and gate evidence is re-read from GitHub, never from an agent's summary.
   - A phase closes only on green main CI at the merge SHA plus a deploy and a live check. The plan says which checks were signed-out only.
8. **Independent review on a different model from the author, always.** Never skip or run ahead of a human gate.
   - Example: an opus author gets a sonnet or fable reviewer; a sonnet author gets an opus reviewer.
   - Scores the author's agent wrote don't count. The reviewer runs the tests and at least 3 mutants.
   - Bars: AGENTS.md M-9's two conditions (no false green the reviewer can demonstrate; the reviewer ran the tests itself), **plus** Jon's S18 condition **PASS > 90** (M-9 itself has no score gate). First line: `VERDICT: PASS <91-100> HEAD <sha7>`. Money and security paths also need **M-11 > 90**, and the reported score is min(M-11, M-9).
   - R-7 (a different model *family*) is not wired in. Name it as residue on each PR; for M-11, only Jon accepts residue.
   - Stopping rule: residue the PR itself admits becomes an issue, not another round. At most 3 rounds, then report.
9. **Merging.**
   - **9a. The orchestrator merges only through `or4-merge.sh` v3.3**, which checks: the marker, patch-id equality, behind 0, not draft, ≥ 10 checks, statuses, `merged_at`, and **protected-class enforcement**.
     - Protected class: a `needs-jon-approval` label, a `[billing]` title, or a path matching `.github/`, `scripts/`, `**/.claude/`, AGENTS.md, CLAUDE*, `.mcp.json`, `**/SKILL.md`, CODEOWNERS, any `migrations/`, `.env*`, billing, stripe, entitlement, auth (directory or file), service-role, or secret. Self-test on 11-23: 18/18 sample protected paths caught, 0/5 false positives.
     - A protected PR fails unless `JON_ROW=<ledger row of Jon's named approval for that PR>` is set.
     - Non-protected reviewed PRs (design, bug-fix, test, copy) merge under Jon's standing approval, quoted in Project `claude/handover-18/SESSION-18-PROMPT.md` (v1.2.2, §2 bullet "Merges (OR-4)"): *"Jon's blanket approval covers design and bug-fix PRs"*. That is a handover quote, not a JON ledger row, so Jon is asked to ratify it in D-1.
     - Evidence: 11 REST merges on 11-23 (ledger rows 117–146; GitHub shows `merged_by` JDC000000 for all 11, so the ledger is the only record of which gate ran). 5 used v3.1 (#347 #346 #340 #341 #348), 4 used v3.2 (#350 #353 #359 #358) and 2 used v3.3 with `JON_ROW=143` (#354 #349).
     - AGENTS.md M-8's table says REST merge is classifier-blocked. That is stale for these cases (D-1); a classifier change could re-block it at any time, and then OR-1 applies.
   - **9b. If a PR was rebased after review**, the gate fails closed. A non-author agent writes a delta review at the new head, then merge.
   - **9c. No label-based auto-merge** (`rollback-safe` + `adversarial-reviewed`) until §11 R1 lands, and even after that, never on the protected class in 9a (v3.3's hard exclusion list, kept):
     - a PR author can apply those labels (#346 review residue);
     - S18 agents apply no labels (only `needs-jon-approval` on billing PRs);
     - the bot path will be R1's content-only class (JON 11-23).
   - **9d. Serialize merges; rebase with `PUT …/update-branch`**, never force-push. This makes #356's O-9 (`--force-with-lease`) unnecessary.
   - **9e. If `v3/main` goes red**, all merges stop until the hotfix lands (M-5).
10. **Concurrency.**
    - Run at least 5 agents whenever there is work; cap 10.
    - At most 2 Chromium agents at once (7 GB, 2-core box).
    - At most 2 concurrent git network operations (M-10): stagger pushes.
    - Add 2 agents after a clean cycle; halve after a rate limit or 2 conflicts. A platform governor or load balancer overrides these numbers.
    - No polling check-ins (Jon 11-22). Use background waits on CI; while one PR's CI runs, other agents keep building or reviewing.
11. **Jon's attention is the bottleneck.**
    - One batched decision brief per cycle (decision, pros/cons, recommendation, via the modal).
    - Never re-ask anything already approved.
    - Interrupt only for real money, red-line merges or irreversible actions.
12. **Stop rules.**
    - The first failure may retry one model tier up. A second failure of the same task stops it and reports (S18: R1 FAIL 58 → 64 → went to Jon).
    - Near a usage limit: let running agents finish and start no new ones.
    - When context gets heavy: write the handover.
13. **Measure every cycle.**
    - Log agents run, models, tokens (marked estimated if not reported), wall-clock time, merges, review rounds and scores, failed or hung agents, conflicts, Jon questions, and the one-line unlock.
    - **S18 baselines** (targets in brackets): first-round PASS 7/8 PRs (≥ 7/8); merges per session-day ~9 (≥ 12); Jon DB round-trips 5 (≤ 1); median merge wait after PASS ~20 min CI (≤ 10).
    - Logs go in the session ledger in the Project. Session notes are **not** pushed to the repo: an S17 classifier refusal (OR-1).

## Throughput: what actually limited S18 (measured, 11-23)

| Limiter | Evidence | Unlock | Owner |
|---|---|---|---|
| Each `update-branch` re-runs CI for ~20 min. "Chord chip fit" takes ~19 min and is **not required** by ruleset 26478884, but the gate waits on every check; the required "Browser journeys" takes ~10 min | Every merge left the other PRs `behind` (rows 137–142) | (a) path-filter Chord chip fit to chord/player files; (b) a later gate version waits only on the 10 required checks plus Chord chip fit when its paths change; (c) Jon: merge queue, or non-strict up-to-date for non-protected PRs | Claude (a, b), Jon (c) |
| Jon's DB steps | B1/B3 waited ~2 h on 043 (rows 108–127) | Jon-dispatched, sha-pinned migration workflow | Claude builds, Jon approves |
| Review rounds | R1 needed 2 FAIL rounds | Author pre-runs the reviewer's mutant harness (R4) | Claude |
| Same-model reviewers | A-2 card d4 deduction | Rule 8 model split (free today) | Claude |
| One session's box | 2 Chromium max | Rule 2: two sessions | Jon starts B |

## Decisions for Jon (from reconciling #356)

| # | Decision | Recommendation |
|---|---|---|
| D-1 | (i) Ratify the standing approval: the orchestrator merges reviewed non-protected PRs (design, bug-fix, test, copy) through gate v3.3. (ii) Update the AGENTS.md M-8 table to what S18 observed (gated REST merges passed), noting that a classifier change can re-block them | Yes to both; Claude opens the M-8 docs PR, you merge it |
| D-2 | #356 rule 9's label route to `auto-merge.yml` | Don't enable it; R1 content-only is the bot path (9c) |
| D-3 | #356 O-9: allow `--force-with-lease` on `v3-phase-*` | Decline; `update-branch` already avoids the stall (9d) |
| D-4 | #356 itself (8 agent files, `settings.json`): CODEOWNERS paths | Merge after the O-6 Bash smoke test for `developer` and `release-ops` passes. Run it from a CLI session; this cloud session can't run `claude --agent` |
| D-5 | #356 O-7 / O-8 (remove `Agent` from developer.md; widen CODEOWNERS to all migrations, so that GitHub enforces 9a's migration rule as well) | Yes to both, as part of #356 or a follow-up |

## Changelog

- **v3.4.3 (2026-11-24):** status block added; 9c clarified (no label auto-merge, R1 stopped); gate v3.4; agent library fixes from the #356 review.
- **v3.4.2 (2026-11-23):** review R2 (sonnet) FAIL 88. Changes: the protected regex is widened to the CODEOWNERS set (gate v3.3, 18/18 self-test); the standing-approval quote is cited by Project path; the per-session cap shares are added to both prompts; the stray "gate v3.4" reference is fixed.
- **v3.4.1 (2026-11-23):** review R1 (sonnet) FAIL 78. Changes:
  - gate v3.3 enforces the protected class (`JON_ROW`), and migrations/secrets are back on the named list;
  - merge counts are split by gate version;
  - the standing-approval source is cited, with ratification as D-1;
  - M-9 described correctly;
  - the CI limiter is corrected (Chord chip fit is not required);
  - kept from v3.3: never skip a human gate, the hard exclusion list, the governor override, the tier-up retry, token estimates;
  - the Chromium and git caps are shared across sessions;
  - baselines and targets added.
- **v3.4 (2026-11-23):** reconciled v3.3 (#356) with S18 evidence and Jon's 11-23 decisions:
  - two-session rule;
  - orchestrator merges via or4 v3.2 under Jon's approvals (M-8 table flagged stale);
  - no label auto-merge until R1;
  - `update-branch` instead of force-with-lease;
  - PASS > 90 per Jon (stricter than M-9);
  - general-purpose agents until the #356 smoke test;
  - no session notes in the repo;
  - a measured-limiter table.
- **v3.3 and earlier:** see PR #356 (`claude/parallel-work-rules.md`). Independent reviews there: 71 → 88 → 92 → 71/55 → 86/83 → 91/88.
