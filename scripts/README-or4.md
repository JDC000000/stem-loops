# or4-merge.sh — orchestrator merge gate (OR-4 v3.6.2, §11 R6)

**One gate for both sessions.** 19A (agentic/ops) and 19B (product) both merge through this script. v3.5 replaces 19A's v3.4
(#382) and 19B's v3.4-R2 (#385, Jon approved the design 2026-11-23 23:29Z, "structurally solve" merge contention). Do not run a
local fork of it; change it here, by PR (protected path). Tightening-only gate changes may be self-approved under M-SA with two reviewers;
loosening changes are HELD for Jon (AGENTS.md M-8). When in doubt whether a change loosens a control, treat it as HELD.

| Version | Where | Behind rule | Notable |
|---|---|---|---|
| v3.3-R2 | main (S18) | `behind_by == 0` | protected class + `JON_ROW`/`JON_PR` |
| v3.4 | main, #382 (19A) | 1..20 behind for ANY PR if file-disjoint and no hot file | snapshot pin every run; `OR4_REPO` only in test mode |
| v3.4-R2 | 19B local copy, #385 | opt-in `ALLOW_BEHIND=1`; non-protected only; ≤ 5; no overlap; no coupled file; no main deletions/renames | `branches/v3/main` re-checked right before the PUT |
| v3.5 | main | strictest union of both (below) | + #384: git env scrub, `git replace` refs FAIL, `OR4_REPO` guard tested for rc and zero network calls |
| v3.5.1 | main | unchanged from v3.5 | **tightening only** (#391, #393): strict `DRY_RUN`/`ALLOW_BEHIND`; PUT `sha=<head>` and pre-PUT main-moved tests; gate text names the `JON_ROW` ledger row |
| v3.6 | main | unchanged | **tightening only** (D-7, #396): money class (marker >= 93 + `SCORES:` line 2); protected needs two review files; one `VERDICT:` line per review; `LC_ALL=C`; merge-tail fails closed |
| v3.6.1 | main | unchanged | **tightening only** (#406): wider `MONEY_RE` (250 -> 337 of the 1352 files tracked at 596371c; re-measured for #430 at f9f92f3: 342 of 1388 match v3.6.2's `MONEY_RE`); any non-ASCII path = money; `VERDICT:`/`SCORES:` counted case-insensitively and when indented |
| **v3.6.2** | **main** (#427; #430 residue) | unchanged | **tightening only** (#413): `MONEY_RE` += `library-server`, `emails/dispatch`, `jobs/[id]/page.tsx`; reworded markers (`**VERDICT: FAIL**`, `> VERDICT:`, NBSP) count as VERDICT/SCORES lines; mutant-killing tests; #430: `SCORES (final): 40` counts, CRLF line numbers |

The orchestrator's merge gate. It squash-merges a PR **only** if every check below
passes; otherwise it prints each `FAIL:` line and exits 1 without merging. It is
the scripted counterpart to Jon's `scripts/safe_merge.sh`; never use a bare
`PUT .../merge` instead (E-S18-2).

## Usage

```sh
DRY_RUN=1 scripts/or4-merge.sh <pr> <review-file> <reviewed-sha>   # ALWAYS run this first: every check, never merges
scripts/or4-merge.sh <pr> <review-file> <reviewed-sha> [<review-file-2>]   # real merge, only after a clean dry run
JON_ROW=95 JON_PR=<pr> scripts/or4-merge.sh ...                    # protected PRs only (D-6 standing approval row), see below
ALLOW_BEHIND=1 DRY_RUN=1 scripts/or4-merge.sh ...                  # allow a NON-protected PR 1..5 behind (see check 4)
```

- `<pr>` — numeric PR number on `JDC000000/stem-loops`.
- `<review-file>` — local path to the reviewer's write-up.
- `<reviewed-sha>` — the full commit SHA the reviewer actually reviewed.
- `<review-file-2>` — (v3.6) 4th positional arg (no env var): REQUIRED for protected PRs; see below.

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

## v3.5.1 (tightening only; no check removed or loosened)

- **Strict switches (#391).** `DRY_RUN` and `ALLOW_BEHIND` must each be unset, `0` or `1`. Any other value (`true`, `yes`, `TRUE`, `2`, ` 1`, empty)
  exits 1 with `FAIL: DRY_RUN must be 0 or 1` / `FAIL: ALLOW_BEHIND must be 0 or 1` before any `gh`/`git` call (and before the `OR4_REPO` guard).
  Previously any non-`1` value silently meant "real merge" / "behind not allowed".
- **Tests (#391 M38, M09).** The merge PUT is captured from a shimmed `gh` and must carry `-f sha=<head>` and `merge_method=squash`; a main move between the
  snapshot and the pre-PUT re-check must print `FAIL: main moved; re-run`, exit 1 and issue no PUT.
- **Gate text (#393).** The header and the protected-PR FAIL message now say `JON_ROW = ledger row of the approval (D-6 standing row 95 for self-approved merges, per AGENTS.md M-8)`.
  Text only: the check is unchanged (numeric `JON_ROW`, `JON_PR` equal to the PR).

## v3.6 (tightening only; no check removed or loosened)

- **Money class (D-7, AGENTS.md M-SA condition 6).** A PR is *money* if a changed path matches `MONEY_RE` or its title has `[billing]` (title read with `jq`;
  an unreadable/unparsable PR = money, fail closed), or the orchestrator sets `MONEY=1`. **`MONEY_RE` is a floor, not the classification:** it over-matches
  on purpose (billing, stripe, entitlement, auth/login/oauth, credits, sessions, service-role, secret, rls, roles, grants, webhook, job creation/admission/access,
  claim-jobs, uploads, retention/cleanup, spend, replicate, klangio, worker pipeline, r2, pricing/price/plan-/checkout/subscription/refund/trial/payment/quota,
  `users/me`, ...) and still misses money code at paths with no such word. The orchestrator keeps classifying by reading the changed-file list and sets
  `MONEY=1` when in doubt. `MONEY` must be unset, `0` or `1` (anything else fails before any network call); it can only **raise** the class, `MONEY=0`
  never lowers it. The `needs-jon-approval` label is protected, **not** money. **Money implies protected:** a money PR gets every protected requirement
  (numeric `JON_ROW` + matching `JON_PR`, behind 0 and `ALLOW_BEHIND` refused, two review files) even when no path matches `PROTECTED_RE`. For every review
  file the gate sees, a money PR also needs line 1 = `VERDICT: PASS <93-100> HEAD <sha>` (nothing after the sha) and **line 2 exactly**
  `SCORES: M-9 <n> M-11 <n>` (both integers 93-100, no extra text, no CRLF) as the **only** `SCORES:` line. Free-text or table scores do not count.
- **Review file format (all PRs).** Every review file must have exactly one `VERDICT:` line (any case counted), it must be line 1, and it must be a PASS marker.
  An earlier FAIL followed by a quoted later PASS line therefore refuses.
- **Two reviews for protected PRs.** The second review file is the **4th positional argument** (not an env var). Both need a valid PASS marker at the same
  `<reviewed-sha>` and must name it; they must be different files (not the same path or a hard/symlink), not byte-identical, and not identical after
  normalisation (CRLF -> LF, trailing whitespace stripped, blank lines dropped). **This is a byte-level check, not proof of independence:** an edited copy
  still passes. Non-protected PRs still need one. A money+protected PR needs line 1 and `SCORES` in both.
- **Locale.** The gate exports `LC_ALL=C` and matches paths with `grep -a`, so a path containing a non-UTF-8 byte cannot be skipped as "binary" under a UTF-8 locale.
- **Merge tail (#396).** The pre-PUT main re-check fails closed on any `gh` error (`FAIL: cannot re-read v3/main`, no PUT). A PUT error exits 1 with
  `FAIL: merge PUT failed, NOT merged: <gh output>`, and a PUT response without `merged=true` exits 1. After the PUT the PR is re-read: a `gh` error or a null/empty
  `merged_at` exits 1.
- **Not enforced (process):** that the reviewers are on different models, or that the second file is really a second reviewer's work; the orchestrator verifies and
  logs both reviewers (M-SA).

## v3.6.1 (tightening only; #406, from the R2 reviews of #401)

- **`MONEY_RE` widened** (a floor, still: the orchestrator classifies and sets `MONEY=1` when in doubt). Added: `api/library` (incl. `remake`), `remake`, worker `reaper` and
  `consumer`, `stem-urls` / `stem-keys`, signed/presigned URLs, `account` path segment (pages, deletion), `db.ts` / `db-*`, `job_failure`, `retry`, `delete`/`deletion`,
  `erase`, `allowance`, `debit`, `commercial`, `seed_plans`, `fetch_gates`, `rate-limit` / `demo-rate` / `client-ip`, `chords-claim`, `job-page-gate`, `download-gate`,
  `receipt`, `success/` (post-checkout), `job_attempts`, `NNN_jobs` migrations. Survey of `git ls-files` at 596371c: 1352 files, **250 money before, 337 after (+87)**.
  Accepted false positives: `apps/web/src/lib/db-ssl.ts` and its test, design screenshots under `docs/design/` whose names contain `account`/`retry`/`delete`/`remake`,
  `account/layout.tsx`, `packages/web-browser-gate/journeys/j13-retry.mjs`, test files for the same areas. Over-matching costs a second review, never a merge.
- **Non-ASCII = money.** `LC_ALL=C` has no Unicode case folding (U+017F would hide `stripe`), so any changed path with a byte >= 0x80 is money (and therefore protected).
- **Strict counting.** `VERDICT:` and `SCORES:` lines are counted case-insensitively **and** with leading whitespace (`^[[:space:]]*`). A later reworded-case or indented
  `VERDICT: FAIL` / second `SCORES:` line now fails the one-line rule. The line-1 / line-2 requirements are unchanged.

## v3.6.2 (tightening only; #413, from the R1 reviews of #411 / #410)

- `MONEY_RE` also covers `apps/web/src/lib/library-server.ts`, `apps/web/src/app/jobs/[id]/page.tsx`, `apps/web/src/lib/emails/dispatch.ts`.
- `MONEY_RE` also covers `jobs/[id]/JobView.tsx` and `emails/resend.ts`.
- Case-insensitive counting predates v3.6.1; v3.6.1 added only indentation. v3.6.2 counts a line when, after a prefix of non-letters (indent, tab, NBSP, `>`, `**`, `#`, `|`, `- `, `1.`, `2)`, backtick), `[x]` boxes and short labels (1-3 letters + digits: `R1`, `M2`, `F3`, `PR4`), it has `VERDICT` followed by a colon (only non-alphanumerics between) or by `PASS`/`FAIL` (at most one word between), or `SCORES` followed by a colon, a number, or `M-9`/`M-11` (at most one word between). Lone CR, form feed, VT, NEL, U+2028 and U+2029 count as line breaks. The FAIL message names the counted line numbers.

  | Shape | Counted? |
  |---|---|
  | `**VERDICT: FAIL**`, `> VERDICT: FAIL`, NBSP/ZWSP + `VERDICT: FAIL`, `VERDICT : FAIL`, `VERDICT (final): FAIL`, fullwidth colon | yes |
  | `1. VERDICT: FAIL`, `- [x] VERDICT: FAIL`, `R1 VERDICT: FAIL`, `\| VERDICT \| FAIL \|`, `VERDICT PASS 99`, `VERDICT - FAIL` | yes |
  | `R1 SCORES: M-9 1 M-11 1`, `SCORES 40 40`, `SCORES M-9 1`, `**SCORES**: ...` | yes |
  | `## Verdict`, `**Scores**`, `\| M2 VERDICT count back to ... \|`, `- SCORES on line 2, both 93-100`, `verdict_unique`, `The verdict was good`, `Final verdict: FAIL` | no |

- **Reviewers: outside line 1 (and line 2 for money) no line may begin, after indentation / quote / list / table / heading markup, numbering, `[x]` or a short label such as `R1`, `M2`, `F3`, with `VERDICT` then a colon or `PASS`/`FAIL`, or with `SCORES` then a colon, a number or `M-9`/`M-11`.** Headings, table rows and prose that only mention the words are fine.
- **Residual (still hidden):** zero-width characters or homoglyphs inside the word, the bare word alone on a line, two or more words before `PASS`/`FAIL`, underscore-joined forms, the word + space + prose (`VERDICT changed to FAIL`), the word not at line start (`Final verdict: FAIL`), the word split across two lines, edited copies as a second review, marker score vs `min(M-9, M-11)`.

### #430 residue (tightening only; still v3.6.2; from the 21A reviews of #427)

- `SCORES` + **one** word (letter first: `final`, `(R2)`) + a colon + a number is now counted too: `SCORES (final): 40 40`, `SCORES final: 40`, `**SCORES (final)**: 40`.
  Still not counted (prose): `Scores below 93 fail` (no colon), `Scores breakdown: see the table` (no number), `Scores per axis: 95` (two words), `SCORES_final: 40` (underscore-joined).
- Pinned by tests, behaviour unchanged: `PASS`/`FAIL` must be a whole word (`Verdict passes muster`, `VERDICT failed to parse` are not counted; `VERDICT PASS.`, `VERDICT FAIL_x` are);
  `VERDICT<form feed>: FAIL` fails the file because the raw count (2) differs from the normalised count (1) and `marker_one` needs both to be 1.
- The FAIL message's counted line numbers: CRLF is folded to LF first, so a CRLF file is numbered as an editor shows it; a lone CR / FF / VT / NEL / U+2028 / U+2029
  inside a line still starts a new number. Folding CRLF only removes empty lines, which are never counted, so the counts are unchanged.
- Checked against every real review file on disk before review (the 20 review comments on #409, #410, #411, #426, #427, #428): counts identical to v3.6.2 on `v3/main`,
  and no line in `git ls-files` at f9f92f3 is newly counted.

## Behind guard and `ALLOW_BEHIND` (v3.5)

Jon turned off "require branches up to date" on ruleset 26478884 (2026-11-23 16:34 Vancouver, LEDGER-19A rows 63/65), so
the gate need not force update-branch + a full CI rerun after every merge. v3.5 keeps that, but only on explicit request:

- `ALLOW_BEHIND` unset or anything but `1` → any `behind_by > 0` FAILS (update-branch first). This is the default.
- `ALLOW_BEHIND=1` → a **non-protected** PR may be 1..5 behind when the file conditions hold. A **protected** PR always needs
  `behind_by == 0`, even with `ALLOW_BEHIND=1` and a valid `JON_ROW`/`JON_PR` (the standing approval covers the content, not a stale base).

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

## Protected class and `JON_ROW` (v3.3; D-6 standing row from v3.5)

Protected paths (always case-insensitive): `.github/`, `scripts/`, `**/.claude/`, and at ANY depth `AGENTS.md`,
`CLAUDE*`, `.mcp.json`, `SKILL.md`; plus `CODEOWNERS`, any `migrations/`, `.env*`, and any path containing
`billing`, `stripe`, `entitlement`, `auth` (as a directory or `auth.*` file), `authz`, `oauth`, `middleware`,
`webhook`, `service-role`/`service_role`, or `secret`. The exact regex is `PROTECTED_RE` in `or4-merge.sh`.
The path list is `git diff --no-renames --name-only -z` with `core.quotePath=false`, so a rename lists both the
old and the new name and non-ASCII names are not quoted. The gate FAILS CLOSED if the merge-base or the diff
fails or lists nothing, or if the PR labels/title cannot be read.

Such a PR is refused unless **both** are set: `JON_ROW=<ledger row>` (**95**: the JON D-6 standing approval, 2026-11-23 19:50 Vancouver, "stop asking me to merge") and `JON_PR=<pr>` equal to the PR number being merged (ties the approval to this PR;
a stale exported JON_ROW cannot approve another PR). The gate prints both. It cannot verify the ledger row
itself. The gate only checks that both are numeric and `JON_PR` equals the PR (any numeric row passes). Set them only for a PR that meets M-SA (canonical: AGENTS.md M-8): a reviewer-agent PASS review, and a second reviewer on a third model for every protected-class PR. A HELD change (gate loosening, M-SA, CODEOWNERS, settings, rulesets, workflow merge logic) is not self-merged. The gate does not check reviewer model, a second review, or dry-run order; those are process duties. Always run `DRY_RUN=1` first (`DRY_RUN` must be unset, `0` or `1`; anything else FAILs; #391), and unset both after the run.

`OR4_LIB=1` is for tests only: sourcing defines the functions; executing the script with it prints
`OR4_LIB set: library mode, NOT a merge` to stderr and exits 2.

## Tests

`python3 scripts/test_or4_merge.py` (offline, no network; 53 tests). It sources `or4-merge.sh` with `OR4_LIB=1`, which defines the
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

## session-merge.sh — the one session wrapper (A and B; replaces per-session copies such as merge1-B.sh v2.5)

`scripts/session-merge.sh` claims a merge window on #414, un-drafts, updates the branch, waits for green CI, re-fetches **this gate**
from `origin/v3/main`, runs `DRY_RUN=1` first, posts both reviews + the dry run on the PR, runs the real gate, and RELEASEs on #414.
It adds **no merge route** and loosens no gate check: every merge still goes through `or4-merge.sh`. Orchestrators only; run in the foreground.

```sh
SESSION_TAG=23A scripts/session-merge.sh <pr> <reviewed_sha_full> <review-1.md> <review-2.md>   # two different review files (A1)
SESSION_TAG=23B scripts/session-merge.sh ack <comment-id>...                                   # post one "ACK 23B <id>,<id>" line on #414
```

- **Protocol** (one marked CONFIG section in the script; `PROTOCOL 2026-11-28` (v1.1, Jon L6, LEDGER-24A row 10), valid to 2026-12-19T00:00Z = 2026-12-18 16:00 Vancouver,
  after which every claim is refused until the section is renewed by PR): an **A** session claims only when its whole 40-min window fits
  inside an A block (15:00–17:00Z, 21:00–22:00Z); a **B** session only when its window touches no A block; **both** refuse a window touching
  a DEPLOY slot (18:00–18:30Z, 23:00–23:30Z) and any other session's live CLAIM/DEPLOY (untagged lines count as another session's).
  Freeze: any session's PR with an `apps/` file from 2026-11-27T23:00Z until 2026-12-03T01:00Z (`FREEZE_AT`, `FREEZE_END`; the beta no-deploy
  window ends 12-02 18:00 Vancouver) unless `BLOCKER=<issue>`; a listing of 100+ files counts as apps (fail closed).
- **Shared files (v1.1):** before claiming, prints `WARNING: open PR #N also changes: <files>` for every other open PR that changes a file this
  PR changes. A warning only: it never refuses, and an unreadable listing is reported (`WARN shared-file check skipped …`) and skipped.
- **CI watch:** PR CI and main CI after the merge are each awaited up to `CI_WATCH_SECS` = 2400 s (40 min; was 30 min) before `unknown`.
- **Unread-note guard:** before claiming and again before the gate, every comment of #414's last two pages whose first line starts with
  `NOTE`, `PROTOCOL` or `QUEUE` (case-insensitive, after markdown markup), posted at/after the cutoff, not by this session (first-line
  token 2 is exactly the own tag: write notes as `NOTE <author-tag> …`, e.g. `NOTE 23B hold #500`; `NOTE 23B: …` is not exempt for 23B) and not covered by an `ACK <own tag> <id>[,<id>…]` line (any line of any comment) stops the run with **exit 13**,
  printing id + first line. Read it, then `ack` it. An ACK of another id, or another session's ACK, does not count.
  `ack` refuses (exit 2, nothing posted) any id that is not a NOTE/PROTOCOL/QUEUE comment of the last two pages. The trap's
  `INFO <tag> #P window abandoned …` post is neither a protocol line nor a note, so it needs no ACK.
- **First adoption:** the first run exits 13 until every older NOTE/PROTOCOL/QUEUE line in the two-page window is ACKed. Either read and
  `ack` them, or, once they are read, run with `ACK_SINCE=<ISO time of adoption>` (e.g. `ACK_SINCE=2026-11-25T23:00:00Z`) so only later notes count.
- The dry run passes only if the gate exits 0 **and** prints the exact line `DRY_RUN fail=0 (no merge)`.
- **Env:** `SESSION_TAG` (required, `^[0-9]{2}[AB]$`) · `BASE` (default `/home/claude/s23`) · `JON_ROW` (default 95) ·
  `ALLOW_WINDOW=<#414 comment id>` where the other session agreed (waives only the A/B block rule, never a DEPLOY slot, the freeze or a live claim) ·
  `BLOCKER=<issue>` · `ACK_SINCE=<ISO time>` (note cutoff; default = oldest comment in the two-page window).
- **Exit codes:** 0 merged and main CI green (`ack`: posted) · 2 usage · 3 window busy / protocol / freeze · 4 un-draft refused ·
  5 update-branch · 6 PR CI not green · 7 DRY_RUN fail or gate fetch failed · 8 merge failed · 9 main CI RED (stop all merges, M-5) ·
  10 main CI unknown · 11 #414 unreadable or a #414 post failed · 12 merged but RELEASE post failed (post by hand) · 13 unread #414 note.
- #414 pages are written to files, never argv; every #414 post reads back after an error before retrying (no double CLAIM/RELEASE/ACK);
  a trap RELEASEs the claim on any exit (not on kill -9 or a restart: release by hand).
- Tests: `python3 -m pytest scripts/test_session_merge.py -q` (offline; `gh`, `date`, `sleep` stubbed via PATH; A/B block boundaries,
  DEPLOY slots, live/untagged claims, unread notes + ACK, `ack` 5xx read-back, freeze with/without `apps/` files, freeze end, protocol expiry,
  shared-file warning, CI watch length).
