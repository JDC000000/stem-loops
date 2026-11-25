# Runbook: deploy rollback (web on Vercel, worker on Fly)

One page. Repo sources: `.github/workflows/deploy.yml`, `scripts/ci_green_gate.py`,
`apps/worker/fly.toml`, AGENTS.md (M-SA "After each merge" and "Worker deploy"). Rules
source: Jon's standing approvals v1.2 (A2, A2b, G-1), no end date, until Jon revokes. That
file is a Project doc (`claude/handover-22/JON-STANDING-APPROVALS-2026-11-25.md`), not in
this repo. This runbook documents; it grants nothing. Subagents never deploy, roll back,
promote, dispatch workflows, merge, or post on #414.

**Who may do what.**
- **Real deploys:** Jon, until A2 is recorded active (all five activation steps in the
  approvals file). After that, a B-session orchestrator may dispatch `deploy.yml` (A2).
- **A sessions never run a real deploy.** 22A's only dispatch is G-1: `deploy.yml` with
  `gate_only=true` (gate job only; deploy jobs do not run). `gate_only` exists only once the
  guard-hardening PR #445 is merged; it is not on `v3/main` yet.
- **Fast path:** Jon's, with one exception (A2b(b), §2).

**AGENTS.md divergence (known).** AGENTS.md "Worker deploy" (D-7) still says: dispatch
`target=worker` only, then check `/health` and the fetch canary within 10 min. A2 is the
later, narrower text: the check is the job-based check in §1, and `/health` is not it. Until
AGENTS.md is aligned (that fix is #444's), follow A2 and this runbook; where the two differ,
do the stricter of them (e.g. also probe `/health`; it can only add a failure).

## 1 · When to roll back

Run the post-deploy check after every dispatch (A2 (3)). The deploy **failed** if any of:

| Check | Pass means |
|---|---|
| Deploy jobs | `CI green gate (deployed SHA on v3/main)` and each `Deploy Web to Vercel` / `Deploy Worker to Fly.io` that ran: `success` |
| Deployed SHA | the deploy run's `head_sha` equals the `v3/main` head you dispatched |
| Real job | a job created **after** the deploy reached `done` with `jobs/<id>/play.chords.json` in R2, within 30 min (A3 read-only SELECT) |
| Web live (if web deployed) | the production domain serves the deployment this run created (Vercel dashboard: it is **Current**, not Staged) |

- Idle queue: not a failure. While A2 is active, A2b(a) allows one fixed public demo song
  as a smoke job (≤ 2/day, recorded in the ledger). Otherwise the ledger row says
  "unverified until next real job" and the next watch must confirm it.
- `/health` is DB-free by design and is **not** the check (liveness only).
- Tester-facing outage (site down, uploads failing, jobs stuck): message Jon for the fast
  path at once, and start the slow path in parallel.

## 2 · Fast path (minutes)

**Web (Vercel).** Dashboard → project → Production Deployment tile → **Instant Rollback** →
pick the previous production deployment → **Confirm Rollback** (or Deployments tab, filter
the production branch `v3/main`, ⋮ → Instant Rollback). CLI: `vercel rollback <url>`. [V1]
- **Who:** Jon. **A2b(b):** while A2 is active, a session may promote **only the immediately
  previous** Vercel production deployment on a failed §1 check, then message Jon at once.
  Fly rollback, every other Vercel setting, and secrets stay Jon's.
- **Env values:** a rollback reassigns domains to the existing build without a rebuild, so it
  runs with the env values **it was built with**; env changes made since do not apply to
  it. [V1, V2] If a secret or env value was rotated between the two deployments, do not
  instant-rollback: tell Jon and use the slow path.
- **After a rollback, auto-assignment of production domains is off:** the next
  `vercel deploy --prod` from `deploy.yml` is created but not served. [V1] When the slow-path
  redeploy is green, Jon (or A2b(b) while A2 is active) undoes it: tile → **Manage** → promote
  that deployment, or `vercel promote <url>`; this restores auto-assignment. [V1]
- Hobby plans can roll back only to the immediately previous deployment; Pro to any
  deployment that served production. [V1] Rollbacks/promotions run one at a time per project.

**Worker (Fly, app `stem-loops`). Jon only.** From `apps/worker/` (current `fly.toml`): [F1, F2, F3]

```bash
fly releases --app stem-loops --image          # image ref of each release; pick the last good one
fly deploy --app stem-loops --image registry.fly.io/stem-loops:deployment-<ID> --ha=false
fly status --app stem-loops && fly logs --app stem-loops   # one Machine; job claims resume
```

- Always `--ha=false`: `--ha` defaults to true and creates spare Machines [F3]; this app must
  stay at one Machine (`fly.toml`, `deploy.yml`).
- The rollback reuses the **current** `fly.toml`, env and secrets, and reverses no DB
  migration. [F1]
- **Drain:** the restart sends `SIGTERM` and waits up to `kill_timeout = 300` s. The worker
  claims nothing new, lets the in-flight job finish within `WORKER_DRAIN_SECONDS` (270), else
  re-queues it. Allow up to 5 min before judging the rollback.

## 3 · Slow path (gated revert + redeploy; 60–75 min)

1. Stop merges (M-5). Open a pure `git revert <merge-sha>` PR (merges are squash, one
   parent) into `v3/main`, as a draft. A revert of a PR that carried an applied migration is
   held for Jon: code and schema must be reconciled by him.
2. Two non-author reviews confirm it is an exact revert (same bar as the original: protected
   and money PRs need the same reviewers and scores). Merge only through
   `scripts/or4-merge.sh` re-fetched from main (`DRY_RUN=1` first), with a #414 claim (A1).
3. Wait until `v3/main` CI is **complete and green** on the revert's merge SHA (~25 min).
4. In a DEPLOY window (§4), the deployer (Jon, or a B session under A2) dispatches a **new**
   run from `v3/main`: `gh workflow run deploy.yml --ref v3/main -f target=<worker|web|all>`
   (target = what the bad deploy touched). Repeat the §1 check. If web was rolled back, promote
   the new deployment (§2) or it is never served.

- **Never `gh run rerun` any deploy run**, including the one that just failed, and never
  "re-run failed jobs" on one. A re-run uses that run's commit and workflow file (an old SHA;
  a run from before #439 has no gate job at all). A1's CI re-run does not cover `deploy.yml`.
- **A red gate is not a failure to work around.** Main CI is still running or red on that
  SHA: wait for green and dispatch again. No `make deploy-*`, no local `flyctl`/`vercel`, no
  other ref. A refused dispatch is OR-1: record it, tell Jon, do not re-route.

## 4 · Deploy windows and the #414 DEPLOY claim

- Windows 11:00 and 16:00 Vancouver. Post on #414: `DEPLOY <session> <sha7> until <YYYY-MM-DDTHH:MMZ>`.
  No merges by either session until its `RELEASE`. Then: main CI complete on the head → dispatch.
- One deploy in flight. Never with a pending migration (A3 SELECT of applied vs repo list).
- Freeze: `apps/**` after Fri 11-27 16:00 (blockers only); no deploys Sun 11-29 18:00 →
  Wed 12-02 18:00 except a tester-blocking fix, Jon told first.
- Only orchestrators post on #414; an expired unreleased claim is void.

## 5 · Who to tell, what to ledger

- **Jon, at once**, for any failed §1 check, tester-facing outage, or A2b(b) promote: what
  broke, SHA, fast path needed or done (web / worker), slow-path PR number. Information, not a
  question.
- **The other session** via #414: release the DEPLOY claim. Proposed shape (not yet in the
  #414 protocol): `RELEASE <session> deploy <sha7> rolled back`.
- **Ledger row** (session LEDGER): time (UTC), deploy run URL, dispatched SHA vs `head_sha`,
  target, §1 result (or "unverified until next real job"), A3 query + purpose, fast-path
  action and who (Vercel deployment / Fly image), revert PR + merge SHA, redeploy run URL,
  final check, and whether Vercel auto-assignment was restored (promote done).

## Sources (read 2026-11-25)
- [V1] Vercel, Instant Rollback: https://vercel.com/docs/instant-rollback
- [V2] Vercel, Promoting Deployments: https://vercel.com/docs/deployments/promoting-a-deployment
- [F1] Fly, Rollback guide: https://docs.fly.io/blueprints/rollback-guide
- [F2] Fly, `fly releases`: https://docs.fly.io/flyctl/cmd/fly_releases.md
- [F3] Fly, `fly deploy`: https://docs.fly.io/flyctl/cmd/fly_deploy.md
