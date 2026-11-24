# or4-merge.sh — orchestrator merge gate (OR-4 v3.5, §11 R6)

**One gate for both sessions.** 19A (agentic/ops) and 19B (product) both merge through this script. v3.5 replaces 19A's v3.4
(#382) and 19B's v3.4-R2 (#385, Jon approved the design 2026-11-23 23:29Z, "structurally solve" merge contention). Do not run a
local fork of it; change it here, by PR (protected path: Jon merges).

| Version | Where | Behind rule | Notable |
|---|---|---|---|
| v3.3-R2 | main (S18) | `behind_by == 0` | protected class + `JON_ROW`/`JON_PR` |
| v3.4 | main, #382 (19A) | 1..20 behind for ANY PR if file-disjoint and no hot file | snapshot pin every run; `OR4_REPO` only in test mode |
| v3.4-R2 | 19B local copy, #385 | opt-in `ALLOW_BEHIND=1`; non-protected only; ≤ 5; no overlap; no coupled file; no main deletions/renames | `branches/v3/main` re-checked right before the PUT |
| **v3.5** | **main (this)** | **strictest union of both (below)** | + #384: git env scrub, `git replace` refs FAIL, `OR4_REPO` guard tested for rc and zero network calls |

The orchestrator's merge gate. It squash-merges a PR **only** if every check below
passes; otherwise it prints each `FAIL:` line and exits 1 without merging. It is
the scripted counterpart to Jon's `scripts/safe_merge.sh`; never use a bare
`PUT .../merge` instead (E-S18-2).

## Usage

```sh
DRY_RUN=1 scripts/or4-merge.sh <pr> <review-file> <reviewed-sha>   # ALWAYS run this first: every check, never merges
scripts/or4-merge.sh <pr> <review-file> <reviewed-sha>             # real merge, only after a clean dry run
JON_ROW=<n> JON_PR=<pr> scripts/or4-merge.sh ...                    # protected PRs only, see below
ALLOW_BEHIND=1 DRY_RUN=1 scripts/or4-merge.sh ...                  # allow a NON-protected PR 1..5 behind (see check 4)
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
| 4 | Behind guard (v3.5) | `behind_by == 0` passes. `behind_by > 0` passes only if **all** hold: `ALLOW_BEHIND=1`; the PR is **not protected** (check 8's class: label, `[billing]` title or path; `JON_ROW` does not help); `behind_by ≤ 5` (`MAX_BEHIND` may lower it, never raise it); PR files and main files since the merge-base are **disjoint**; **no hot/coupled file** (below) on either side; and main **deleted or renamed nothing** since the merge-base. Else `FAIL: ... update-branch first` listing up to 5 paths. Any listing error or empty listing while behind fails closed. |
| 5 | Not draft | PR `draft == false`. |
| 6 | No merge-bot labels | None of `fast-path`, `rollback-safe`, `adversarial-reviewed`. |
| 7 | Checks green | Every check-run on the head SHA has conclusion `success` or `skipped` (pending counts as failing). |
| 8 | Protected class (v3.3) | A PR labelled `needs-jon-approval`, titled `[billing]`, or touching a protected path **fails** unless `JON_ROW=<numeric ledger row>` is set (see below). |
| 9 | Check-run count (v3.2) | At least 10 check-runs must be registered on the head SHA, or refuse. |
| 10 | Commit statuses (v3.2) | Every commit status on the head must be `success` (failure/error/pending refuse). |
| 10a | Snapshot pin (v3.4, v3.5) | Every run: compare `base_commit.sha` == `GET branches/v3/main` == local `origin/v3/main`, and compare `merge_base_commit.sha` == the local merge-base; else `FAIL: main moved during gate`. |
| 10b | Clone integrity (v3.5, #384) | `git replace -l` in the clone must be empty (else FAIL). At start the gate unsets `GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_REPLACE_REF_BASE GIT_NAMESPACE GIT_COMMON_DIR` and exports `GIT_NO_REPLACE_OBJECTS=1`. It keeps `GIT_CONFIG_*`, `GIT_ASKPASS`, `GIT_SSL_CAINFO` (proxy/auth). |
| 10c | Main unmoved (v3.5) | Immediately before the PUT, `branches/v3/main` is re-read; if it differs from the pinned SHA: `FAIL: main moved; re-run`, exit 1, no PUT. |
| 11 | Merge | `PUT pulls/<pr>/merge` with `merge_method=squash` and `sha=<head>` pinned, so a push between check and merge is rejected by GitHub. Exit 1 unless the PUT succeeds **and** `merged_at` is set. |

## Behind guard and `ALLOW_BEHIND` (v3.5)

Jon turned off "require branches up to date" on ruleset 26478884 (2026-11-23 16:34 Vancouver, LEDGER-19A rows 63/65), so
the gate need not force update-branch + a full CI rerun after every merge. v3.5 keeps that, but only on explicit request:

- `ALLOW_BEHIND` unset or anything but `1` → any `behind_by > 0` FAILS (update-branch first). This is the default.
- `ALLOW_BEHIND=1` → a **non-protected** PR may be 1..5 behind when the file conditions hold. A **protected** PR always needs
  `behind_by == 0`, even with `ALLOW_BEHIND=1` and a valid `JON_ROW`/`JON_PR` (Jon's approval covers the content, not a stale base).

Hot/coupled files (any depth, case-insensitive; exact regexes in `or4-merge.sh`):
- **PR side:** `HOT_RE ∪ COUPLED_RE`.
- **Main side:** `HOT_RE ∪ (COUPLED_MAIN_RE minus MAIN_EXEMPT_RE)`. The exemption (`scripts/or4-merge.sh`, `scripts/test_or4_merge.py`,
  which no CI job runs or imports) applies to `COUPLED_MAIN_RE` only, never to `HOT_RE`; so `AGENTS.md`/`CODEOWNERS` on main still FAIL.
- `HOT_RE` (v3.4): lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `uv.lock`, `poetry.lock`, `Cargo.lock`), any
  `package.json`, any `migrations/` path, `AGENTS.md`, `CODEOWNERS`, `.github/workflows/**`, `tsconfig*.json`, `next.config.*`,
  `pnpm-workspace.yaml`, Python pins (`constraints*.txt`, `requirements*.txt`, `pyproject.toml`), `.npmrc`, `.nvmrc`, `turbo.json`,
  `Dockerfile*`, `fly.toml`, `docker-compose*.yml`, `Makefile`, `.eslintrc*`, and `packages/types/{schema/contract.schema.json,src/generated.ts}`.
- `COUPLED_RE` (19B, PR side) adds: `.node-version`, `.python-version`, `.tool-versions`, `setup.cfg`, `conftest.py`, `models.py`,
  `generated.ts`, `*.config.{js,ts,mjs,cjs,mts,cts}`, `.prettier*`/`.eslint*`, all of `.github/`, `scripts/`, `**/.claude/`, and any
  path containing `AGENTS.md` or `CLAUDE`.
- `COUPLED_MAIN_RE` (19B, main side): the same build/test inputs, but only `.github/{workflows,actions}/` and code files under any
  `scripts/` dir; docs, `CLAUDE*`, `.claude/` on main are not build/test inputs.

Main deletions/renames: `git diff --no-renames --diff-filter=D <merge-base> origin/v3/main` must be empty (a rename is a delete+add).

**Snapshot pin (v3.4 R2, unconditional since R3; v3.5 adds `GET branches/v3/main`):** right after the fetch, one `compare` call returns `behind_by`, `base_commit.sha` and `merge_base_commit.sha`, and `branches/v3/main` is read. Behind or not, the gate FAILS
(`main moved during gate; re-run`) unless the base equals the local `origin/v3/main` and the merge-base equals the `$mb` used for the file
listings. v3.5 re-reads main right before the PUT (check 10c), so the remaining window is one API round-trip. A hot file changed on either side forces update-branch even without overlap.

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

`python3 scripts/test_or4_merge.py` (offline, no network; 48 tests). It sources `or4-merge.sh` with `OR4_LIB=1`, which defines the
regexes and functions and returns before any network call, so the tests exercise the script's own definitions:
- protected-path regex (35 protected paths, 6 ordinary), `protected_decision` (JON_ROW/JON_PR/label/title/paths), `is_protected_pr`;
- `overlap_decision`: v3.4 cases (disjoint, overlap, hot file either side, lookalikes, listing failure, cap, renames) and `R2Harness`,
  a 54-case table derived from 19B's v3.4-R2 rules (the 52-case harness itself was not attached to #385): ALLOW_BEHIND, protected,
  ≤5, coupled PR/main files, main exemptions, main deletions/renames;
- end-to-end `GateWiring` (`DRY_RUN=1`, `OR4_REPO` temp clone, PATH-shimmed `gh`): pin (compare + branches), ALLOW_BEHIND, protected+behind,
  behind 6, main deletion and rename, coupled/exempt files on main, replace refs, `GIT_DIR`-style env redirect neutralised;
- `Hardening`: env scrub keeps proxy/auth vars, `replace_check`, `main_unmoved` and that it is the last command before the PUT;
  the `OR4_REPO` guard exits 1 with zero `gh`/`git` calls (logging shims, #384 I1);
- rename/non-ASCII listing regressions, fail-closed listing, verdict markers `PASS 91..100` accepted, `PASS 90`/`FAIL 95`/missing `HEAD`/bad SHA refused.

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
