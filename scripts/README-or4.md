# or4-merge.sh — orchestrator merge gate (OR-4 v3.4, §11 R6)

The orchestrator's merge gate. It squash-merges a PR **only** if every check below
passes; otherwise it prints each `FAIL:` line and exits 1 without merging. It is
the scripted counterpart to Jon's `scripts/safe_merge.sh`; never use a bare
`PUT .../merge` instead (E-S18-2).

## Usage

```sh
DRY_RUN=1 scripts/or4-merge.sh <pr> <review-file> <reviewed-sha>   # ALWAYS run this first: every check, never merges
scripts/or4-merge.sh <pr> <review-file> <reviewed-sha>             # real merge, only after a clean dry run
JON_ROW=<n> JON_PR=<pr> scripts/or4-merge.sh ...                    # protected PRs only, see below
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
| 4 | Overlap guard (v3.4) | `behind_by == 0` passes. If `behind_by` is 1..20, the PR's changed files and the files changed on v3/main since the merge-base (`git diff -z --no-renames --name-only <merge-base> origin/v3/main`, quotePath off) must be **disjoint** and neither side may contain a **hot file** (below); else `FAIL: overlap/hot file: update-branch first` listing up to 5 paths. `behind_by > 20` fails (stale). Any listing error or empty listing while behind fails closed. |
| 5 | Not draft | PR `draft == false`. |
| 6 | No merge-bot labels | None of `fast-path`, `rollback-safe`, `adversarial-reviewed`. |
| 7 | Checks green | Every check-run on the head SHA has conclusion `success` or `skipped` (pending counts as failing). |
| 8 | Protected class (v3.3) | A PR labelled `needs-jon-approval`, titled `[billing]`, or touching a protected path **fails** unless `JON_ROW=<numeric ledger row>` is set (see below). |
| 9 | Check-run count (v3.2) | At least 10 check-runs must be registered on the head SHA, or refuse. |
| 10 | Commit statuses (v3.2) | Every commit status on the head must be `success` (failure/error/pending refuse). |
| 11 | Merge | `PUT pulls/<pr>/merge` with `merge_method=squash` and `sha=<head>` pinned, so a push between check and merge is rejected by GitHub. Exit 1 unless the PUT succeeds **and** `merged_at` is set. |

## Overlap guard (v3.4)

Jon turned off "require branches up to date" on ruleset 26478884 (2026-11-23 16:34 Vancouver, LEDGER-19A rows 63/65), so
the gate no longer forces update-branch + a full CI rerun after every merge. Hot files (`HOT_RE` in `or4-merge.sh`, any depth,
case-insensitive): lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `uv.lock`, `poetry.lock`, `Cargo.lock`), any
`package.json`, any `migrations/` path, `AGENTS.md`, `CODEOWNERS`, `.github/workflows/**`, `tsconfig*.json`, `next.config.*`,
`pnpm-workspace.yaml`, Python pins (`constraints*.txt` e.g. `apps/worker/constraints-prod.txt`, `requirements*.txt`, `pyproject.toml`),
`.npmrc`, `.nvmrc`, `turbo.json`, `Dockerfile*`, `fly.toml`, `docker-compose*.yml`, `Makefile`, `.eslintrc*`, and the generated
types pair `packages/types/schema/contract.schema.json` + `packages/types/src/generated.ts`.

**Snapshot pin (R2, unconditional in R3):** right after the fetch, one `compare` call returns `behind_by`, `base_commit.sha` and `merge_base_commit.sha`. Behind or not, the gate FAILS
(`main moved during gate; re-run`) unless the base equals the local `origin/v3/main` and the merge-base equals the `$mb` used for the file
listings. The gate-to-PUT window (seconds) remains a residual. A hot file changed on either side forces update-branch even without overlap.

**Residual risk:** a semantic conflict with no file overlap (PR A changes a function's contract, PR B calls it from another
file) can still land. The backstop is v3/main push CI (M-5: main red means all merges stop). Checks 7, 9, 10, 3 and the
`sha=<head>` pin on the merge PUT are unchanged.

## Protected class and `JON_ROW` (v3.3)

Protected paths (always case-insensitive): `.github/`, `scripts/`, `**/.claude/`, and at ANY depth `AGENTS.md`,
`CLAUDE*`, `.mcp.json`, `SKILL.md`; plus `CODEOWNERS`, any `migrations/`, `.env*`, and any path containing
`billing`, `stripe`, `entitlement`, `auth` (as a directory or `auth.*` file), `authz`, `oauth`, `middleware`,
`webhook`, `service-role`/`service_role`, or `secret`. The exact regex is `PROTECTED_RE` in `or4-merge.sh`.
The path list is `git diff --no-renames --name-only -z` with `core.quotePath=false`, so a rename lists both the
old and the new name and non-ASCII names are not quoted. The gate FAILS CLOSED if the merge-base or the diff
fails or lists nothing, or if the PR labels/title cannot be read.

Such a PR is refused unless **both** are set: `JON_ROW=<ledger row>` (numeric row of the entry where Jon named
his approval of this PR) and `JON_PR=<pr>` equal to the PR number being merged (ties the approval to this PR;
a stale exported JON_ROW cannot approve another PR). The gate prints both. It cannot verify the ledger row
itself; never set them without Jon's named approval, and unset them after the run.

`OR4_LIB=1` is for tests only: sourcing defines the functions; executing the script with it prints
`OR4_LIB set: library mode, NOT a merge` to stderr and exits 2.

## Tests

`python3 -m unittest scripts/test_or4_merge.py` (offline, no `gh`/network). Also covers `overlap_decision` (disjoint pass, overlap, hot file on either side, listing failure, behind 21, renames) plus end-to-end `GateWiring` tests that run the script (`DRY_RUN=1`, `OR4_REPO` temp clone, PATH-shimmed `gh`) to cover the call-site wiring and the snapshot pin. It sources `or4-merge.sh` with
`OR4_LIB=1`, which defines `PROTECTED_RE` and `marker_ok` and returns before any network call, so the
tests exercise the script's own definitions: the protected-path regex (35 protected paths, 6 ordinary), the protected decision with stubbed inputs
(JON_ROW/JON_PR/label/title/paths), rename and non-ASCII regressions in a temp git repo, fail-closed listing, and
verdict markers `PASS 91..100` are accepted while `PASS 90`, `FAIL 95`, missing `HEAD`, short or wrong SHA prefix are refused.

## When a rebase changes the patch-id (delta-review path)

Rebasing onto a newer v3/main (needed when check 4 fails) normally keeps the patch-id,
so the original review still applies. If the rebase **changes the PR content**
(conflict resolution, dropped/added hunks), check 3 fails, by design. Then:

1. Get a **delta review** of the new head: the reviewer diffs old reviewed SHA vs
   new head (`git range-diff` / `git diff <old>..<new>`), confirms the change, and
   writes a new review file ending in `VERDICT: PASS <91–100> HEAD <new-head-sha>`.
2. Re-run the gate with the new review file and `<reviewed-sha>` = the new head.

Never pass the new head as `<reviewed-sha>` with the old review file; check 1/2
will refuse it and that is the point.

`OR4_REPO` (test clone override) is honoured only with `DRY_RUN=1` AND `OR4_TEST=1`; set in any other run the gate exits 1 (`FAIL: OR4_REPO set outside test mode`).
