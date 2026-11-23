# or4-merge.sh — orchestrator merge gate (OR-4 v3.3, §11 R6)

The orchestrator's merge gate. It squash-merges a PR **only** if every check below
passes; otherwise it prints each `FAIL:` line and exits 1 without merging. It is
the scripted counterpart to Jon's `scripts/safe_merge.sh`; never use a bare
`PUT .../merge` instead (E-S18-2).

## Usage

```sh
DRY_RUN=1 scripts/or4-merge.sh <pr> <review-file> <reviewed-sha>   # ALWAYS run this first: every check, never merges
scripts/or4-merge.sh <pr> <review-file> <reviewed-sha>             # real merge, only after a clean dry run
JON_ROW=<n> scripts/or4-merge.sh ...                                # protected PRs only, see below
```

- `<pr>` — numeric PR number on `JDC000000/stem-loops`.
- `<review-file>` — local path to the reviewer's write-up.
- `<reviewed-sha>` — the full commit SHA the reviewer actually reviewed.

Exit 0 = merged (or, under `DRY_RUN=1`, would merge). Exit 1 = refused.
The script fetches into the main clone at `/home/claude/stem-loops`.

## What it checks (all must pass; any failure refuses)

| # | Check | Detail |
|---|---|---|
| 1 | Verdict marker | Last `^VERDICT: ` line in the review file must be exactly `VERDICT: PASS <91–100> HEAD <sha>`, where `<sha>` (7–40 hex) is a prefix of `<reviewed-sha>`. No marker = refuse (no fallback). |
| 2 | SHA named | Review file must contain the first 7 chars of `<reviewed-sha>`. |
| 3 | PR-content equality | `git diff --binary --full-index -M` from merge-base(v3/main) to each of `<reviewed-sha>` and PR head, piped through `git patch-id --stable`, hashed. Must be equal. **Fails closed** if either side can't be computed or is empty. |
| 4 | Up to date | `compare v3/main...head` `behind_by` must be `0`. |
| 5 | Not draft | PR `draft == false`. |
| 6 | No merge-bot labels | None of `fast-path`, `rollback-safe`, `adversarial-reviewed`. |
| 7 | Checks green | Every check-run on the head SHA has conclusion `success` or `skipped` (pending counts as failing). |
| 8 | Protected class (v3.3) | A PR labelled `needs-jon-approval`, titled `[billing]`, or touching a protected path **fails** unless `JON_ROW=<numeric ledger row>` is set (see below). |
| 9 | Check-run count (v3.2) | At least 10 check-runs must be registered on the head SHA, or refuse. |
| 10 | Commit statuses (v3.2) | Every commit status on the head must be `success` (failure/error/pending refuse). |
| 11 | Merge | `PUT pulls/<pr>/merge` with `merge_method=squash` and `sha=<head>` pinned, so a push between check and merge is rejected by GitHub. Exit 1 unless the PUT succeeds **and** `merged_at` is set. |

## Protected class and `JON_ROW` (v3.3)

Protected paths (case-insensitive, matched against `git diff --name-only`): `.github/`, `scripts/`,
`**/.claude/`, `AGENTS.md`, `CLAUDE*`, `.mcp.json`, `**/SKILL.md`, `CODEOWNERS`, any `migrations/`, `.env*`,
and any path containing `billing`, `stripe`, `entitlement`, `auth` (as a directory or `auth.*` file),
`service-role`/`service_role`, or `secret`. The exact regex is `PROTECTED_RE` in `or4-merge.sh`.

Such a PR is refused unless the environment has `JON_ROW=<ledger row>`: the numeric row of the ledger entry
where Jon named his approval of this specific PR. The gate prints `JON_ROW=<n>` so the merge log cites it.
It only checks the value is numeric; the orchestrator must put a real row there. Never set it without Jon's
named approval.

## Tests

`python3 -m unittest scripts/test_or4_merge.py` (offline, no `gh`/network). It sources `or4-merge.sh` with
`OR4_LIB=1`, which defines `PROTECTED_RE` and `marker_ok` and returns before any network call, so the
tests exercise the script's own definitions: 24 protected paths match, 6 ordinary paths do not, and
verdict markers `PASS 91..100` are accepted while `PASS 90`, `FAIL 95`, missing `HEAD`, short or wrong SHA prefix are refused.

## When a rebase changes the patch-id (delta-review path)

Rebasing onto a newer v3/main (needed for check 4) normally keeps the patch-id,
so the original review still applies. If the rebase **changes the PR content**
(conflict resolution, dropped/added hunks), check 3 fails, by design. Then:

1. Get a **delta review** of the new head: the reviewer diffs old reviewed SHA vs
   new head (`git range-diff` / `git diff <old>..<new>`), confirms the change, and
   writes a new review file ending in `VERDICT: PASS <91–100> HEAD <new-head-sha>`.
2. Re-run the gate with the new review file and `<reviewed-sha>` = the new head.

Never pass the new head as `<reviewed-sha>` with the old review file; check 1/2
will refuse it and that is the point.
