# AGENTS.md — Canonical Context File

> This is the SINGLE CANONICAL context file for the stem-loops repository.
> All agents (Claude Code, Cursor, Copilot, CI bots) must read this file first.
> CLAUDE.md is a thin pointer to this file only.

## Project Overview

**stem-loops** is a web app that takes a YouTube URL, separates the audio into stems (vocals/drums/bass/other) using AI (Replicate + demucs), extracts musical loops, and serves them for download.

## External Documents (on CRHQ platform)

- **PRD**: `documents/requirements/stem-loops/requirements.md`
  - Contains §10 Handoff Rules for Claude Code
  - Full product requirements, user stories, acceptance criteria
- **TSD**: `documents/requirements/stem-loops/technical-scope.md`
  - Contains §6 Data model (jobs/job_events/loops tables)
  - Contains §6.2 Error codes
  - Contains §6.3 State machine
  - Contains §8 Anti-goals (V1 mistakes to NOT repeat)
  - Contains §9 Build order
  - Contains FLAG 1 resolution (this file is the canonical context)

## FLAG 1 Resolution (TSD reference)

The TSD flags a potential ambiguity about which file is the canonical context for Claude Code.
**Resolution: AGENTS.md (this file) is the single source of truth.**
- CLAUDE.md points here and contains nothing else
- If any context file conflicts with AGENTS.md, AGENTS.md wins

## Architecture

```
apps/web/          Next.js 14 App Router → Vercel Hobby
apps/worker/       Python FastAPI + pipeline → Fly.io / Render
packages/types/    Pydantic → JSON Schema → TypeScript (codegen)
fixtures/          CI fixtures (cached audio, golden loops) — committed to git
evals/bugs.json    Regression tracking — pre-allocated per TSD §9
```

## State Machine (TSD §6.3)

```
jobs.status:  queued → downloading → separating → extracting → uploading → done
                                                                          → failed
```

Active stages emit events (job_events table):
- Each active stage (downloading/separating/extracting/uploading) emits: `started`, then `completed` OR `failed`

## Error Codes (TSD §6.2)

| Code | When |
|------|------|
| DOWNLOAD_BLOCKED | yt-dlp blocked/unavailable |
| DOWNLOAD_TIMEOUT | yt-dlp timed out |
| DOWNLOAD_INVALID_URL | Not a valid YouTube URL |
| DOWNLOAD_AGE_RESTRICTED | Video age-restricted |
| DOWNLOAD_PRIVATE | Video is private |
| SEPARATION_FAILED | Replicate/demucs error |
| EXTRACTION_FAILED | Loop extraction error |
| UPLOAD_FAILED | R2/MinIO upload error |
| INTERNAL_ERROR | Unexpected error |
| RATE_LIMITED | Rate limit exceeded |

## §9 Build Order

1. **Foundation** — DB schema, migrations, worker health, types codegen, CI green
2. **Audio Pipeline** — Download (yt-dlp), Separate (Replicate demucs), Extract loops, Upload to R2
3. **UX Polish** — Web UI, job status polling, loop playback, download
4. **Production/Ship** — Rate limiting, IP hashing, expiry cleanup, deploy pipeline

## §8 Anti-Goals (V1 mistakes — DO NOT repeat)

- Do NOT expose secrets to the browser. All API tokens are server-side only.
- Do NOT call Replicate from the web layer. Only the worker calls Replicate.
- Do NOT store audio files in the database. Use R2/MinIO only.
- Do NOT block the event loop in the FastAPI worker. Use thread pool for pipeline.
- Do NOT skip the migration runner. Always run `make migrate` before `make dev`.
- Do NOT hard-code URLs or bucket names. Always use environment variables.
- Do NOT commit `.env`. Only `.env.example` is committed.
- Do NOT add audio files (*.wav, *.mp3, *.flac) outside of `fixtures/`.
- Do NOT generate TypeScript types by hand. Always run `make types-generate`.

## Secret Convention

**All secrets are server-side only. Never in the browser. Never requested from users.**

| Variable | Where used | How to get |
|----------|-----------|------------|
| REPLICATE_API_TOKEN | worker only | replicate.com/account |
| R2_ACCESS_KEY_ID | worker only | Cloudflare R2 dashboard |
| R2_SECRET_ACCESS_KEY | worker only | Cloudflare R2 dashboard |
| R2_ENDPOINT | worker only | Cloudflare R2 dashboard |
| R2_BUCKET_NAME | worker only | Create in R2 dashboard |
| DATABASE_URL | worker + web (server) | Supabase dashboard |
| DATABASE_POOL_URL | worker + web (server) | Supabase dashboard |
| BETTERSTACK_SOURCE_TOKEN | worker + web | betterstack.com |
| IP_HASH_KEY | worker + web (server) | `openssl rand -hex 32` |
| HISTORY_COOKIE_KEY | web (server) | `openssl rand -hex 32` |

See `.env.example` for the full list with documentation.

## Make Targets

| Target | What it does |
|--------|-------------|
| `make dev` | Spin up web + worker + Postgres + MinIO via docker-compose, run stub job end-to-end |
| `make test-job URL=...` | Run worker on one URL with verbose logging, no queue |
| `make types` | Run Pydantic → JSON Schema → TS codegen AND check for drift |
| `make types-generate` | Run codegen only (no drift check) |
| `make test` | Run pytest + pnpm test |
| `make lint` | Run ruff + black check + eslint |
| `make deploy-web` | Deploy to Vercel |
| `make deploy-worker` | Deploy to Fly.io |
| `make migrate` | Run database migrations (idempotent) |
| `make install` | pnpm install + pip install -r requirements.txt |

## Type Source of Truth

`apps/worker/src/models.py` — Pydantic models — is the SINGLE SOURCE OF TRUTH for all types.

- Any schema change → edit models.py → run `make types-generate` → commit both
- CI (types-drift job) will fail if generated types are out of sync with models.py
- TypeScript consumers import from `@stem-loops/types` (packages/types)

## PRD §10 Handoff Rules for Claude Code

1. Always read AGENTS.md first. It supersedes all other context.
2. Run `make install` before starting any work session.
3. Run `make dev` to verify the full stack is working before making changes.
4. Run `make lint` and `make test` before committing.
5. Never edit `packages/types/src/generated.ts` by hand — run `make types-generate`.
6. Follow the §9 build order — do not skip ahead to UX before the pipeline works.
7. When adding a new model field, update models.py and run `make types-generate`.
8. All new secrets go in `.env.example` with a comment explaining how to obtain them.
9. Regression bugs go in `evals/bugs.json`.
10. The state machine (§6.3) is fixed — do not add or rename statuses.

## §11 Merge Safety Rules (added 2026-11-03 after #21 CI-bypass incident)

The session that landed PRs #16–#26 used `gh pr merge --admin --squash` to
bypass CODEOWNERS self-approval and required-check name mismatches. That is
the intended use — the author-is-reviewer deadlock is why `--admin` exists.
But on PR #21 it also bypassed THREE FAILING status checks (Fixture pipeline,
Tests, Lint) and shipped a migration that broke CI on `v3/main` for every
subsequent PR. Hotfix PR #27 restored green CI. These rules exist so that
cannot recur.

**M-1 (hard): `--admin` must not bypass a FAILING status check.** Admin
bypass is for the CODEOWNERS / required-review layer only. If any check-run
is red OR pending OR absent, do not merge — fix CI first, then merge. Use
`scripts/safe_merge.sh <N>`, which enforces this (refuses on failure,
cancelled, timed_out, pending, and on commits with zero check-runs).

Manual check (equivalent to what the script does, if you need to inspect
without merging):

```bash
N=<pr>  # e.g. N=29
HEAD=$(gh api "repos/JDC000000/stem-loops/pulls/$N" --jq '.head.sha')
gh api "repos/JDC000000/stem-loops/commits/$HEAD/check-runs?per_page=100" --jq '
  .check_runs
  | map(select(
      .status != "completed"
      or .conclusion == "failure"
      or .conclusion == "cancelled"
      or .conclusion == "timed_out"
    ))
  | map({name, status, conclusion})
'
# Must print []. If non-empty, STOP and fix CI. Also fail if the top-level
# check_runs array is empty — CI has not registered yet. This matches what
# scripts/safe_merge.sh enforces operationally (pending OR concluded-bad).
```

**M-2 (hard): adversarial reviewers must verify CI is green** before
scoring ≥93. Local `check_rls.py` passing is not enough — the review prompt
includes a CI-check step and the reviewer states the result in the report.
A reviewer who CANNOT run CI must state that explicitly so the author
knows to re-check before promoting to ready-for-review.

**M-3 (medium): migrations with Supabase-only objects need stubs.** When a
migration references anything Supabase manages (`auth.*` schema, the
`authenticated` / `anon` roles, helper fns like `auth.uid()`, and also
`storage.*`, `realtime.*`, `vault.*`, `extensions.*`, etc.), the author must
include a stub either in the same migration or in a prior one.
`012_v3_supabase_stubs.sql` is the exemplar. Future improvement: a CI
matrix job that runs migrations against a Postgres image with the Supabase
prelude pre-seeded, so both bare-Postgres and Supabase-like paths are
covered.

**M-4 (medium): no cross-PR TYPE ↔ CODE drift.** When one PR adds a
TypeScript enum that maps to a column value (`PlanCode` ↔ `plans.code`), the
same PR must include either the migration setting those values OR a
reference to the migration that does. Each PR's adversarial reviewer must
check the enum values against the DB source of truth in the TSD. The
incident: `types.ts` landed on PR #20 with `'pro_monthly'` / `'studio_monthly'`
while the DB migration on PR #21 used `'pro'` / `'studio'`; every checkout
would have 500'd at the FK layer. PR #29 fixed this (the enum caught up
to the DB); future reviewers should catch it in round 1, not post-merge.

**M-5 (process): hotfix PRs land before any dependent work merges.** If a
merged PR breaks CI (M-1 violated, or an M-4 drift slipped), all other work
blocks until the hotfix is on main. Worker agents can still PUSH their
branches (CI will be red until rebased), but no other merges happen in the
interval.

**M-6 (process): the author of PR #N is a self-approval deadlock on #N.**
GitHub blocks self-approval; CODEOWNERS requires the author's review when
the author is the only owner on touched files. For a solo-dev repo this
means every `needs-jon-approval` PR authored by Jon needs `--admin`
bypass. Combined with M-1, that makes `--admin + green CI` the normal
path. This is working as intended — do not weaken CODEOWNERS to avoid it.

**M-7 (process): service-account path for agent merges (approved
2026-11-03).** The clean structural fix for the M-6 deadlock (and for the
classifier blocking Claude-authored self-merges) is a dedicated GitHub
service account — e.g., `stem-loops-bot` or `claude-code-bot` — with
push + review permissions on this repo. When the dev environment is
configured to author commits as that user:

1. Claude's PRs are "authored by the bot" (not the human owner)
2. Jon (as a different human user) approves them — no self-approval
3. The classifier sees Claude merging *someone else's* PR → green path
4. `--admin` stops being the normal merge path entirely

Until the service account is created, the current workaround stands:
Jon runs `scripts/safe_merge.sh <N>` which enforces M-1 while admin-
bypassing the CODEOWNERS self-approval block. Creating the service
account is a one-time setup step; track it in
`claude/project-tracker.md` under "Structural" and close this note once
it lands. Do NOT weaken CODEOWNERS or branch protection to shortcut
this — those are load-bearing.

**M-7 status, 2026-11-05:** a `stem-loops-automerge` GitHub App now exists
(contents:write, pull_requests:write, metadata:read, installed on this repo
only) and `auto-merge.yml` prefers its installation token. **This body is
NOT yet updated to say M-7 has landed, deliberately — no merge has run
under the App token, so it is unproven in production.** The first auto-merge
after PR #130 logs a `::notice::` naming the credential it used; once that
says "merging as the stem-loops-automerge GitHub App", update this section
with the timestamp and close it. See
`claude/merge-autonomy-level-2-handover.md`.

A line above this section previously claimed M-7 landed on 2026-11-03 in
PR #42. That was false and contradicted this very paragraph. It was deleted
on 2026-11-05 per the adversarial audit. **Do not re-add a "landed" claim
until the `::notice::` evidence exists.**

**M-7 status, 2026-11-06 — LANDED. Evidence below.**

PR **#161** was merged by `stem-loops-automerge[bot]`, type `Bot`:

    GET /repos/JDC000000/stem-loops/pulls/161
      merged_by.login = stem-loops-automerge[bot]
      merged_by.type  = Bot
      merged_at       = 2026-11-06T21:51:40Z
      labels          = rollback-safe, fast-path

That is the field no amount of timing evidence could supply. Until #161,
every auto-merge read `JDC000000` / type `User`, because the workflow fell
back to `BOT_TOKEN` and the API cannot distinguish "Jon's PAT used by
Actions" from "Jon clicked merge". A `Bot` actor can only come from the App
installation token.

**The failure, for the record:** `APP_ID` and `APP_PRIVATE_KEY` both existed
as repository secrets and the App was correctly installed with
contents + pull_requests read/write — but the stored PEM had been pasted
**without its `-----BEGIN RSA PRIVATE KEY-----` and `-----END ...-----`
lines**. Those are the PEM framing, not decoration; without them the key does
not parse, `create-github-app-token` fails, and `continue-on-error: true`
converts that into a silent fallback. Three of issue #143's four suspected
causes had already been eliminated; this was the fourth, and it was invisible
in the UI because GitHub never displays a stored secret.

**Consequences, now unlocked:**
- Merge attribution is auditable. `merged_by` distinguishes automation from a
  human, which it could not do before.
- Dimension 5 of `claude/agent-effectiveness-scoring.md` moves from
  **Inferred** to **Direct** evidence, lifting the cap that rule imposed.
- `BOT_TOKEN` can now be revoked as the real test that the App is doing the
  work — but only deliberately, and not in the same change as anything else.

Close issue #143.

---

### M-8 (reference): what Anthropic's agent-side controls block

Recorded so no future session burns time retrying these. **These are
Anthropic controls on Claude's tool calls, not repo settings.** No GitHub
permission, token, App, ruleset, `.claude/settings.json` entry, or user
statement of approval changes them. A user saying "I approve, you may
override" does not alter them — explain the distinction instead of retrying.

| Operation | Result |
|---|---|
| `gh pr merge --admin` | Routes through **GraphQL**, which is unavailable in-session |
| REST `PUT /repos/{o}/{r}/pulls/{N}/merge` | Classifier: **"Merge Without Review"** |
| `PUT /repos/{o}/{r}/pulls/{N}/ccr/auto_merge` | Classifier: **"Auto-Mode Bypass"** |
| `PUT /repos/{o}/{r}/rulesets/{id}` | Classifier: **dangerous-action denial** (verified 2026-11-05 on the dormant `main` ruleset, chosen deliberately so a denial could not break the live branch) |
| `GET /repos/{o}/{r}/actions/secrets` | **403** — "not permitted through this proxy" |
| `GET /repos/{o}/{r}/collaborators` | **403** — proxy-blocked |
| GitHub **GraphQL** generally | Forbidden. `gh pr view --json`, `gh pr checks`, `gh pr create` all fail — use REST (`gh api repos/{o}/{r}/...`) |
| `GET /repos/{o}/{r}/branches/{b}/protection` | **404 "Branch not protected"** — this repo uses **rulesets**, not classic protection |

**Consequence to internalise:** the agent cannot merge, and the GitHub App
does not change that. The App lets `auto-merge.yml` merge **server-side in
GitHub Actions**, which these controls do not govern. Automation of merging
goes through widening that workflow's scope — never through granting the
agent merge rights.

**Therefore:** ruleset changes and secret writes are always operator
actions. Prepare the exact command and hand it over; do not attempt the
call and do not attempt to route around a denial.

---

### M-9 (hard): adversarial review before merge, on a different model

**Added 2026-11-06.** Full protocol, worked examples and the verbatim
trigger prompt: `claude/dev-playbook-v1.1.md` §27.

**Where that file is.** It lives in the **Claude Project** attached to this
work, NOT in this repository — `claude/` here holds only a handful of docs.
Several paths cited in this file are the same way (`claude/project-tracker.md`,
`claude/merge-autonomy-level-2-handover.md`, `claude/seam-inventory.md`).
An agent with repo access and no Project access will find nothing at those
paths, and nothing fails loudly when it doesn't — it simply proceeds without
the rule. That is a class-6 (Deployment) seam in this file itself.

**So M-9 is written to be binding on its own.** Everything below is the rule,
not a summary of one. If you cannot reach the playbook, follow this section
and say in your handover that you could not read §27. Do not treat an
unreachable reference as permission to skip the review.

**R-6** already requires author subagent ≠ reviewer subagent. **R-7 adds:
the reviewer must run on a different MODEL FAMILY from the author**, not
merely a different context. Two instances of one model share blind spots
and will miss the same thing for the same reason, which is the failure R-6
exists to prevent.

**Review is mandatory before requesting merge when the change is any of:**

1. **A CI gate, or anything that reports pass/fail.** No exceptions. A
   broken gate is worse than no gate, because its green tick is trusted.
2. Anything touching **migrations, grants, RLS, or roles**.
3. Anything on the **money path** — billing, credits, entitlements, Stripe.
4. Anything whose failure mode is **silence** — seam classes 5 (Trigger)
   and 6 (Deployment). Those are: a **Trigger** seam, where the thing that
   was supposed to fire never fired, and a **Deployment** seam, where code
   and the environment it runs against disagree. Both fail silently. (The
   full six-class taxonomy is in the Project's `claude/seam-inventory.md`;
   the two named here are what this trigger needs.)
5. Anything the author **verified only by running it successfully**. A
   thing that works is not a thing that is right.

**The bar: below 90/100 is not merged.** Revise and re-review. Rounds
continue until the reviewer clears 90, or states plainly that the remaining
defects are accepted, named and recorded. Tell the reviewer explicitly
**not to inflate the score to be agreeable** — a wrong pass is worse than a
low score.

**Every brief must give the reviewer:** the exact refs with literal read
commands, plus a warning that the checked-out tree is NOT the artifact
(session 8: a reviewer read a stale tree and refuted three *true* claims);
an instruction to name the ref for every claim (C-8); the settled context
so it attacks rather than rediscovers; the author's verification claims
stated AS claims with an explicit invitation to refute them; a named attack
surface; permission to say "I could not verify that"; and
**"do not fix anything, report only"** — a reviewer that edits becomes an
author and the next round has no independent party.

**Why this is a hard rule.** Session 9 shipped two CI gates, both verified
against a real database in both directions and believed correct. Round 1
scored **84** and found nine defects, including a migration role that was
not the database owner — which made migration 011's `GRANT USAGE ON SCHEMA
public` execute as `WARNING: no privileges were granted`, swallowed by
psycopg, green chain, wrong ACL. A silent no-op inside the gate built to
catch silent no-ops. Round 2 scored **88** and found a **false green**: a
`--allow-unreachable` flag returning exit 0 for a database that answered
but whose ledger could not be read. Neither round found a typo. Both found
what the author could not see because he had decided what the code meant
before writing it.

Cost is roughly ten minutes of agent time per round.
