# Adversarial-Audit Verdict — Level 1 / Level 2 merge autonomy

**Artifact of record.** Preserved verbatim in substance as the audit input that
closed the Level-1/Level-2 implementation, per the auditor's §3.7 and Appendix.

**From:** the adversarial auditor(s) who produced findings F1–F9 and the
Level 1 / 2 / 3 recommendations
**To:** the Claude Code agent implementing them
**Date:** 2026-11-05 (PT)
**Verdict:** **PASS** with 2 residual action items + a mandatory documentation update

---

## Stamp

```
AUDIT-STATUS: ADVERSARIAL-AUDIT-PASS 2026-11-05
AUDIT-SCOPE: Levels 1 and 2 (approved); Level 3 deferred to 72h retro
RESIDUAL-ITEMS: 2 (AGENTS.md HTML comment deletion; Web build ruleset add)
DOCUMENTATION-UPDATE: this PR
AUDITOR-ARTIFACT: claude/audits/2026-11-05-level2-validation.md
```

---

## 1. What the auditor validated

- All Level 1 fixes landed (L1.1 and L1.4 by Jon, L1.3 by the agent). L1.2 partly deferred.
- All Level 2 code landed (L2.1 + L2.4 in PR #130, L2.2 merged as #117, L2.3 in PR #131).
- **§5.1 "L2.4's second half was a no-op" — ruled TRUE.** A `completed` + `neutral`
  check-run already passes `safe_merge.sh`'s filters. Not a false-premise skip.
- **§5.2 precondition ordering — ruled plausible, verification requested.** Now
  verified and recorded below.
- **§4.1 `Web build` job — ruled a legitimate precondition, not scope padding.**
  CI genuinely did not run `next build`; Vercel reports as a status not a
  check-run; `safe_merge.sh` reads check-runs only.
- **§4.2 adding `AGENTS.md` to the fast-path deny list — ruled legitimate
  defence in depth.** Confirmed from the pre-change `allow_re` that `AGENTS.md`
  matched `.+\.md$` and was protected only by the label race.
- **§6.2 F9 deferral — ruled correct discipline.**
- No falsified claims found.

## 2. Residual items

| # | Item | State |
|---|---|---|
| **2.1** | Delete the false M-7 HTML comment in `AGENTS.md` | ✅ **DONE** in this PR |
| **2.2** | Jon adds `Web build` to `v3/main` required contexts | 📌 **Issue #132**, assigned to Jon |

## 3. Documentation update

Specified across `AGENTS.md`, `.github/CODEOWNERS`, `auto-merge.yml`,
`auto-label-fast-path.yml`, `scripts/safe_merge.sh`, `.claude/settings.json`,
the handover doc, and a `claude/retrospectives/` README. Delivered — see the
handover doc for the file-by-file mapping, including which items landed on the
pre-existing open PRs to avoid conflicting with them.

## 4. Carried forward to the 72h Level-3 decision

1. Did `Web build` get added to the required contexts? If not, Level-2 widening
   is running without its safety net — **HOLD**.
2. Did the first App-token merge succeed? The `::notice::` line is the proof.
   Still unverified at 72h — **HOLD**.
3. **F9 ruling** — was the wrapper-script subprocess question tested, and what
   did it show? Gates whether L3's `.claude/settings.json` cleanup is a doc fix
   or an architectural issue.
4. PR #126 render check — merged without browser verification. Surface any user
   reports or Sentry errors.
5. Count of unexpected `safe_merge.sh` invocations. Any use on
   non-billing / non-workflow PRs means the flow is leaking back to manual.

---

## 5. Corrections to the validation document itself

Recorded because the next agent will read the auditor's text and should not
inherit three inaccuracies. None of these change the verdict.

**(a) §2.1 located the false comment at "Line 1 of `AGENTS.md`". It was at
line 140**, immediately above the `## §11` heading — introduced by PR #43
("docs: M-7 landing note"). The substance was correct: the claim was false and
contradicted §11 M-7's own closing paragraph (*"Until the service account is
created, the current workaround stands"*) in the same file. Deleted.

**(b) §2.2 states the exposure window is already open because "L2.3 PR is open
or merged". It was not open at filing.** An open PR widens nothing. Verified
on `v3/main` at the time: neither the widened `allow_re` nor the `Web build`
job was present. **The window opens when #131 merges and closes when issue
#132's command runs** — so the mitigation is to run that command immediately
after the merge, keeping the gap to minutes. Stated this way in #132 so nobody
believes an exposure exists that does not, or misses the one that will.

**(c) §3.6 asks to "add a comment" to `.claude/settings.json`. JSON has no
comment syntax** — a `//` line would make the file unparseable and silently
disable every guardrail in it. The F9 note was instead appended to the file's
**existing `"comment"` string key**, and the file was re-parsed to prove it
still validates.

## 6. §5.2 ordering — now verified, as requested

The auditor asked for this to be run once and recorded:

```
#117 merged        2026-11-05T23:09:31Z   = 16:09:31 PT
L1.4 ruleset applied  2026-11-05T16:18:15-07:00
L2.3 commit authored  2026-11-05T16:26:00-07:00
```

**Both preconditions preceded the widening commit** — by 16.5 minutes and
8 minutes respectively. Precondition verification happened before the change,
not after.

## 7. Auditor's closing note

> Your verification brief was written with unusual self-awareness — §5
> explicitly invited scrutiny of two claims that worked in your favor, and both
> held up. This is good faith under a real conflict of interest, and it made
> this audit significantly faster. Carry this discipline forward: **every future
> handover document should have its own "check these hardest" section.**

Adopted as a convention. See the handover doc's own such section.
