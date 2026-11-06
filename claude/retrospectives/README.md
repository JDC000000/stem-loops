# Merge-autonomy retrospectives

Cadence created 2026-11-05 as part of the Level-1 / Level-2 merge-autonomy
rollout. Three one-shot scheduled tasks, each starting a **fresh session with
no memory of the original work**, which is why each is told to read the
handover doc and verify current state before measuring anything.

| Retro | Fires | Scheduled task ID | Output |
|---|---|---|---|
| **R-24h** sanity check | 2026-11-06 ~15:43 PT | `trig_016TXqAai4XzLFGhF8ARRZgi` | `level-2-24h.md` |
| **R-48h** + time-saved estimate | 2026-11-07 ~15:47 PT | `trig_01NyUPKiXX8eheZcdVzuoVSH` | `level-2-48h.md` |
| **R-72h** Level-3 **GO / HOLD** | 2026-11-08 ~15:51 PT | `trig_017AKZq6MEVFDioEbEwpHM1g` | `level-2-72h.md` |

## What each retro reports

All three, via the GitHub **REST** API (GraphQL is unavailable in-session —
`gh pr view --json` and `gh pr checks` return 403; use `gh api repos/{o}/{r}/...`):

1. PRs merged in the window and **who merged each** — `JDC0000` (bot) vs
   `JDC000000` (Jon). This is the headline number; the whole exercise was to
   move merges off Jon's terminal.
2. `needs-jon-approval` vs auto-merged via `fast-path` or
   `rollback-safe` + `adversarial-reviewed`.
3. Failed runs of `auto-merge.yml` / `auto-label-fast-path.yml`.
4. PRs in unexpected states — green and unblocked but still open, or
   closed-but-unmerged.
5. Uses of `scripts/safe_merge.sh`. Ideally now only billing, workflow and
   commercial-migration PRs. **Anything else is a sign the Level-2 flow is
   leaking back to manual.**
6. Whether `v3/main` ruleset `26478884` still carries `required_status_checks`
   — and, from 2026-11-05, whether `Web build` is among them (issue #132).

48h adds a time-saved estimate, stated as an estimate on a counterfactual,
not as measurement. 72h adds the Level-3 decision.

## The 72h decision gate

**Level 3** would be: a further CODEOWNERS trim, removing the
`needs-jon-approval` auto-label for non-money paths, and cleaning up
`.claude/settings.json`.

Level 3 loosens controls on paths **closer to money** than Level 2 did, so
the burden of proof is higher, not the same.

**GO requires affirmative evidence:**

- a real volume of auto-merges — not a quiet window
- zero reverts of auto-merged PRs
- zero red-line breaches (`apps/*/billing/**`, `apps/*/api/billing/**`,
  `apps/worker/migrations/*_v3_commercial*.sql`, `.github/workflows/**`,
  `AGENTS.md`)
- no defect traced to the fast path
- `Web build` present in the required contexts (issue #132)
- the first App-token merge confirmed by its `::notice::` line

**A quiet window is not evidence of success.** If few PRs merged, the honest
answer is *"insufficient data — HOLD another week"*. The 72h task says so
explicitly. A HOLD must state exactly what evidence would change it, so the
next review has a bar to clear.

## Anchoring caveat — read before interpreting the 24h numbers

The three tasks are anchored to **their creation time**, not to the merge of
the final Level-2 PR, because that PR had not merged when they were created.

**So the 24h window may contain almost no post-change data.** That is a
reporting artifact, not a result. Each task is instructed to verify what
actually landed before measuring, and to say "insufficient data" rather than
infer success from quiet.

## Related

- `claude/merge-autonomy-level-2-handover.md` — what landed, what was deferred
- `claude/merge-permissions-audit-brief.md` — the original audit brief
- `claude/merge-autonomy-VERIFICATION-BRIEF.md` — the agent's self-report
- `claude/audits/2026-11-05-level2-validation.md` — the auditor's verdict
- `AGENTS.md` §11 M-8 — what Anthropic's controls block, so nobody retries
