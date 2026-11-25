# Runbook: deploy rollback (web on Vercel, worker on Fly)

One page. Sources: `.github/workflows/deploy.yml`, `scripts/ci_green_gate.py`,
`apps/worker/fly.toml`, AGENTS.md (M-SA, "After each merge" and "Worker deploy"),
and Jon's standing approvals §A2 (`claude/handover-22/JON-STANDING-APPROVALS-2026-11-25.md`,
valid to 2026-12-19). This file documents; it grants nothing. Agents (subagents) never
deploy, roll back, dispatch workflows, merge, or post on #414.

**Who deploys today.** Jon, until A2 is recorded active (all five activation steps in the
approvals file). After that, a B-session orchestrator may dispatch `deploy.yml`; A sessions
never do. The fast path below is Jon's in every case.

## 1 · When to roll back

Run the post-deploy check after every dispatch (A2 (3)). The deploy **failed** if any of:

| Check | Pass means |
|---|---|
| Deploy jobs | `CI green gate`, `Deploy Web to Vercel` and/or `Deploy Worker to Fly.io` all `success` |
| Deployed SHA | the deploy run's `head_sha` equals the `v3/main` head you dispatched |
| Real job | a job created **after** the deploy reached `done` with `jobs/<id>/play.chords.json` in R2, within 30 min (A3 read-only SELECT) |

- Idle queue: no failure yet. The ledger row says "unverified until next real job" and the
  next watch must confirm it.
- `/health` is DB-free by design and is **not** the check (liveness only).
- A tester-facing outage (site down, uploads failing, jobs stuck) skips the wait: message Jon
  for the fast path at once, and start the slow path in parallel.

## 2 · Fast path (Jon only; minutes)

Agents never run these. They are written here so Jon can copy them.

**Web (Vercel).** Dashboard → project → Production Deployment tile → **Instant Rollback** →
pick the previous production deployment → **Confirm Rollback**. (Or Deployments tab, filter
`main`, ⋮ → Instant Rollback.) CLI equivalent: `vercel rollback <previous-deployment-url>`.
- After a rollback Vercel **turns off auto-assignment of production domains**: the next
  `vercel deploy --prod` from `deploy.yml` builds but does **not** go live. When the slow-path
  redeploy is green, Jon undoes the rollback: tile → **Manage** → promote that deployment
  (or `vercel promote <deployment-url>`). Until then, production stays on the rolled-back build.
- Env vars are not rolled back; a rollback restores the old build only.

**Worker (Fly, app `stem-loops`).** From `apps/worker/` (so the current `fly.toml` is used):

```bash
fly releases --app stem-loops --image          # find the last good release's image
fly deploy --app stem-loops --image registry.fly.io/stem-loops:deployment-<ID> --ha=false
fly status --app stem-loops && fly logs --app stem-loops   # one Machine, job claims resume
```

- Always `--ha=false`: the app must stay at one Machine (`fly.toml`, `deploy.yml`).
- The rollback reuses the **current** `fly.toml`, env and secrets, and reverses no migration.
- **Drain:** the restart sends `SIGTERM` and waits up to `kill_timeout = 300` s. The worker
  claims nothing new, lets the in-flight job finish within `WORKER_DRAIN_SECONDS` (270), else
  re-queues it. Allow up to 5 min before judging the rollback.

## 3 · Slow path (gated revert + redeploy; 60–75 min)

1. Stop merges (M-5). Open a pure `git revert <merge-sha>` PR (merges are squash, one parent)
   into `v3/main`, as a draft. A revert of a PR that carried an applied migration is held for
   Jon: code and schema must be reconciled by him.
2. Two non-author reviews confirm it is an exact revert (same bar as the original: protected
   and money PRs need the same reviewers and scores). Merge only through
   `scripts/or4-merge.sh` re-fetched from main (`DRY_RUN=1` first), with a #414 claim.
3. Wait until `v3/main` CI is **complete and green** on the revert's merge SHA (~25 min).
4. In a DEPLOY window (§4), dispatch from `v3/main` only:
   `gh workflow run deploy.yml --ref v3/main -f target=<worker|web|all>` (target = what the
   bad deploy touched). Then repeat the §1 check. If web was fast-pathed, Jon promotes (§2).

- **Never `gh run rerun` an old deploy run.** A re-run uses that run's commit and its
  workflow file: an old run deploys the old SHA, and a run from before #439 has no
  `CI green gate` job at all.
- **A red gate is not a failure to work around.** It means main CI is still running or red on
  that SHA: wait for green and dispatch again. No `make deploy-*`, no local `flyctl`/`vercel`,
  no other ref. A refused dispatch is OR-1: record it, tell Jon, do not re-route.

## 4 · Deploy windows and the #414 DEPLOY claim

- Windows 11:00 and 16:00 Vancouver. Post on #414: `DEPLOY <session> <sha7> until <YYYY-MM-DDTHH:MMZ>`.
  No merges by either session until `RELEASE`. Then: main CI complete on the head → dispatch.
- One deploy in flight. Never with a pending migration (A3 SELECT of applied vs repo list).
- Freeze: `apps/**` after Fri 11-27 16:00 (blockers only); no deploys Sun 11-29 18:00 →
  Wed 12-02 18:00 except a tester-blocking fix, Jon told first. A rollback is such a fix.
- Only orchestrators post on #414; an expired unreleased claim is void.

## 5 · Who to tell, what to ledger

- **Jon, at once**, for any failed §1 check or tester-facing outage: what broke, SHA, fast
  path needed (web / worker / both), slow-path PR number. Not a question; he acts.
- **The other session** via the #414 `RELEASE` line (`RELEASE <session> deploy <sha7> rolled back`).
- **Ledger row** (session LEDGER): time (UTC), deploy run URL, dispatched SHA vs `head_sha`,
  target, §1 result (or "unverified until next real job"), A3 query + purpose, fast-path action
  by Jon (Vercel deployment / Fly image), revert PR + merge SHA, redeploy run URL, final check,
  and whether Vercel auto-assignment was restored (promote done).
