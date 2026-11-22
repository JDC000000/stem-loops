# TSD-V3-DELTA: Stem-Loops V3 (commercial layer + Play engine + Spotify + fetch) — delta over the pinned TSD

Author: SL-V3 architect lane. **Version: v2.2. Date: 2026-11-22** (UTC; session-17 close, 2026-11-21 Pacific. Phase A **shipped and play-tested**: #330, #332, #331, #333 merged, live, and Jon's 3-song phone play-test PASSED; user stories **v4.0.2** (Jon's Q-D, Q-E and Q-F; chord fixing deferred); Phase B decisions PB-1…PB-4, Q-A…Q-E and the B0–B3 plan with B4 removed; M2 status (step 4 as two PRs, the G0 job, pack v1.4.12 → v1.4.13, G5 met); see the v2.1 → v2.2 Changelog and §12.16). Previous: 2026-11-21 (**v2.1**, merged in #329 `65f9fc6`: product-evolution amendment: the product is now a **phone-first play-along**, with Download loops a secondary product; Slice 0 / 1 / 2a outcomes, billing and ops work shipped 2026-11-18 → 11-21, migration 042, Jon's 2026-11-21 design decisions DR-D2…DR-D6 and the deferral of DR-D1 (chords after 2026-12-05); Jon's later 2026-11-21 answers (user stories v4.0 approved and replacing v3.1; set lists for Free + Pro); superseded requirements are marked, not deleted; see the v2.0.1 → v2.1 Changelog and §12.15). Previous: 2026-11-18 (**v2.0.1** fix-forward: the post-merge review of v2.0 (#291) scored it 86/100; its operational state was stale at merge, the demo-key item was wrong, and several IDs collided; see the v2.0 → v2.0.1 Changelog). Previous: 2026-11-17 (**v2.0** amendment: Jon's 2026-11-17 design decisions — DB-12(a) demo songs play signed out, DB-16 rights recorded, DB-17 still OPEN — and Slice 0 / Slice 1a / pricing as shipped in #289, #288, #287; deploy facts corrected; see the v1.10 → v2.0 Changelog). Previous: 2026-11-16 (v1.10 amendment: §1.2a link-ingest separation **REVERSED by Jon** — Pro and Studio may paste YouTube links, metered like uploads and kept in their library; O-8 closed; see the v1.9 → v1.10 Changelog). Previous: 2026-11-14 (v1.9 amendment: V3-J4 revised — a song over 5 minutes is TRIMMED to its first 5 minutes, not refused; see the v1.8 → v1.9 Changelog and §12.5). Previous: 2026-11-11 (v1.8 amendment pass — the plan catalog re-priced on tracks-converted-to-play-along, and every plan flag that advertised an unbuilt capability cleared; see Changelog below). Previous: 2026-11-10 (v1.7 amendment pass — corrections to v1.5/v1.6 after an adversarial review scored them 48/100, plus Jon's .wav and 3-free-stems decisions). Status: **living record, v2.2** (v2.2 is opened as a **draft PR**; it takes effect only when it merges; v2.1 is the merged version until then) — every amendment row that states a fact cites its source (Jon's words, a merged PR, or a measurement). This file was marked "DRAFT for Jon's review" from v1.0 to v1.10; that line was stale, because v1.8, v1.9 and v1.10 were each merged to `v3/main` (#210, #270, #282) and this file is the canonical PRD+TSD delta in the repo. Each amendment takes effect when it merges.
This document EXTENDS the pinned TSD at `stem-loops-handoff/07-roadmap/TSD.md` (SL21-tsd, commit c3f6a911 of `stem-loops`). It is a DELTA only — anything the pinned TSD covers (job state machine, kill switches, blocklist, fetch chain, loops/export, R2 layout, migrations 001–012) is NOT restated here, only cross-referenced by section number (e.g. `TSD §3.1`). All new requirement IDs are prefixed **V3-**; new tests prefixed **T-V3-**. Pinned reqs use their existing IDs (R-A0, R-X2, etc.).

---

## Changelog — v2.1 → v2.2 (2026-11-22 UTC — Phase A shipped and play-tested; user stories v4.0.2; Phase B decisions; M2 status)

Sources: as for v2.1 below ([PR #n `sha`], [L17 hh:mm:ssZ], [GH]), plus:
- **[US 4.0.2] / [US 4.0.3]** user stories v4.0.2 (2026-11-21) and v4.0.3 (2026-11-22, status update), Claude Project / session workspace, not this repo.
- **[PB r4.2]** the Phase B builder brief r4.2 (2026-11-21, `design-review/PHASE-B-BRIEF.md` in the session workspace), §0, §5, §7.
- **[Rnnn]** an independent review file `reviews/PRnnn-REVIEW*.md` in the session workspace (head SHA and score in its header).
- **[A-2]** the independent A-2 scorecard for session 17, `reviews/A2-SCORECARD-S17-2026-11-21.md`.
- **[M2 ws]** the M2 prep workspace (`m2-prep/`), read 2026-11-22 ~04:57Z: `SHA256SUMS`, `legcheck_v1412_fdf4aae.out`, `git log` of the local PR-4a/4b worktrees. Local only; nothing pushed.
- Merge times are the GitHub `merged_at` values (REST, read 2026-11-22 ~04:58Z), not ledger write times (the A-2 card found ledger merge stamps lag `merged_at`).

| § | Change | Source |
|---|---|---|
| §0 Header | v2.1 → **v2.2**; date 2026-11-22 (UTC). v2.1 recorded as merged (#329 `65f9fc6`, 2026-11-21 16:59:11Z) | [PR #329 `65f9fc6`] |
| **§12.16 (NEW)** | **Phase A as shipped** (what each PR does, its review rounds and scores, merge SHAs, live check, play-test PASS); **user stories v4.0.2**; **Phase B decisions** PB-1…PB-4, Q-A…Q-E, Q-F and the B0–B3 plan with B4 removed; **M2 status** (step 4 = two PRs, the G0 job, pack v1.4.12, G5 met, step 6 date) | [PR], [L17], [US 4.0.2], [PB r4.2], [Rnnn], [A-2], [M2 ws] |
| §12.1 | ⟲ v2.2 banner: the Phase A play-test gate **PASSED** 2026-11-22 04:48:47Z | [L17 04:48:47Z 11-22] |
| §12.15.6 | Phase A marked **SHIPPED**; the Phase B bullet points at §12.16.2 (B4 removed, B5 → Phase C). v2.1 text kept as the record | [PR #330–#333], [PB r4.2] |
| §9 | V3-PS1…PS6 marked **shipped** with what actually shipped (PS1: Simple hides chords under **2 beats**, 1 s with no beat grid, not the 1-beat merge; PS2: Now ≥ 72 px on every phone, Next 44/32 px, neutral countdown; PS5: section tokens, 1-row strip while pills show; PS6: sign-in before a link job, build-time chords switch); V3-J1 play-test; V3-LB1 Re-make **uses a monthly song** (PB-2); V3-LB2 **Free, Pro and Studio** + the demo-account guard (Q-C); V3-LB3 **links only** (Q-F) and charge-neutral (PB-3); **new V3-LB5** (deferred: saved chord corrections, Q-E) | [PR], [L17], [PB r4.2], [US 4.0.2] |
| §11 | v2.1 rows for Phase A and the AGENTS.md exception marked done; **NEW "Open after 2026-11-22 (v2.2)"** table (M2 Sunday, Phase B build, Q-B worker PR, Phase A follow-ups QA-85…QA-90, DR-D1 brief 2026-11-28, open issues; #143 closed) | [L17], [GH] |
| **Precedence** | **User stories v4.0.3** (= v4.0.2 + status update and Jon's 2-beat floor, 2026-11-22) are the current approved stories (v4.0 approved as written 15:43:55Z; v4.0.1 wording approved 18:13:06Z; v4.0.2's 5.5 wording = Jon's Q-F, 21:35:02Z). They replace v3.1 | [L17 15:43:55Z, 18:13:06Z, 21:35:02Z 11-21] |
| **Stories v4.0.3** | v4.0.3 (2026-11-22) is v4.0.2 with the status column updated after Phase A and the play-test, and AC 1.2 / 3.1 recording Jon's 2-beat Simple floor (~22–25 changes/min, [L17 21:35:02Z]); no other criterion changed | [US 4.0.3] |
| **Audit fixes (r2, 2026-11-22)** | Independent docs audit (`reviews/HANDOVER-18-DOCS-AUDIT.md`, TSD 86 FAIL): stale v2.1 Phase A text at §12.12 marked superseded; DR-D3 marked amended by PB-2; v2.1 open-items rows for Phase B, M2, set lists (Studio = orchestrator reading) and #143 marked; the degrade order corrected in §12.16.1 and V3-PS2 (Next shrinks to 32 px **before** the NEXT line drops, R333-R3 §2) | audit B1-1…B1-4 |
| **Chord fixing** | **Removed from the workflow for now** (Jon, Q-E, 18:11:52Z): the dead editor is hidden by #333; user stories 1.4 / 3.5 correction clauses DEFERRED; #135 and saved corrections to the backlog; `/privacy` and `/terms` keep the disclosure of past saved `chord_edits` | [L17 18:11:52Z, 18:13:06Z 11-21]; [PR #333 `fdf4aae`] |

Items intentionally UNCHANGED in v2.2: prices and quotas; the 24-hour Free retention rule (PB-1 keeps Free **metadata** past 24 h, which is Phase B and not built); §1–§8; DR-D1 (still deferred; brief 2026-11-28; Klangio subscription ends 2026-12-05). **AGENTS.md is not edited by this PR.**

---

## Changelog — v2.0.1 → v2.1 (2026-11-21 — the product as it is now: phone-first play-along; 2026-11-18 → 11-21 shipped; Jon's 2026-11-21 decisions)

Sources, each fact cited to one of them:
- **[PR #n `sha`]** a merged pull request and its squash commit on `v3/main`, read from the GitHub REST API on 2026-11-21 (`pulls?state=closed`, `merge_commit_sha`).
- **[L17 hh:mmZ]** the session-17 orchestrator ledger (`LEDGER-17.md`, 2026-11-17 → 11-21, UTC rows). It lives in the Claude Project (`claude/handover-17/`), not in this repo.
- **[DR]** the 2026-11-20/21 design review against Jon's play-along story: reviews A (live phone), B (code and flows) and C (user stories), and the synthesis doc. Session workspace and Claude Project, not this repo.
- **[Jon 11-21]** Jon's decisions of 2026-11-21, recorded at LEDGER-17 13:58Z (Jon's message is stamped 06:57 on the box clock). **[Jon 11-21b]** Jon's modal answers recorded at LEDGER-17 **15:43:55Z** on 2026-11-21: set lists for Free + Pro; user stories v4.0 approved; a one-time AGENTS.md exception.
- **Times.** Clock times quoted from Jon's messages ("06:57", "21:21", "14:03") are the box clock that the sources label PT; LEDGER-17 says the box is MST (UTC-7), so they may be an hour off Pacific. UTC from the ledger is given wherever it exists. **[MJC]** Jon's decisions in the MissionJC chat of 2026-11-20 (LEDGER-17 00:53Z, 2026-11-21).
- **[GH]** GitHub Actions and Deployments APIs, read 2026-11-21 ~14:00Z.

**Decision-label collision, resolved here.** Two decision sets both use "D1…": the MissionJC chat of 2026-11-20 (**MJC-D1…MJC-D9**) and the design review of 2026-11-21 (**DR-D1…DR-D6**). This document always prefixes them. The design proposal's **DB-12…DB-17** keep their names.

| § | Change | Source |
|---|---|---|
| §0 Header | v2.0.1 → **v2.1**; date 2026-11-21. Honesty note: the header has said *"living record"* since v2.0 (the *"Status: DRAFT"* line was replaced in v2.0, #291); what was stale was the version, the date and the product description in §12. No *"Date: 2026-11-11"* line remains in this file except as a dated changelog entry | this amendment |
| **§12.15 (NEW)** | **Product evolution 2026-11-17 → 2026-11-21**: phone-first play-along, loops secondary; Slice 0/1/2a outcomes; billing and money safety shipped; demo songs public; allowance restore (042); first-byte stall cut (#327); Klangio poll deadline 120 s (#317); DR-D2…DR-D6 and the DR-D1 deferral; MJC-D1…D9; Phase A in progress | [PR], [L17], [DR], [Jon 11-21], [MJC] |
| §12.1 | ⟲ v2.1 banner: the journey is now Jon's 2026-11-20 phone story (user stories **v4.0, approved 2026-11-21**, Story 1). The owner pass bar is the **Phase A play-test gate**: Jon plays 3 songs on his phone when Phase A is live | [Jon 11-21] (gate), [DR] synthesis ("3 songs"), [Jon 11-21b] |
| §12.6 | ⟲ v2.1 banner: **V3-J7 MET 2026-11-17** (3/3 links `done`); the 2026-11-18/19 proxy outage (QA-61) and its fixes (#307, #313, #327) | [L17 17:37Z], [L17 03:57Z–05:18Z 11-19] |
| §12.7 | **V3-J5 SUPERSEDED** (desktop-Chrome launch scope): phones are the reference device. Text kept as the record | design v1.5 [DP]; #278, #288 |
| §12.8 | ⟲ v2.1 banner: DB-17 / O-3 is now **DR-D1, DEFERRED by Jon until after the Phase A design fixes**; decision brief scheduled 2026-11-28; the Klangio subscription still ends 2026-12-05. MJC-D1 and MJC-D9 recorded | [Jon 11-21], [MJC] |
| §12.9 | ⟲ v2.1 banner: the signed-out demo read path is **built** (#302) and verified live | [PR #302 `3a69c2c`], [L17 13:21Z 11-18] |
| §12.11 | ⟲ v2.1 banner: demos shared since #302; key-detection root cause fixed in #295 | [PR #302], [PR #295 `f7f3350`] |
| §12.12 | ⟲ v2.1 banner: what changed since #288 (chart notation #294, chip sizes #312/#324/#326, tap-with-loop-off #303, clock #296), and which Slice 1a behaviours Phase A will supersede on merge (DR-D4, DR-D5, DR-D6, DR-D2) | [PR], [Jon 11-21] |
| §9 | Requirement table: V3-J1, V3-J2, V3-J5, V3-J7, V3-J8 annotated (V3-J5 **superseded**, V3-J7 **met**); **new IDs** V3-PS1…PS6, V3-LB1…LB4, V3-CH1, V3-OP1…OP3 | this amendment |
| §11 | "Open after 2026-11-17" rows marked with their outcome; **NEW "Open after 2026-11-21 (v2.1)"** table | [PR], [L17], [Jon 11-21] |
| **Precedence** | **User stories v4.0 (2026-11-21) are APPROVED and replace v3.1** as the product requirements this delta implements. v3.1 is kept in the Claude Project as history | [Jon 11-21b] |
| **Set lists** | **Free AND Pro** (Jon, modal answer, 2026-11-21). **Supersedes DB-15 (a)'s "playlists Pro-only"**; resolves the conflict with MJC-D8 | [Jon 11-21b] |

Items intentionally UNCHANGED in v2.1: plan prices and quotas (DB-15 (a), price half; its playlists-Pro-only half is superseded above); the 24-hour rule for Free jobs (DR-D3 changes what the **library shows** after expiry, not retention, and is Phase B, not built); the paid retention rule (#279); §1–§8 except where a banner says otherwise. **AGENTS.md is not edited by this PR.** Jon granted a one-time exception for a **separate** PR that changes only AGENTS.md's product-description sections, with Jon reviewing the diff before merge [Jon 11-21b].

---

## Changelog — v2.0 → v2.0.1 (2026-11-18 — post-merge review fixes)

Source: the post-merge adversarial review of #291 (v2.0), **86/100, FAIL**. Its MUST-FIX (MF), SHOULD-FIX (SF) and minor items are applied here. Where the orchestrator verified newer facts against the prod DB, those supersede the review's text.

| ID | § | Change | Source |
|---|---|---|---|
| **MF-1** | §12.11 Deploy status, v2.0 Changelog, §11 | The v2.0 **[U]** bullets were stale at merge. Replaced: demos processed and flagged at 2026-11-18 04:47Z (jobs `9c5ba587` Lucky Ticket, `32f99278` I'm Asking You, `3d43d743` Offline), retained until 2099-12-31; staging fully caught up to 040 (38 `_migrations` rows, verified 05:08Z); 004 and 026 noted as not re-run-safe; R2 has no lifecycle rules (Jon). §11's "operator steps outstanding" line replaced | LEDGER-17; orchestrator prod/staging checks; Jon (Cloudflare) |
| **MF-2** | §12.11, §12.12, §11 | The key item was wrong in scope (all three demo keys were wrong, not one) and named a "key override" that does not exist. Now: pipeline wrote G minor / B minor / C♯ major; Jon approved (*"approve demo keys"*, 21:56 PT) and a **named `UPDATE`** set A major / A minor / G major (verified). §12.12: key display shipped but the detected key is currently unreliable; key-detection investigation in §11 | Jon 2026-11-17 21:56 PT; orchestrator prod check |
| **SF-1** | throughout | Brand book addendum citations renamed **[BB2.3-A1]…[BB2.3-A4]** so they cannot collide with brand book v2.2 rule numbers A1–A16 used in code | review |
| **SF-2** | §11 | Duplicate "O-3 (v2.0)" row removed; the original O-3 row annotated; the decaying "18 days" dropped | review |
| **SF-3** | §2.2, §12.1, §12.2 | ⟲ pointers to §12.9 v2.0 where text still described an anonymous launch | review |
| **SF-4** | §12.9, §12.11 | Slice 2 behaviour put in the future tense: the demos **will be** shared and **will be** denied download/loop cutting by `is_demo`; today they are owner-only | review |
| **SF-5** | §12.11, §11 | Static export of the demos ([DP] Slice 0 step 2): **not done**, listed as outstanding | review; orchestrator |
| **SF-6** | §12.11, v2.0 Changelog, `docs/legal/demo-songs-rights.md` | DB-16 quoted verbatim, *"NOT NEEDED. I MADE ALL THE MUSIC WE HAVE RIGHTS"* (2026-11-17 18:23 PT); the "holds all rights" paraphrase removed in both files | Jon 2026-11-17 18:23 PT |
| SF-7 | §12.14 | "rollback is promote-previous-deployment" attributed to §8.2 (and O-4) | review |
| SF-8 | §12.11 table | "Deleted in …" is **not** hidden on `/loops` (#289 residue 2) | [#289] |
| SF-9 | §12.14 | Vercel production-branch claim marked "Observed" (Deployments API, not Vercel settings) | review |
| SF-10 | §0 Header | "every amendment row **that states a fact** cites its source" | review |
| SF-11 | §12.12 | Short landscape two-column layout needs height < 500 **and** width ≥ 560 | [#288] |
| SF-12 | §12.12 | P1 approved via the mockups (16:55 PT) and the work plan (19:05 PT) | [DP] |
| — | §12.11, §12.14 | Worker redeploy cited by Actions run **44236315618** (success 04:18Z) | [GH] |

---

## Changelog — v1.10 → v2.0 (2026-11-17 — Jon's design decisions; Slice 0, Slice 1a and pricing as shipped)

Sources, each fact cited to one of them:
- **[DP]** `DESIGN-PROPOSAL v1.5` (play-along first), last section *"v1.5 — Jon's decisions and what shipped (2026-11-17)"*: **APPROVED by Jon** (P2–P7 at 15:39 PT; mockups at 16:55 PT; pill chips and the whole work plan at 19:05 PT). The proposal lives in the Claude Project, not this repo.
- **[BB]** Brand book v2.3 addendum, 2026-11-17 (A1–A4). Also in the Project, not this repo. Cited as **[BB2.3-A1]**…**[BB2.3-A4]** (renamed in v2.0.1): A1–A4 here are v2.3 *amendment* numbers, **not** brand book v2.2 rule numbers — code comments such as `design-tokens.css`'s "brand book A4" (the failed red) and #287's "brand rule A5" use the v2.2 rule numbers.
- **[#287]** P6 pricing page, merge `9aeae03`. **[#289]** Slice 0 `jobs.is_demo`, merge `cbe5b16`, migration 040. **[#288]** Slice 1a player, merge `f29bf17`. Read from the PR bodies and diffs.
- **[GH]** GitHub Deployments and Actions APIs, read 2026-11-17 for the deploy facts (§12.14).

| § | Change | Source |
|---|---|---|
| §0 Header | v1.10 → **v2.0**; date 2026-11-17; the stale *"Status: DRAFT for Jon's review"* replaced | this amendment |
| **§12.9** | **DB-12(a): demo songs play signed out; your own songs still need sign-in.** Jon: *"APPROVED - should people play the demo songs without signing in? I recommend yes, for the demos only."* The 2026-11-10 sign-in decision stands for everything else. The v1.7 line *"the core journey stays anonymous"* is superseded. **Not yet built** — Slice 2 opens the demo read path; #289 deliberately opens none | Jon 2026-11-17 [DP] |
| **§12.2 / §12.11 (NEW)** | **Retention: `jobs.is_demo`** (migration `040_v3_jobs_is_demo.sql`). Demo rows are retained until the finite `2099-12-31T00:00:00Z`, not `'infinity'`; excluded from the sweep in both `retention.ts` and `cleanup.py`; account deletion clears `is_demo`; operator rule: never delete the demo account from the Dashboard; the flag is set only by a Jon-approved guarded write | [#289] |
| **§12.12 (NEW)** | **The player as shipped (Slice 1a):** P1 phone layout, P2.1 runs of sections, the Mix sheet and its presets with **DB-13(a)**, the no-chords state, BPM and key from `jobs.bpm` / `jobs.musical_key`, the `--chord-now` token, and one display formatter (`lib/play/notation.ts`) | [#288], [DP], [BB] |
| **§12.13 (NEW)** | **Pricing page as shipped:** `/pricing` indexable and in the top nav; CAD on every price; retention wording = `RETENTION_BULLET` | [#287] |
| **§12.8** | **DB-17 (= §11 O-3): Jon, 2026-11-17: *"LETS WAIT AND SEE"*. Still OPEN.** New songs lose chords on 2026-12-05 unless decided. The options are kept | Jon 2026-11-17 [DP] |
| **§12.14 (NEW)** | **Deploy facts (verified):** the web app auto-deploys to production on merge to `v3/main` (Vercel Git integration); migrations and the worker are manual (worker: Actions → Deploy → target `worker`) | [#289], [GH] |
| **§12.11** | **DB-16:** rights statement recorded in `docs/legal/demo-songs-rights.md` (Jon: *"NOT NEEDED. I MADE ALL THE MUSIC WE HAVE RIGHTS"*; quote completed in v2.0.1) | Jon 2026-11-17 [DP], [#289] |
| **§2.3** | Pointer to the later migrations this delta names (034, 039, 040) | this amendment |
| **§11** | **NEW: "Open after 2026-11-17"** — Slice 1b, Slice 2, Slice 3, the chart-notation PR, the [billing] quiet credit buttons, the staging catch-up, DB-17 | [DP], [BB] |

Other decisions recorded in [DP] and not otherwise restated here: **DB-14 (a)** adjacent runs now (shipped, §12.12); **DB-15 (a)** prices unchanged, playlists Pro-only in Slice 3; **P1** portrait-only use, no rotation needed; **New:** show BPM + key (shipped, #288) and Amber Gold `#f59e0b` for the current chord ([BB2.3-A1]).

**[U] markers resolved after merge (v2.0.1, 2026-11-18):** demos processed and flagged (04:47Z, retained until 2099-12-31); R2 has no lifecycle rules (Jon, Cloudflare); staging fully caught up to 040 (38 `_migrations` rows; verified 05:08Z). **Not done (no longer [U]):** the static-demo-host export ([DP] Slice 0 (2)). **New finding:** prod key detection was wrong on 3/3 demos; the three demo rows were corrected by a Jon-approved named write (§12.11).

Items intentionally UNCHANGED in v2.0: §1 commercial layer and plan values (DB-15 (a): no price change), the 24-hour rule for Free and anonymous jobs, the paid retention rule (#279), §12.10 proxy, §8 (O-4 still open).

---

## Changelog — v1.9 → v1.10 (2026-11-16 — §1.2a link-ingest separation REVERSED; O-8 closed)

Source: **Jon, Mon 2026-11-16** — drop the §1.2a "processor separation" rule for everyone ("Drop the rule"). Pro and Studio may paste YouTube links; paid link jobs are kept in the account's library under the paid retention rule (#279), and count against the plan's monthly quota (Pro 50 / Studio 150) exactly like uploads. Free keeps YouTube links (5/month, 24 h). **Reason:** paid plans build a **library of songs**, and most songs people want to play along to arrive as links, not files — an upload-only paid tier could not hold them. This is the owner accepting the processor-underwriting exposure §1.2a was written to remove, recorded as his decision in the same way v1.5 recorded the stems half.

| § | Change | Source |
|---|---|---|
| §0 Header | v1.9 → **v1.10** | this amendment |
| **§1.2a** | **REVERSED.** The rule text below is kept, struck by a banner, as the audit trail — not an instruction. Paid tiers MAY use link ingest | Jon 2026-11-16 |
| **§1.3 guard** | `enforceEntitlement('start_job_<link>')` no longer refuses `pro`/`studio` by plan code. A paid plan may ingest a link iff **its `plans.services` row lists the service** and `jobs_used < monthly_job_quota` — the `start_job_upload` predicate. Refusals: `ENTITLEMENT_UNAVAILABLE` (`'service not in plan'` / `'quota exhausted'`, 402). `POST /api/jobs` returns every refusal to a subscriber; free/trial outcomes are still ignored there and the existing gates decide | this amendment |
| **§1.3 error codes** | `PAID_LINK_INGEST_DISALLOWED` is **thrown on no user path**. The code and its 400 status are kept so a stored `error_code` or an old client still resolves; its copy no longer says paid plans are upload-only | this amendment |
| **§1.2 / `plans.services`** | **Migration `039_v3_paid_plans_youtube_links.sql`**: `UPDATE plans SET services = ARRAY['youtube'] WHERE code IN ('pro','studio')`. The gate is data-driven, so code deployed before 039 is applied **refuses** paid links (copy: *"YouTube links aren't switched on for your plan yet."*) instead of granting what the catalog and /pricing do not say; the down file re-closes it with no deploy | this amendment |
| **§1.4 metering** | One job, one debit. Paid link job: `bumpJobsUsed()` once in the jobs-INSERT tx, same as a paid upload; never a trial song, never the free allowance. Free link job outside the trial: one unit of the free allowance, **capped in the tx** (`bumpJobsUsedWithinQuota`) | this amendment |
| **Credits** | **Credits are not spent on link jobs, and a free account holding credits is capped at the free allowance (5/month) for links.** This is **a separate decision by Jon, 2026-11-16, widget answer "Cap at 5/month"** — not part of his "Drop the rule" answer, which covered paid plans only. It was raised by the author and by adversarial review 1 of #282 (MUST-1). Before v1.10 that account's link jobs were **uncapped and uncharged**: `checkMonthlyQuota()` waives the quota while credits remain (a waiver meant for credit-funded uploads). The in-tx cap closes that. The `check_credit_decrement` trigger (013) still accepts `input_kind='upload'` only and is unchanged. At the cap, a credit holder is told *"You've used this month's free YouTube links. Your credits still work: upload the audio file instead."* | Jon 2026-11-16 ("Cap at 5/month") |
| **§1.4 metering** | Paid link jobs call `rollPeriodIfStale()` before `bumpJobsUsed()`, the same sequence as a paid upload (review 1 of #282, SHOULD-1) | this amendment |
| **Follow-up, not in v1.10** | **No `jobs_used` refund on a failed job** — for links OR uploads, paid or free (the worker's `_REFUND_SQL` refunds credits only). Link jobs fail more often for reasons on our end (YouTube blocking fetches), so a Pro user can lose units to our failures. Decision for Jon | review 1 of #282, SHOULD-3 |
| Copy | /pricing: Pro and Studio cards render *"Link import: YouTube"* from the column (and the degraded-mode fallback mirrors 039). Landing FAQ: links work on every plan; on Pro and Studio a linked song counts toward the monthly tracks and stays in the library | Jon 2026-11-16 |
| **§11 O-8** | **CLOSED — decided: reverse.** | Jon 2026-11-16 |

Items intentionally UNCHANGED in v1.10: the credit_consumption trigger, the trial path (link-only, still debits a trial song and an allowance unit), retention (#279 keys on the subscription, not `input_kind`, so paid link jobs are kept with no change), anonymous link ingest.

---

## Changelog — v1.8 → v1.9 (2026-11-14 — long songs are trimmed to their first 5 minutes, not refused)

Source: **Jon, 2026-11-14 07:40 PT** — *"If a song is more than 5 minutes, it should still be converted to a play along, but it just [processes the first] 5 minutes of the song. Fix this. Update all production requirements."*

| § | Change | Source |
|---|---|---|
| §0 Header | v1.8 → **v1.9** | this amendment |
| **§12.5** | **V3-J4 REVISED: trim, not refuse.** The 300 s ceiling stays (`MAX_UPLOAD_DURATION_SEC` = `MAX_TRACK_SEC` = `CHORDS_MAX_AUDIO_SEC` = `KLANGIO_MAX_AUDIO_SEC`), but an input longer than it is **cut to its first 300 s** on bytes the worker holds and the job proceeds. `UPLOAD_TOO_LONG` is no longer raised for length | Jon 2026-11-14 |
| **§12.5** | The trim is recorded on the `downloading`/`completed` job event (`detail = {"trimmed": true, "source_sec": X, "used_sec": N}`; no migration) and shown on the job page: *"Using the first 5:00 of a 6:12 track."* | this amendment |
| **§12.5** | Browser admission probe: no longer declines a >5 min file; shows *"This track is longer than 5 minutes — we'll use the first 5 minutes."* before submit | Jon 2026-11-14 |
| **§12.5** | Cobalt (URL, no bytes, cannot be trimmed) is tried only when gate 0c **read** a length at or under the cap — unknown **or long** → skipped | this amendment |
| **§13 table** | V3-J4 row restored as **LAUNCH — trim to first 300 s** | this amendment |
| Copy | Landing, `/terms`, root metadata: *"Tracks up to 5 minutes"* → *"Uses the first 5 minutes of any song"*; *"Longer tracks are not supported"* → *"A longer track is trimmed on our end to its first 5 minutes"* | Jon 2026-11-14 |

---

## Changelog — v1.7 → v1.8 (2026-11-11 — the plan catalog re-priced, and the unbuildable flags cleared)

Source: **Jon's approved pricing model, 2026-11-11**, metered on *tracks converted to play-along* — his words: *"we should revise pricing for numbers of tracks converted to playalong."* Implemented by **migration `034_v3_pricing_model_truth.sql`**, which from here is the **source of truth for plan values**; `014_v3_seed_plans.sql` is left unedited as the historical record (append-only, §11 Merge Safety Rule (b)).

### The approved model

| code | tracks / month | price | link import |
|---|---|---|---|
| `free` | **5** | $0 | YouTube — **unchanged, see O-8** |
| `pro` | **50** | $4.99 CAD | none — **unchanged, see O-8** |
| `studio` | **150** | $12 CAD | none — **unchanged, see O-8** |

> ⟲ **v1.10 (2026-11-16):** O-8 decided — Pro and Studio now carry YouTube link import (migration 039); Free keeps it. The table above is the v1.8 record.

Credits (20 for $5) are unchanged and still live in `public.credit_packs` (migration 020).

| § | Change | Source |
|---|---|---|
| §0 Header | v1.7 → **v1.8** | this amendment |
| **§1.2** | Plan table **REPLACED**. Free *"3 songs/day"* → **5 tracks/month**; Pro *"Unlimited own-file processing"* → **50 tracks/month**; Studio → **150 tracks/month** | Jon 2026-11-11 |
| **§1.2** | **"Unlimited" is retired as a concept.** No plan is unlimited. The `100000` values Pro and Studio carried were a sentinel that `rate-limit.ts` short-circuits on, i.e. an unmetered paid tier against a real per-job cost | Jon 2026-11-11 |
| **§1.2b (NEW)** | Names the metered unit, the enforcement path, and migration 034 as the source of truth | this amendment |
| **§1.3** | `export_stems` is **false on every plan**. There is no stem-export route — `/api/jobs/[id]/stems` serves Opus **playback** urls and says so, and `mintStemDownloadUrl()` has no production caller. This **supersedes the v1.7 "3 free downloads, then paid" amendment**, which specified an allowance against a feature that does not exist | measured against the repo, 2026-11-11 |
| **§1.3** | `export_wav24` is **false on every plan**. Loops *are* 24-bit WAV (`worker/encoder/wav_encoder.py` writes `PCM_24`) — for **every** tier, with no account, as the landing page has always advertised. So it is a real feature and a **false differentiator** | measured against the repo, 2026-11-11 |
| **§1.3** | Error copy corrected. `PAID_LINK_INGEST_DISALLOWED` told users to *"Paste a link into the free tier (3/day)"* — **no 3/day limit has ever been implemented**; the allowance is `plans.monthly_job_quota` per calendar month. Its headline also omitted Studio, which the guard also refuses | measured against the repo, 2026-11-11 |
| **§1.2 / `plans.services`** | **Spotify and SoundCloud removed from the free plan row.** Neither has a downloader, a route or an error code anywhere in the repo, and the pricing page advertised both purely because the column listed them | measured against the repo, 2026-11-11 |
| **§11** | **NEW O-8** — the one item in the approved model that is *not* implemented here, because it reverses §1.2a | this amendment |

### What this amendment does NOT do, and why — **O-8, for Jon**

Jon's approved model gives **Pro and Studio YouTube link import** and takes it **off Free**. **That is not implemented.** `plans.services` is left `{}` on the paid tiers and `{youtube}` on free. The reason is not reluctance to follow the decision; it is that the decision as written cannot be delivered by a data change, and shipping the data change alone would produce a *new* false page:

1. **`services` does not gate link ingest.** `enforceEntitlement()` refuses it for `pro`/`studio` **by plan code, before it ever reads `services`**. Writing `ARRAY['youtube']` would make /pricing advertise an import the API answers with a **400**.
2. **Nor would clearing free's `services` disable it.** The link branch of `POST /api/jobs` acts on **only** `PAID_LINK_INGEST_DISALLOWED` and deliberately ignores every other entitlement outcome, and anonymous callers skip the guard entirely. Free link import would keep working while the page said it did not.
3. **Making either true means reversing §1.2a** — the rule this document calls **NON-NEGOTIABLE**, whose stated rationale is that it *"moves adversarial-review Lens B (CAP, 84/100) above 90"* by keeping **payment-processor underwriting** clean: *"The processor sees a software product that accepts audio uploads and sells credits."* Monetising the YouTube-sourced path is the exposure that separation exists to remove. **v1.5 amended the stems half of §1.2a and explicitly left this half standing: *"The paid/free separation rule itself is NOT otherwise amended and must be revisited when Stripe lands."*** This is that moment, and it is a legal and product decision for Jon, recorded as his — the convention v1.5 set when it reversed a legal-risk mitigation.

**What Jon decides:** whether to reverse the §1.2a link-ingest separation for paid tiers. If yes, it is its own change — `entitlements.ts`, the two test files that assert the current rule (`paid-link-ingest-disallowed.test.mjs`, `jobs-link-paid-blocked.test.mjs`), the error-code semantics, and a recorded §1.2a override. Nothing in this amendment blocks it.

### The cost numbers the margins rest on — **state this caveat wherever a margin is stated**

Measured read-only from production 2026-11-11: **median Replicate spend $0.0288 USD per job, mean $0.0298, max $0.0446, over 4 jobs.** That is a **4-job sample** and it measures **Replicate only** — **Klangio, R2 storage and egress, Vercel and Fly are unmeasured.** Every margin implied by $4.99/50 or $12/150 inherits both limits.

Items intentionally UNCHANGED in v1.8: §1.1, §1.2a (see O-8), §1.4–§1.9, §2, §3, §4, §5, §6, §7, §8, §9, §10, §12. Credits SKUs unchanged. No schema DDL moves — 034 is pure DML on `public.plans` plus three column comments.

---

## Changelog — v1.6 → v1.7 (2026-11-10 — corrections after an adversarial review, and Jon's two decisions)

**Why this amendment exists.** An M-9 adversarial review on a different model family scored v1.5+v1.6 **48/100, "do not merge as written."** It was right. **v1.6 had already auto-merged before the review returned** (`8fb87ef`, by `stem-loops-automerge[bot]`), so these are corrections to *merged* content, not to a draft.

| § | Correction | Finding |
|---|---|---|
| §0 Header | v1.5 → **v1.7**. ⚠️ v1.6's changelog claimed a header bump **that never landed** — line 3 still read "v1.5 amendment pass" | review M2 |
| **§12.5** | **V3-J4 WITHDRAWN.** Its "measured" failure mode was false, and implementing it would have rejected 5–10 minute songs that work today | review **H1** |
| **§12.6** | **NEW V3-J7** — the fetch path is the actual launch blocker. Replaces the inert cap with the real, measured gap | review **H2** |
| §12.7, §12.8 | v1.6 wrote §12.5–12.7 **inside its own changelog**, so a reader of §12 never saw them. Now in §12 | review **M3** |
| **§9** | V3-J1…J8 rows **added for real**. ⚠️ v1.5's changelog claimed it added V3-J1…J3 to §9 and **§9 was never touched** | review **H5** |
| **§3** | Launch banner added. The "promoted to LAUNCH" claim existed only in a changelog row | review H5, M1 |
| **§1.3** | Resolved against §12.2's stem download, per Jon's "3 free then paid" decision | review **H4** |
| **§8.2** | `ENABLE_V3_PLAY` resolved against the §12 launch | review **H3** |
| §12.2 | **Download format: `.wav`** (Jon). **Stem download: 3 free, then paid once Stripe lands** (Jon) | Jon 2026-11-10 |

**The process failure, recorded because it will recur.** The review ran **after** the merge. Three PRs auto-merged in one afternoon on `rollback-safe` + `fast-path`, which is the merge autonomy this project has wanted for four sessions — and it means **a spec defect reaches `v3/main` exactly as fast as a good one.** For a document that is the contract every PR cites, the review belongs **before the label**. **A TSD amendment should carry `needs-jon-approval` until its review returns.**

**Still open for Jon** (added to §11): whether a 3-free stem-download allowance can be enforced on an **anonymous** launch path at all — hashed-IP cohorts are not an identity, so either the allowance is weak or stem download requires sign-up, which pulls the authed path back into launch scope.

---

## Changelog — v1.5 → v1.6 (2026-11-10 — launch scope, answered by Jon)

Source: **Jon's answers 2026-11-10** to the four scope questions v1.5 left open. Surgical: only §0, §12 and this changelog are touched. No schema or route contract moves.

| § | Change | Source |
|---|---|---|
| §0 Header | v1.5 → v1.6 | this amendment |
| **§12.2** | **Stem formats fixed: Opus for playback, plus a downloadable WAV or MP3.** Opus is the streaming/playback format per §3.1; the download is a separate user-facing artifact | Jon: *"STEM FORMAT - wav or mp3 downloadable too"* |
| **§12.5 (NEW)** | **V3-J4 — the 5-minute song cap.** `MAX_UPLOAD_DURATION_SEC` drops **600 → 300** so that chords are never silently missing | Jon: *"5 mins is fine"* |
| **§12.6 (NEW)** | **V3-J5 — launch browser scope: Chrome/Edge desktop.** Firefox and Safari added only where cheap | Jon: *"chrome at launch is FINE. add the other browsers if it's easy."* |
| **§3.3 (V3-E3)** | Tempo/pitch **deferred out of launch** to hardening. Content unchanged | Jon: *"tempo / pitch - defer to hardening. we don't need it at launch"* |
| **§12.7 (NEW)** | **The 2026-12-05 validation deadline** is promoted to a requirement, not a note | Jon: *"we have to validate this product before THEN"* |

> **⟲ v1.7 note:** §12.5–12.7 were originally written **into this changelog instead of into §12**, which meant a reader of §12 never saw them. They now live in **§12.5–§12.8**. **V3-J4 was withdrawn in v1.7** — its premise was false. See the v1.6 → v1.7 changelog.

Items intentionally UNCHANGED in v1.6: §1, §2, §3 (content — only its launch priority and the §3.3 deferral change), §4, §5, §6, §7, §8, §10, and §12.1/§12.3/§12.4 from v1.5.

---

## Changelog — v1.4 → v1.5 (2026-11-10 — the play-along launch, and Jon's link-path stems override)

Source: **Jon's directives 2026-11-10**, verbatim where quoted. This amendment changes **scope and the launch definition**, not schema or route contracts. It is the first amendment to **reverse a legal-risk mitigation**, so the reversal is recorded with its original reasoning intact rather than deleted.

### The directives

1. *"I want stems from a youtube link."*
2. *"Launch = the put in a youtube link, get stems generated, then you can play along to the song with the chords showing on top of the song. You can also lower the volume on any stem. You can also play along to the guitar or other part which you see the chords"*
3. On the §5.4 processor-exposure mitigation: *"**APPROVED — I do not care about the legal risk decision.** Update the documentation."* and *"re PHASE E — I gave you the legal decision... **I do not care about the legal risk**"*
4. *"guitar plugged in"* = an outboard headphone amp (Fender Mustang Micro). Jon already has this workflow on Chordify: guitar into the device, song playing, stems split, per-stem volume, chords visible.

| § | Change | Source |
|---|---|---|
| §0 Header | v1.4 → v1.5; date 2026-11-10 | this amendment |
| **§5.4** | **Link-path stem separation is now PERMITTED.** The sentence *"Stem separation on the free-tier link path is NOT offered"* is **OVERRIDDEN by Jon 2026-11-10.** | Jon directive 1 + 3 |
| **§5.4** | **Variant Y is REMOVED FROM THE LAUNCH PATH** and reclassified as optional future work | consequence of the override — see below |
| **§1.2a** | Stems are **no longer paid-tier-only**. The parenthetical *"(paid tier, §1.2a)"* at §5.4 no longer holds. ⚠️ **The paid/free separation rule itself is NOT otherwise amended** and must be revisited when Stripe lands | consequence of the override |
| **§3** | The Variant D engine is **promoted from Phase 1b to the LAUNCH path**. It is the mixer, and the mixer is now the product | Jon directive 2 |
| **§12 (NEW)** | **V3-J1 — the core customer journey**, stated as a single acceptance test, plus **V3-J2 stem retention** and **V3-J3 chord/playhead sync** | Jon directive 2 |
| §9 | New req IDs V3-J1, V3-J2, V3-J3 | this amendment |

### What the override costs, recorded honestly

§5.4's excluded sentence was not an oversight. Its stated purpose:

> *"This is the direct processor-exposure mitigation that moves Lens B from 84 to 90+."*

So an adversarial legal review scored the architecture **84** and this exclusion is what raised it to **90+**. Separating audio fetched from a third-party link on our own servers is the exposure that exclusion removed. **Jon was shown this reasoning verbatim and overrode it explicitly, twice, on 2026-11-10.** It is his decision to make and it is recorded as his, not as an evidence-driven one.

**Not legal advice.** This document records a business decision by the owner; nobody with a legal qualification has reviewed it. If stem-loops later takes investment, is sold, or receives a rightsholder complaint, **this changelog entry is the audit trail** and §5.4's original reasoning is deliberately preserved above for that purpose.

**Unchanged by the override:** §1.6 / §1.6a Chordify-aligned legal posture, the §259 Phase-5 DMCA designated-agent gate, and the 24-hour retention rule. The override is about *where separation may run*, not about retention, attribution or takedown handling.

### Why Variant Y leaves the launch path — this is a simplification, not a loss

Variant Y existed **because of** the constraint Jon just lifted. Its whole design — official YouTube IFrame, browser tab-capture, 100% client-side chord detection — was to deliver chords on a link *without our servers touching the audio*. With server-side separation permitted on the link path, chords for that path come from the **server-side provider pass** that is already wired end to end, and playback is of **our own stems**.

**Consequently the launch path no longer depends on any of:** the WASM librosa port (`ChordOverlay.tsx:15` — *"Variant Y is paused pending a WASM librosa port"*), ONNX Runtime Web, the ChordNet 2E1D student (PR-Y1.4), browser tab-capture, or the Chrome/Edge-only `getDisplayMedia({audio:true})` matrix. **The single largest blocker on Jon's journey was a dependency of a mitigation that no longer applies.**

Variant Y is **not deleted** — `apps/web/src/chord/` (cqt-frontend, viterbi, smoother, alphabet, tab-capture) and issue **#135** stand. It is reclassified as **optional future work**, valuable if the legal posture is ever revisited or if a zero-server-cost chord path is wanted.

### ⚠️ The Klangio bridge expires before its replacement exists

v1.4's own decision log pins: *"**Klangio Startup $99 / 1 billing cycle only (hard cap)**... swap out by end of Month 1 to the self-hosted ChordNet student."* Measured 2026-11-10: the subscription is **Klangio API Monthly — Startup, $99.99/mo**, subscribed 2026-11-05 and **already scheduled to cancel effective 5 Dec 2026** — i.e. the hard cap is in force exactly as designed.

**The swap-out target does not exist.** `_SyntheticFactoredDataset` is a random-label placeholder (tracker red flag **R-4**), so ChordNet 2E1D cannot be trained, distilled or hosted by 5 Dec.

**So chords — which Jon states are core to V3 (*"Chords are very important to the V3"*) — stop working on 5 Dec 2026 unless one of:** the Klangio subscription is kept past the documented cap; `autochord` is implemented as a provider (see `claude/vendor-tos/autochord-gpl-licence-decision.md` — note it is **not** in `chord_source.py`'s closed provider set and needs an OS-level VAMP plugin in the worker Dockerfile); or ChordNet training is resourced with real data. **This is a dated, scheduled failure, not a risk. Decision needed before 5 Dec.**

**Also unresolved:** Klangio's API commercial-use grant. Public ToU §12.4 restricts to *"private, non-commercial purposes"*; §5.2.3 carves the API out to **unpublished** separate terms. Asked 2026-11-05 (request **#61093**), escalated by their AI assistant, **no human reply in 5 days**. Jon's decision 2026-11-10: *"If they don't answer I don't care. We keep goin"* — chords ON for the **free** launch, written grant remains a gate on the **paid** tier.

Items intentionally UNCHANGED in v1.5: §1 commercial layer (other than the §1.2a note above), §2 users + RLS, §4 Spotify resolver, §5.1–§5.3, §5.5, §6 routes, §7 observability, §8 rollback contract, §10 cross-ref matrix. **§3 is unchanged in content and promoted in priority.**

---

## 12. V3-J — the core customer journey (NEW in v1.5)

**This section is the launch definition.** Jon, 2026-11-10: launch is the play-along, not the loop downloader.

### 12.1 V3-J1 — the journey, as one acceptance test

> A visitor pastes a public YouTube link on `stem-loops.com`. The song is fetched and separated into 6 stems server-side. On the result page they press play; the song plays back as a synchronised 6-stem mix. A **fader per stem** lets them pull any part to silence. A **chord timeline above the transport scrolls in sync with the playhead**. With an electric guitar in an outboard headphone amp, they play along to the song with the guitar stem removed, reading the chords as they pass.

> ⟲ **v2.0.1:** superseded by §12.9 v2.0 — your own songs need sign-in (Jon, 2026-11-10); only the three demo songs play signed out (DB-12(a), not yet built — Slice 2). A visitor pasting a link must be signed in.

> ⟲ **v2.1 (2026-11-21):** the journey is now Jon's own phone story of 2026-11-20: *"on my mobile, take a YouTube link and put it in, and very quickly be able to listen and learn the song"* (user stories **v4.0, approved by Jon 2026-11-21** [Jon 11-21b], Story 1, J1–J10). The **owner pass bar is the Phase A play-test gate: Jon plays 3 songs on his phone, with his instrument, when Phase A is live** ([Jon 11-21] approved the gate; "3 songs" is the [DR] synthesis wording he approved). Not yet run. The three demo songs play signed out since #302 (§12.9).

> ⟲ **v2.2 (2026-11-22):** the **Phase A play-test gate PASSED** on 2026-11-22 04:48:47Z (Jon, 21:48 box clock): *"played the 3 songs on my phone. Everything felt right ... the product works great."* [L17 04:48:47Z 11-22]. The gate ran on production `fdf4aae` (Vercel production deployment created 04:28:46Z [GH]) after the orchestrator's live check on the 3 demo songs at 390×844 [L17 04:30:42Z 11-22]. **[UNVERIFIED]** whether Jon's 3 songs included a link he pasted himself (the ledger row does not say), so this record does not claim V3-J1's link leg separately.

**Explicitly OUT of scope for V3-J1**, per Jon's answer that the guitar is mixed in hardware: live audio input, input monitoring, round-trip latency budgets, and any `getUserMedia` path. The guitar never enters the browser.

**Pass bar:** Jon performs the journey end to end on a real song with his own guitar and confirms it. A green test suite is **not** a pass for V3-J1 — this requirement is defined by the owner's own use.

### 12.2 V3-J2 — stem retention and serving (NEW — blocking V3-J1)

**Measured gap, 2026-11-10:** `apps/worker/src/worker/storage/r2_uploader.py` exposes **`upload_input`, `upload_loop`, `upload_play_chords`** and **no `upload_stem`**; `packages/types` `Job` carries `loops?: Loop[]` and **no stems field**. Full-length separated stems are produced from Replicate, used to cut loops, and **discarded**. V3-J1 is impossible until they are retained.

Requirements:
- The worker **retains** the 6 full-length stems and uploads them under the job's R2 prefix.
- **Playback format: Opus**, consistent with §3.1's engine assumption (*"the Opus-encoded bytes (compressed, 4–5 MB per stem)"*) and with `AudioContext` at 48 kHz to avoid resample cost.
- **Download format: `.wav`** — decided by Jon, 2026-11-10 (*"download = .wav"*). Separate artifact from the Opus playback stems: Opus is the right streaming codec and the wrong hand-off to a DAW. ⚠️ **A second encode and a second R2 object per stem** — 6 extra objects per job, and `.wav` is **much** larger than Opus (roughly 10 MB/min/stereo at 16-bit/44.1k vs 4–5 MB for a whole Opus stem), so a 5-minute 6-stem job adds on the order of **300 MB** of R2 writes. The 24-hour expiry is what makes that affordable; **do not extend retention without re-costing this.**
- **Entitlement: 3 free stem downloads, then paid once Stripe is integrated** — decided by Jon, 2026-11-10. This resolves the §1.3 contradiction the M-9 review found: a 3-download allowance is a **trial**, not a free tier, so it is consistent with §1.3 keeping `export_stems` on the paid tiers.
  > ⚠️ **Open, and it is load-bearing: the allowance needs an identity the launch path does not have.** The launch is anonymous (*"Free, no account"*), and anonymous users are keyed by **hashed IP** (`IP_HASH_KEY`), which is a rate-limit cohort, not an identity — trivially reset by changing network. So either (a) the allowance is per-IP-cohort and weak by design, or (b) **stem download requires sign-up**, which pulls the authed path — hCaptcha, Resend, the whole §12-excluded surface — back into launch scope. **This is Jon's call and it changes launch scope either way.** Existing machinery worth reusing if (b): `trial_grants` is already one-per-user-ever with a PK on `user_id` (§6.1), so a second counter should not be invented.
  > ⟲ **v2.0.1:** superseded by §12.9 v2.0 — your own songs need sign-in (Jon, 2026-11-10); only the three demo songs play signed out (DB-12(a), not yet built — Slice 2).
- `Job` gains a stems collection; stem URLs are **short-TTL signed GETs** from the private bucket, matching the existing `loops` and `play-chords` pattern — never public objects.
- Stems obey the **same 24-hour expiry** as every other job artifact. The retention promise in §1.6a does not change.
  > ⟲ **v2.0 (2026-11-17): 24 hours is no longer the only rule.** One retention rule, `JOB_RETAINED_UNTIL_SQL` (`apps/web/src/lib/retention.ts`) = `RETAINED_UNTIL_SQL` (`apps/worker/src/worker/cleanup.py`), pinned identical by `apps/worker/tests/test_paid_retention.py`, now gives three answers: **Free and anonymous jobs: 24 hours**; **Pro and Studio: kept while subscribed, plus 30 days** (#279; the pricing page's `RETENTION_BULLET`); **demo songs (`jobs.is_demo`): until 2099-12-31** (§12.11, #289).
- Adds R2 storage and egress per job. Bounded by the 24-hour expiry.

### 12.2a V3-J2a — the Ogg demuxer nobody has scoped (NEW in v1.7) ⚠️ **unnamed dependency on the launch path**

**Measured 2026-11-10, in a real browser, not reasoned about.** The playback artifact is `libopus` at 128 kbps / 48 kHz in an **Ogg** container (`ffprobe`: `codec_name=opus, sample_rate=48000, channels=2, format_name=ogg`). Chromium decodes it correctly through `decodeAudioData` — 20 s in, 20 s out, 2 channels, 48 kHz — so **the bytes are valid and the artifact is sound.**

**But `decodeAudioData` is the path §3 explicitly rejects**, and the path §3 *requires* cannot read a container:

- §3 T-E2: *"the full-decode fallback peaks at 643 MB and **FAILS** the 400 MB bar"*. Independent arithmetic agrees — 5 min stereo at 48 kHz as float32 is 300 × 48000 × 2 × 4 = **110 MiB per stem**, ×6 = **659 MiB**, which lands on their measured 643 MB. So `decodeAudioData` is not an option for six stems, only for variant S.
- §3 Variant D holds *"the **Opus-encoded bytes**"* and drives *"a **WebCodecs `AudioDecoder`** per stem"*, re-seeding at *"a **packet-boundary** close + reopen"*.

**`AudioDecoder` does not demux.** It consumes `EncodedAudioChunk`s — raw Opus packets. So between the `.opus` file and the engine there must be an **Ogg page/packet demuxer in JavaScript**, and *no section of this TSD names it, scopes it, or assigns it*. §12.4's sequencing (V3-J2 → V3-J3 → §3 engine + faders) silently assumes it exists.

**Not a defect in the artifact — a missing work item.** The container is the right transport and matches §3.1's wording. What is missing is the ~200 lines that turn Ogg pages into packets.

**Open question for the engine phase, stated rather than assumed:** Ogg or WebM. Both need demuxing; Ogg is what `libopus` emits by default and what §3.1's "Opus-encoded bytes" implies. Changing it is a one-flag change in `_encode_stem_opus` plus the two key builders, so this is cheap to revisit **before** the demuxer is written and expensive after.

⚠️ **`AudioDecoder` itself remains UNVERIFIED on real hardware.** The headless Chromium used for the measurement above reports `typeof AudioDecoder === 'undefined'`, so `AudioDecoder.isConfigSupported({codec:'opus', sampleRate:48000, numberOfChannels:2})` — the capability probe §3's browser matrix is built on — **could not be executed**. That is a limitation of the test environment and is **not** evidence either way about production Chrome. §3's matrix and the V3-TE2b Safari gate still rest on unexecuted assumptions.

**Measured sizes, for the §12.2 "4–5 MB per stem" figure.** Both encoded with the worker's exact command:

| Content | 20 s / 10 s bytes | Projected 5-min stem |
|---|---|---|
| pure sine (compresses well) | 148,160 (10 s) | **4.24 MB** |
| 3-way mix, pink noise + two tones | 219,557 (20 s) | **3.14 MB** |

128 kbps puts a dense real stem at or just under the bitrate ceiling (128000 × 300 / 8 = **4.8 MB**). So a real stem lands in **~3–4.8 MB**: at or below §12.2's figure, never above it. Six stems ≈ **19–29 MB**, against ≈ **300 MB** for the same six as WAV.

### 12.3 V3-J3 — chord / playhead synchronisation (NEW)

`ChordOverlay` already renders a timeline from `play.chords.json`. V3-J3 adds a playhead input and auto-scroll so the chord under the playhead is the chord being heard, within a **stated and measured** tolerance. The component's existing `onChordEdit` / `onChordLabelEdit` props stay unwired — the write path is incomplete (issue **#135**) and V3-J3 does not open it.

### 12.4 Sequencing

V3-J2 → **V3-J2a (the Ogg demuxer, §12.2a — newly surfaced and previously unscoped)** → V3-J3 → §3 engine + faders → **V3-J1 (Jon's own acceptance)** → §3.6 hardening. Loop download survives unchanged; the landing copy must be rewritten, since it currently sells loops and not play-along.

**Revised in v1.7 to include the launch requirements that v1.6 left out of this section:** V3-J2 → V3-J7 (the fetch path must work at all) → V3-J3 → §3 engine + faders → **V3-J1** → §3.6 hardening. **V3-J5** (browser scope) and **V3-J8** (the Dec 5 date) constrain every step.

### 12.5 ~~V3-J4 — the 5-minute song cap~~ — **WITHDRAWN in v1.7**

> 🔴 **WITHDRAWN. The premise was false, and implementing it would have caused a regression.** Recorded rather than deleted, because a wrong requirement that reached `v3/main` is worth more as a record than as a deletion.

v1.6 claimed a 6-minute song *"succeeds at stems and loops and silently loses chords to a `provider_failed` tombstone"* via `pipeline.py:706`. **It does not.** An adversarial review found a duration gate the author never read:

```
pipeline.py:612-630
    # Duration gate: BEFORE stem selection so an over-length track also skips the ffmpeg
    # harmonic mix. The track is still accepted (stems/loops are the product); only the
    # optional chord overlay is skipped, with a specific reason for the UI.
    if duration is not None and duration > max_sec:
        log_structured("INFO", "chords_skipped_too_long", ...)
        _write_chords_tombstone(job_id, "too_long", duration_sec=round(duration, 1))
        return
```

Three corrections:

1. **The tombstone is `too_long`, not `provider_failed`.**
2. **It is not silent.** `ChordOverlay.helpers.ts:486` renders *"Chords aren't available for this track: chord detection supports tracks up to 5 minutes. Your stems and loops are unaffected."*
3. **The 600-vs-300 gap is deliberate and documented** at `pipeline.py:103-111`, with a stated Replicate-cost rationale: *"600 s leaves headroom for ordinary long songs (extended mixes, prog) without opening the door to DJ sets / albums."*

And the governing knob is a **third** one v1.6 never mentioned: **`CHORDS_MAX_AUDIO_SEC`** (`pipeline.py:458`, default 300.0), not `KLANGIO_MAX_AUDIO_SEC`.

**So the existing behaviour is already correct** and lowering `MAX_UPLOAD_DURATION_SEC` to 300 would **reject 5–10 minute songs that work fine today**. Jon's *"5 mins is fine"* referred to the 5-minute **chord** limit, which already holds. **No change required. `MAX_UPLOAD_DURATION_SEC` stays at 600.**

#### ⟲ REINSTATED in v1.8 (2026-11-11) — the withdrawal's own premise was false

> 🟢 **V3-J4 is back, and implemented.** Approved directly by Jon, 2026-11-11. The v1.7 text
> above is kept verbatim; this is the correction to it, not a rewrite of it.

v1.7 withdrew V3-J4 on one load-bearing sentence: *"lowering `MAX_UPLOAD_DURATION_SEC` to 300
would reject 5–10 minute songs that work fine today."*

**Those songs do not work fine today.** v1.7 checked the chord path and the worker, and never
checked the player it was written to protect:

| Layer | What a 301–600 s track gets | Where |
|---|---|---|
| Worker upload cap | accepted (600 s) | `pipeline.py:118` before this change |
| Chord overlay | **never produced** — a `too_long` tombstone | `pipeline.py:641`, `:804-812` |
| **Web player** | **`PLAY_TRACK_TOO_LONG`. The player does not open at all.** | `engine.ts:94`, `:298-303` vs `MAX_TRACK_SEC = 300` (`play/types.ts:62`) |

So the 600 s cap never bought a working 5–10 minute song. It bought a **paid Replicate
separation whose only possible outcome is an error screen** — and, because `engine.ts` checks
the ceiling only *after* decoding and downmixing all six stems, it buys that error at a peak of
`6 × 600 × 48000 × 4 B ≈ 659 MiB` of PCM on the visitor's machine, the same byte count the
Gate-0 spike measured at 805 MB RSS and **rejected** against a ~600 MB bar.

`MAX_TRACK_SEC = 300` was fixed by the Gate-0 playback spike (`claude/spike-simple-playback-engine-2026-11-10.md`
v1.1, decided by Jon 2026-11-10: *"300 s, to agree with `KLANGIO_MAX_AUDIO_SEC`… one product-wide
ceiling"*). **Nothing ever wired that decision into the worker.** 600 was not a number anyone
chose for this pipeline; it was a number nobody revisited. This change is the wiring, not a new
requirement.

v1.7's other three corrections stand unchanged and are not disturbed: the tombstone is
`too_long`, it is not silent, and `CHORDS_MAX_AUDIO_SEC` is the governing chord knob.

**Change required. `MAX_UPLOAD_DURATION_SEC_DEFAULT` is 300.0**, equal to
`CHORDS_MAX_AUDIO_SEC`, `KLANGIO_MAX_AUDIO_SEC`, `MAX_TRACK_SEC` and the landing's "up to 5
minutes". A browser-side duration probe at admission declines the obvious case before the
upload and the spend; it **fails open** and is a spend-and-UX guard only — the worker cap
remains the enforcement.

#### ✂ REVISED in v1.9 (2026-11-14) — trim to the first 5 minutes, do not refuse

> 🟢 **V3-J4 now reads: every song is converted; a song longer than 5 minutes is converted
> from its first 5 minutes.** Jon, 2026-11-14: *"If a song is more than 5 minutes, it should
> still be converted to a play along, but it just [processes the first] 5 minutes of the song."*
> The v1.8 text above is kept as the record; where it says *refuse* / *declines*, this governs.

**What stays.** The 300 s ceiling and its reasons (player PCM memory budget, `MAX_TRACK_SEC`;
Klangio ≤ 300 s; Replicate cost per GPU-second). One knob, `MAX_UPLOAD_DURATION_SEC` (default
300), is now the **trim length**. The player's `MAX_TRACK_SEC` check stays as a safety net.
Billing is unchanged (one job = one credit). Chords are unaffected: a trimmed input is ≤ 300 s.

**Requirements (all enforced in the worker, on bytes it holds, before Replicate is called):**

| ID | Requirement | Where |
|---|---|---|
| V3-J4.1 | An **upload** longer than the cap is decoded with `ffmpeg -t <cap>`; the WAV handed to Replicate is ≤ cap. Corrupt / empty / silent / too-short / size guards unchanged | `pipeline._prepare_upload_source` |
| V3-J4.2 | A **link** longer than the cap is fetched by yt-dlp and cut with `ffmpeg -t <cap>`; the output is re-measured and the job **fails closed** (`LinkUnmeasurableError`, `INTERNAL_ERROR`) if it cannot be cut or measured. A link at or under the cap is staged untouched | `pipeline._trim_link_source` |
| V3-J4.3 | **Cobalt** returns a URL and no bytes, so it cannot be trimmed: it is tried only when gate 0c read a length **at or under** the cap. Unknown or long → skipped; the yt-dlp error stands | `downloader.download_audio` |
| V3-J4.4 | Gate 0c **refuses nothing**. It reads the length for the Cobalt decision and logs `fetch_will_trim` | `downloader.download_audio` |
| V3-J4.5 | A trimmed job records `{"trimmed": true, "source_sec": X \| null, "used_sec": N}` on its `downloading`/`completed` event; `GET /api/jobs/:id` exposes it as `input_trim_used_sec` / `input_trim_source_sec` (event `detail` itself is never sent to the browser) and the job page shows *"Using the first 5:00 of a 6:12 track."* | `pipeline._run_pipeline`, `api/jobs/[id]/route.ts`, `lib/input-trim.ts` |
| V3-J4.6 | The browser probe never declines; for a measured >5 min file it shows *"This track is longer than 5 minutes — we'll use the first 5 minutes."* before submit. Unmeasurable → no note | `lib/upload-duration.ts`, `ToolForm.tsx` |
| V3-J4.7 | `UPLOAD_TOO_LONG` / `LinkTooLongError` stay **defined** (old rows, web error-copy map) but are **not raised** for length | `errors.py` |

**Design choice — download then trim, not `--download-sections`.** yt-dlp's section download
hands the IP-bound googlevideo URL to an ffmpeg sub-download; the sticky-session proxy fix in
`ytdlp_client` exists because a media request on a different exit IP 403s. The full fetch is
the leg already proven through the proxy. **Residual:** a very long video (an hour+) is
fetched in full and may hit the yt-dlp timeout → `DOWNLOAD_TIMEOUT` (typed; the user is offered
upload). Previously gate 0c refused it with `UPLOAD_TOO_LONG` before fetching.

**Tests:** `apps/worker/tests/test_link_duration_cap.py`, `test_upload_duration_cap.py`,
`test_link_money_path_e2e.py` (DB); `apps/web/test/job-input-trim.test.mjs`,
`src/lib/upload-duration.test.mjs`, `test/job-page-render.test.mjs`, `test/landing-copy.test.mjs`,
`test/legal-terms-copy.test.mjs`.

### 12.6 V3-J7 — the fetch path must actually work (NEW in v1.7) — **THE LAUNCH BLOCKER**

> ✅ **v2.1: V3-J7 and V3-J10 MET on 2026-11-17.** With `PROXY_URL` set on Fly, three different public YouTube links reached `done` from Jon's phone (jobs `85cf8212`, `96fb67cb`, `4a940d3d`; median about 2 min 26 s) [L17 17:37Z]. **Later outage:** from 2026-11-18 23:04Z every link job failed `DOWNLOAD_BLOCKED` because the proxy answered `407` (QA-61); Jon rotated the IPRoyal password and `PROXY_URL`, and the first job after it reached `done` at 04:13Z on 11-19 [L17 03:57Z–04:14Z 11-19]. Hardening shipped since: proxy failures are classed as ours with a cheap 15-min fetch canary on `/health` (#307 `9965f5c`), hysteresis and a total deadline on that check (#313 `e209a38`), and the first byte is recorded with stalled non-final attempts cut at 15 s (#327 `ddf1a18`). The text below is the 2026-11-10 record.

V3-J1 begins *"a visitor pastes a public YouTube link"*. **That step currently fails 100% of the time.** Measured 2026-11-10, two jobs, same video, 26 minutes apart:

| Job | Created | Result |
|---|---|---|
| `d1835fad-5a61-4deb-99a5-1a4be3111bcf` | 17:45:32Z | `DOWNLOAD_BLOCKED` |
| `459064cf-eb7a-47f2-9bfe-ff7a39540d43` | 18:11:51Z | `DOWNLOAD_BLOCKED` |

Both reached stage `downloading`, which **proves `ALLOW_YOUTUBE_INPUT` is `'true'`** — independently confirmed by reading the Vercel env (both flags `plain = "true"`, production). **This is not a flag problem and not a legal one.**

**Two independent causes, in the order the runbook prescribes:**

1. ~~**Stale yt-dlp.**~~ ✅ **TESTED AND FALSIFIED, 2026-11-10.** It was genuinely stale — `pip show yt-dlp` on the Machine returned **`Version: 2026.8.19`**, 82 days old against a 45-day threshold — and PR #170 fixed it. **It was not the cause.** Full Direct chain:

   | Step | Evidence |
   |---|---|
   | Stale pin confirmed live | `fly ssh console -a stem-loops -C "pip show yt-dlp"` → `Version: 2026.8.19` |
   | New pin pulled | `git pull` → `Updating eb28e08..f4b729c`; `grep` printed `yt-dlp==2026.10.26` |
   | New pin built in | `[deps 2/2] RUN pip install … 46.0s` — **not `CACHED`**, so the layer rebuilt. Image `deployment-01M73B599RQC17AZYYTRT7T8ME` |
   | Still fails | job `624a5288-18ae-4cc1-9f30-e9b5990c16ce` → `DOWNLOAD_BLOCKED` at stage `downloading` |

   **Three jobs, three failures, now with a fresh yt-dlp on the Machine.** The cheap hypothesis was correctly prioritised (the runbook names it first), correctly executed, and **correctly falsified.** ⚠️ Note for the next person: `constraints-prod.txt` is an **exact pin**, so a rebuild alone never updates it, and `fly deploy` builds from the **local working tree** — a deploy without `git pull` first rebuilds the old pin.
2. **No residential proxy — and by elimination this is NOW THE CAUSE, not a hypothesis.** `ytdlp_client.py:9-12`: `PROXY_URL` routes egress through a residential proxy *"instead of datacenter egress — **the cause**"*. The chain's 98%-success design figure was measured **through** such a proxy. `08-runbooks.md` §6 records **"prod has no proxy"**, and `PROXY_URL` is absent from `fly secrets list` [static 2026-11-09].

⚠️ **`PROXY_URL` is documented NOWHERE** — not in `docs/`, `.env.example`, `fly.toml` or the `Makefile`. It exists only in code. **A textbook class-6 Deployment seam**, and the reason nobody set it: nothing ever said to.

⚠️ **And the error message actively misdirects.** *"YouTube is temporarily blocking automated access for this video. Try again in a few minutes."* reads as transient and external. If the cause is a missing proxy credential, **retrying never works**, and every prior session read this as YouTube's fault.

**V3-J7 pass bar:** three different public YouTube links reach `done`. **This requires a purchasing decision from Jon** (a residential-proxy subscription), not an engineering one. **It is the single hard dependency on the critical path and it is external.**

### 12.7 V3-J5 — launch browser scope

> ⛔ **SUPERSEDED in v2.1 (2026-11-21).** The text below (desktop Chrome/Edge as launch scope) is kept as the record, not as an instruction. **Phones are the reference device**: design proposal v1.5, approved 2026-11-17, records more than half of users on phones [DP]; the phone player shipped in #278 (light 24 kHz mono decode) and #288 (phone layout). The reference viewport is 390×844 portrait, then 360×800, then desktop (user stories v4.0, Story 10). Only a browser with no Web Audio is refused. Evidence of the phone player is **emulated** (`docs/perf/mobile-player-2026-11-14.md`; review A); a real-device test of locked-screen audio, the iPhone silent switch and memory is still owed **[UNVERIFIED on real hardware]**. Live drift on 2026-11-21: the landing page still says *"Best in Chrome on a computer"*, and `llms.txt` says the app *"is built and tested in Chrome on a computer and loads lighter audio on phones"*; Phase A (A4, PR #332) rewrites the landing copy.

**Chrome and Edge, desktop.** Firefox and Safari only where measurably cheap.

- Firefox's §5.4 exclusion was a **tab-capture** constraint, and Variant Y left the launch path in v1.5 — so it does **not** exclude Firefox from the player. §3.4 lists **Firefox ≥ 130** as supporting Opus in WebCodecs: a candidate pending measurement.
- Safari stays harder: §3.4 marks Opus-in-WebCodecs **partial** on Safari ≥ 17.4 and routes it to variant S. ⚠️ **v1.6 misattributed the 3-minute cap to §3.4; it is in §3.6.** §3.4 says "> 4 min". Either way Safari needs its own lower limit — not a launch item.
- Unsupported browsers get a **feature-detected banner, never a button that fails silently**. ⚠️ v1.6 said the §5.4 copy carries over "verbatim"; it must **not** — *"Your browser does not support tab-audio capture"* is false for the player, which uses no tab capture.

### 12.9 V3-J9 — stem download requires sign-up (NEW in v1.7, decided by Jon)

> ✅ **v2.1: built.** Slice 2a (#302 `3a69c2c`, merged 2026-11-18) added the `is_demo` read branch (`lib/job-access.ts`), `/demo/<slug>` signed out, `GET /api/demos`, and the home-page live demo; a demo's cut loops get no signed URL for anyone. Verified live signed out at 13:21Z on 11-18: `/demo/lucky-ticket` 200, `/api/demos` lists 3, `/api/jobs/9c5ba587` returns 0 signed URLs and 0 R2 keys [L17 13:21Z 11-18]. `llms.txt`, the sitemap (all three `/demo/*` pages) and the Terms say so (#304 `b7c5b9f`, #305 `add22e7`; sitemap and `llms.txt` re-checked live 2026-11-21). Your own songs still need sign-in. The *"Status: decided, not yet built"* bullet below is historical.
>
> ⟲ **v2.0 (2026-11-17) — where the sign-in gate sits. DB-12 decided: option (a).**
>
> - **Demo songs play signed out; your own songs still need sign-in.** Jon, 2026-11-17: *"APPROVED - should people play the demo songs without signing in? I recommend yes, for the demos only."* [DP]
> - **The 2026-11-10 decision stands for everything else.** Jon, 2026-11-10: *"Right from the start, let's require sign in so we know who's using it"* — quoted in `apps/web/src/app/jobs/[id]/page.tsx`, which redirects a signed-out visitor to `/login` before the job renders. So the v1.7 line below, *"the core journey (§12.1) stays anonymous … A visitor can still do the whole play-along without an account"*, is **superseded**: playing your own song needs an account. Only the three demo songs (§12.11) are open.
> - **Status: decided, not yet built.** #289 (Slice 0) opens **no** read path — a demo row is still an ordinary owned job, readable by its owner only, and `test/job-access-routes.test.mjs` pins that. The signed-out demo player, the `is_demo` branch in `mayReadJob` and the page gate, and the explicit `is_demo` denial on download and loop cutting are **Slice 2** (see §11 "Open after 2026-11-17"). [#289], [DP]
> - The `.wav` download gate below is unchanged by DB-12. Demo songs **will be** denied WAV download and loop cutting to everyone but the demo system account by an explicit `is_demo` denial (Slice 2) [DP P3.1]; **today** they are denied only because they are an owned job (owner-only reads, §12.11). *(v2.0.1: the v2.0 text read "are denied … unless Jon opts in"; the opt-in referred to DB-16, which [DP] now records as not needed.)*

**Jon's decision, 2026-11-10:** *"lets require sign up"* — closing §11 **O-1**. A 3-download allowance needs an identity, hashed-IP is a rate-limit cohort and not one, so **stem download is gated behind an account.**

**This is a launch-scope change and it is the largest one in this document.** The authed path was explicitly OUT of scope in v1.5 (*"Free, no account"*, no sign-in affordance on the landing page). It is now IN.

| Consequence | Owner | Note |
|---|---|---|
| `NEXT_PUBLIC_HCAPTCHA_SITE_KEY` + `HCAPTCHA_SECRET_KEY` in Vercel | **Jon** | Confirmed **absent** 2026-11-10 by reading the env [Direct]. The hCaptcha site must be registered for `stem-loops.com` or it fails *with* keys set |
| The **matching** hCaptcha secret in **production Supabase Auth** | **Jon** | ⚠️ **Both sides, or sign-up returns HTTP 400.** This is why the staging smoke has failed `captcha_failed` three times. Setting the Vercel pair alone is **not sufficient** |
| `RESEND_API_KEY` + `RESEND_FROM` | **Jon** | Confirmed absent. Without it welcome mail is silently skipped with a warn — degraded, not fatal |
| A **redeploy** after the keys land | agent | `NEXT_PUBLIC_*` is **build-time inlined**; an env edit alone changes nothing |
| **Revert `/login` from `noindex`** | agent | PR #167 noindexed it when the authed path was out of scope. It is now **in the funnel** and must be reachable and indexable |
| **A sign-in affordance on the landing page** | agent | There is **none today** — the only links are `/`, `/history`, `/privacy`, `/terms`. A gated download with no visible way to sign in is a dead end |
| **The staging billing smoke becomes a real prerequisite again** | **Jon** dispatches | Its steps 4–8 exercise **sign-up → trial grant → entitlements → credits** — exactly this path. It has never got past step 3b (`captcha_failed`), so **this path has never been exercised by anything** |
| Reuse `trial_grants`, do not invent a counter | agent | Already one-per-user-ever with a PK on `user_id` (§6.1). The 3-download allowance maps onto it |
| Migration 013's `on_auth_user_created` trigger | — | ✅ Present and verified 2026-11-09. Without it sign-up writes `auth.users` but no `public.users` or entitlement row |

**What does NOT change:** the core journey (§12.1) stays anonymous — paste a link, get stems, play along with faders and chords. **Only the `.wav` stem *download* is gated.** A visitor can still do the whole play-along without an account; sign-up buys them files to keep.

**V3-J9 pass bar:** a throwaway account signs up, receives its entitlement row, downloads 3 `.wav` stems, and is refused the 4th with a clear upsell — then `DELETE /api/users/me` removes it cleanly (currently **Inferred from code and never executed**).

### 12.10 V3-J10 — the residential proxy (NEW in v1.7, decided by Jon: IPRoyal)

**Jon's decision, 2026-11-10:** *"lets use IPROYAL."* This closes §11 **O-2** and unblocks **V3-J7**, the launch blocker.

**IPRoyal is what the code was written for.** `ytdlp_client.py:40` carries it as the worked example (`http://user:pass@geo.iproyal.com:12321`), and `_sticky_proxy_url()` implements IPRoyal's session syntax specifically, gated on the hostname so a future vendor switch cannot silently corrupt a password with a suffix it does not understand.

**Why sticky sessions are load-bearing and not an optimisation** (`ytdlp_client.py:87-110`, found during a staging E2E test, not the bake-off): a plain IPRoyal string **rotates its exit IP per new connection**. yt-dlp makes several requests per video — webpage, player API, then the byte download — and **the signed `googlevideo.com` media URL it receives is itself IP-bound.** If the byte fetch lands on a different rotated IP than the one that resolved the URL, it **403s** even though both went through the same account. Observed live: extraction succeeded, the very next request 403'd, every time.

The fix is already implemented: a **fresh random 8-character session id per fetch attempt**, appended as `_session-<id>_lifetime-2m`, so all of one attempt's requests share one IP while a **retry deliberately gets a new IP** rather than re-trying a bad one.

> ⚠️ **Therefore `PROXY_URL` must be set to the PLAIN credentials with NO session suffix.** The worker appends `_session-…_lifetime-2m` itself. A value that already contains a session parameter would be **double-suffixed and malformed**. This is the single most likely way to configure it wrongly.

**Configuration:**

| Item | Value |
|---|---|
| Secret | `PROXY_URL` on the **Fly worker** (`stem-loops`) — **not** Vercel; only the worker fetches |
| Format | `http://<user>:<pass>@geo.iproyal.com:12321` |
| Port | **12321** is the username/password endpoint. `geo.iproyal.com` ports 11200+ are the **IP-whitelist** endpoints and are the wrong ones here |
| Session suffix | **Do not add one.** The worker generates it per attempt |
| Timeout | automatic — `TIMEOUT = 10 if not PROXY_URL else 30` (`ytdlp_client.py:44`), because the R2 spike measured p50 ~4.5 s / p90 ~10–13 s / outliers ~26 s through the proxy, and 20 s produced false `DOWNLOAD_TIMEOUT`s |
| Vendor lock | none — the sticky-session syntax is applied **only** when the host contains `iproyal.com` |

**Cost, sized rather than guessed.** yt-dlp runs `-x --audio-format wav`, so the **network** transfer is the compressed source stream (the WAV conversion is local, after download). A 5-minute track at ~128 kbps is **≈5 MB**, plus webpage/player-API overhead and the `--simulate` live-check: call it **~6 MB per successful fetch**. `YTDLP_MAX_ATTEMPTS=2` means a retry roughly doubles a failed job's cost, so budget **~10 MB/job**.

- **1 GB ≈ 100–170 YouTube jobs.**
- IPRoyal residential pay-as-you-go starts around **$7/GB**, cheaper at volume, and **PAYG traffic does not expire** [third-party review, 2026 — confirm on IPRoyal's own pricing page before buying].
- **So the single hard blocker on the launch path costs on the order of $7**, and 1 GB plausibly covers months at pre-revenue volume.

**V3-J10 pass bar:** `PROXY_URL` set on Fly, worker redeployed, and **three different public YouTube links reach `done`** — which is also V3-J7's bar. ⚠️ **Watch the first runs for `402`/`407` in fetch logs**: `08-runbooks.md` §6 maps those to *"proxy balance/credential"*, so they mean the proxy is reachable but the account is out of funds or the credentials are wrong — **a different failure from `DOWNLOAD_BLOCKED`, and good news, because it proves the proxy is in the path.**

### 12.8 V3-J8 — the 2026-12-05 validation deadline

The Klangio Startup subscription cancels **2026-12-05** — v1.4's documented hard cap, working as designed. **Chords stop that day** unless it is kept, `autochord` is implemented, or ChordNet training is resourced (dataset is a random-label placeholder, R-4). Jon, 2026-11-10: *"we have to validate this product before THEN."* **V3-J1 must be validated by Jon's own use before that date.**

> ⟲ **v2.1 (2026-11-21) — DB-17 / O-3 is now DR-D1, and Jon DEFERRED it** until after the Phase A design fixes. A decision brief is scheduled for **2026-11-28** (scheduled task `trig_01VC6B96dym36jC7TyHkE3KP`, 10:12 PT) [L17 14:02Z 11-21]. **The Klangio subscription still ends 2026-12-05**, so the brief leaves one week. Klangio remains the only chord provider in code (`chord_source.py`: `replicate` and `internal` raise `NotImplementedError`) [DR review C]. Recorded alongside: **MJC-D1** *"Klangio A+C now, B roadmap"* (B = late-result backfill, issue #323; its default window of 24 h is Jon's *"let's guess"* of 2026-11-20 [L17 01:44Z 11-21], not MJC-D1); **MJC-D9** keep the Klangio poll deadline at **120 s** (#317 `15c290f`, 600 → 120 s), raising it to 180 s only if healthy tracks time out (watch Sentry STEM-LOOPS-E) [MJC]. The copy switch `CHORDS_LINE_SHOWN` is still a compile-time constant; Phase A (A4) makes it a runtime switch [L17 14:02Z 11-21].
>
> ⟲ **v2.0 (2026-11-17) — DB-17 (the design proposal's name for §11 O-3) is still OPEN.** Jon, 2026-11-17: *"LETS WAIT AND SEE"*. **So, unless it is decided, chords stop for every new song on 2026-12-05.** [DP] (The design processes the three demo songs before that date for exactly this reason, so their chords exist whatever is decided [DP §1 Slice 0].)
>
> The options, as the design proposal lays them out (kept here so the decision can be taken without re-deriving them):
>
> | Option | For | Against |
> |---|---|---|
> | **(a) Keep Klangio past 12-05** for a fixed period | Nothing breaks; known quality | **$99.99/month** (API Monthly — Startup); reverses v1.4's "hard cap, one billing cycle" decision, deliberately |
> | **(b) Implement `autochord`** | No subscription | GPL-licensed; not in `chord_source.py`'s closed provider set; needs an OS-level VAMP plugin in the worker image; quality vs Klangio unmeasured. **Not realistic by 12-05** |
> | **(c) ChordNet training** | Ours | Not resourced; the dataset is a placeholder |
> | **(d) Let chords stop for new songs** | No cost | The no-chords state (§12.12) becomes the main state |
>
> The proposal's recommendation (not a decision): **(a) for a fixed period with (b) built alongside**, switch when (b) agrees with Klangio on ≥ 85% of beats over a fixed 20-song set and Jon rates it usable; hard end date for (a) **2027-03-05**. [DP DB-17]
>
> **What already handles the cliff:** the player's no-chords state ships in #288 (§12.12). **Copy:** the design requires any copy that promises chords to change the same day chords stop — the P7 capabilities block's Chords line and the P4.1 home-page line (Slice 1b / Slice 2) [DP P4.1, P7].

### 12.11 Demo songs and retention: `jobs.is_demo` (NEW in v2.0, shipped in #289)

> ⟲ **v2.1:** the demos **are** shared signed out since #302 (§12.9); the future tense below is historical. The key-detection cause was the drums reference stem; #295 (`f7f3350`) detects the key from all stems, deployed with the worker at `3a69c2c` (Actions run 44346791884, 2026-11-18) [L17 06:58Z, 16:25Z 11-18]. Residue QA-10 (drums-only usable → key should be NULL) is open. The demo static export: **[UNVERIFIED]** — no ledger row after 2026-11-18 records it done.

**What it is for.** Three of Jon's own recordings — *Lucky Ticket*, *I'm Asking You*, *Offline* (The Royal Sundowners) — are the demo songs: processed once through the real pipeline, and **will be** shared by everyone (Slice 2), never copied per account [DP P3.1]. **Today** they are ordinary owned jobs, readable by the demo system account only. They must survive the retention sweep. Migration **`040_v3_jobs_is_demo.sql`** (+ `down/040_v3_jobs_is_demo_down.sql`) adds:

```sql
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
```

No grant or policy is added: `public.jobs` is backend-only (RLS on; only `stemloops_app_all` and `cowork_ro_read`), so `anon`/`authenticated` cannot read or write the column. [#289]

| Rule | As shipped | Where |
|---|---|---|
| **Retained until** | A demo row's retained-until is **`'2099-12-31T00:00:00Z'::timestamptz`** — the rule is wrapped as `(CASE WHEN jobs.is_demo THEN '2099-12-31T00:00:00Z'::timestamptz ELSE GREATEST(...) END)`. Constant `DEMO_RETAINED_UNTIL` in both copies; `isDemoRow()` in TS | `retention.ts` `JOB_RETAINED_UNTIL_SQL`, `cleanup.py` `RETAINED_UNTIL_SQL` |
| **Finite, not `'infinity'` — why** | node-pg turns `infinity` into the number `Infinity`; `new Date(Infinity)` is NaN; `lib/library.ts` drops rows with a non-finite expiry; and the stems and download routes deliberately fail closed on NaN to **1-second** signed URLs, which would break demo playback. With a finite date every expiry path works unchanged (stems 900 s; `presignTtlSec` 24 h cap). Consequence, accepted: in principle demos are eventually swept | migration 040 header; [#289] residue 4; mutant `demo_retained_until_infinity` KILLED |
| **Excluded from the sweep** | The same `CASE` in **both** copies, so the worker's sweep never selects a demo row. The two copies stay identical, pinned by `test_paid_retention.py` (real Postgres) | `retention.ts`, `cleanup.py`; mutant `demo_branch_removed_from_sweep_rule` KILLED |
| **"Deleted in …" hidden** | Hidden for `is_demo` on the player, library and `/history` rows — otherwise a demo would read "deleted in ~27,000 days" **Not hidden on `/loops`** (LoopsView "loops close in …"): accepted residue #289-2, visible only to the demo account until Slice 2 | `JobView.tsx` (`songInfoLines` after #288), `history/page.tsx`, `lib/library.ts`; [#289] residue 2 |
| **Account deletion clears it** | `DELETE /api/users/me` sets `is_demo = false` in the same UPDATE that expires the user's jobs (`WHERE … AND (expires_at > created_at OR is_demo)`). This is the **only** application write to `is_demo`, and it only ever writes `false` | `users/me` route; `test_account_deletion_statement_ends_a_demo` (real PG) |
| **Operator rule** | **Never delete the demo account from the Supabase Dashboard; use the app's account deletion.** Deleting it outside the app (Dashboard → Authentication → Users → Delete, or `auth.admin.deleteUser`, or a manual SQL change to `user_id`) runs `ON DELETE SET NULL` on `jobs.user_id` **without** clearing `is_demo`, leaving the demos retained until 2099 **and** anonymous. Closed for good only by Slice 2's explicit `is_demo` denial on download and loops, which must ship before or with publishing the demo ids | migration 040 header; [#289] residue 1 |
| **Who sets it** | **Only a Jon-approved, guarded named write.** No application code writes `is_demo = true`; the `POST /api/jobs` INSERT does not name it | migration 040 header |

The guarded write (from migration 040's header; **expect `UPDATE 3`, anything else: ROLLBACK and investigate**):

```sql
UPDATE public.jobs SET is_demo = true
 WHERE id IN ('<id1>','<id2>','<id3>')
   AND user_id = '<demo-system-account-uuid>'   -- never a personal account
   AND status = 'done'
   AND client_ip_hash <> 'purged'               -- never an anonymised shell
   AND expires_at > now();                      -- never resurrect a swept-due row
```

**Ownership.** Demo songs are owned by a **dedicated demo system account**, not Jon's personal account, because account deletion sets `user_id` to NULL [DP P3.1].

**Rights (DB-16).** Jon, 2026-11-17 18:23 PT, verbatim: *"NOT NEEDED. I MADE ALL THE MUSIC WE HAVE RIGHTS"* [DP]. Jon states he made all the music and that "we have rights"; no further consents were sought. Recorded in **`docs/legal/demo-songs-rights.md`** (#289; its paraphrase "holds all rights" was replaced by the verbatim quote in v2.0.1). This replaces the design's original DB-16 ask (written consent from every rights holder).

**Deploy status** (v2.0.1: rewritten; the v2.0 [U] bullets were already stale when #291 merged at 2026-11-18 04:55Z).
- Migration 040 **is applied in prod**; the worker was redeployed at `f29bf17` (Actions run **44236315618**, "Deploy Worker to Fly.io" success 2026-11-18 04:18Z) [DP], [GH]. So the deployed sweep honours `is_demo`.
- **Demos processed and flagged.** The three demo songs were processed in prod under the dedicated demo account: jobs **`9c5ba587`** = *Lucky Ticket*, **`32f99278`** = *I'm Asking You*, **`3d43d743`** = *Offline*. The guarded write (Jon: "approve demo flag") ran at **2026-11-18 04:47Z** and flagged them `is_demo`; a separate SELECT verified retained-until **2099-12-31**. This was after the worker redeploy (04:18Z), so the deployed sweep honours the flag. [LEDGER-17; verified against prod by the orchestrator]
- **Staging is fully caught up (done 2026-11-18).** Verified by the orchestrator with read-only SELECTs at 05:08Z: `public._migrations` has **38 rows** (001–040, minus 010 and 036, which do not exist); 009, 011, 012 and 013–040 were applied on 2026-11-18 (staging previously had 001–008) under Jon's approvals (catch-up approved 2026-11-17 21:39 PT; then *"a now"* / *"do it yourself"*); 004 was recorded as pre-applied after verifying its effects were already present. `jobs.is_demo` is `NOT NULL DEFAULT false`; `jobs.klangio_job_id`, `chord_edits`, `klangio_usage`, `loop_requests` and the 024 index are present; RLS on `jobs` is on. `plans` match prod (free 0 / 5, pro 499 / 50, studio 1200 / 150 with `export_stems`; `plans.services` = `{youtube}` on free, pro and studio, as in prod (migrations 034, 039)). Staging has 0 jobs and 0 users. Migrations **004** (bare `ADD CONSTRAINT jobs_input_source_chk`) and **026** (9 unguarded `ADD CONSTRAINT`s) are **not re-run-safe**, despite the migrations README's claim that every migration is idempotent; a fix PR is planned (§11).
- **R2 lifecycle: none.** Jon, checking the bucket in Cloudflare: *"There are no object lifecycle rules defined for this bucket."* So the old whole-bucket `expire-ephemeral-job-io` 2-day rule is not active. It would come back only if `apps/worker/scripts/configure_r2_lifecycle.py` were re-run with `R2_LIFECYCLE_EXPIRE_DAYS` set.
- **Static export: not done (outstanding).** [DP] §1 Slice 0 step (2) requires exporting the three demos' stems, chords and sections to the static demo host right after processing — a second copy that no sweep touches. It has not been done.
- **Key detection was wrong on all three demos.** The prod pipeline wrote `jobs.musical_key` **G minor** (Lucky Ticket), **B minor** (I'm Asking You) and **C♯ major** (Offline); Jon's confirmed keys are **A major / A minor / G major**. BPM matched (102 / 128 / 95). The same detector run on the source files before upload gave the confirmed keys (LEDGER-17 22:49Z), so the prod pipeline diverges; the cause is not yet diagnosed. There is **no key-override feature**: `musical_key` is written only by `pipeline.py`. After Jon's named approval (*"approve demo keys"*, 2026-11-17 21:56 PT) the orchestrator corrected the three demo rows with a **Jon-approved named `UPDATE public.jobs SET musical_key = … WHERE id = … AND is_demo`** to A major, A minor and G major, and verified them. A **key-detection bug investigation** (PR in progress, §11) covers every user's song, not only the demos: the header shows `<BPM> BPM · <key>` on every song, and ⋯ → Song info already says *"Tempo and key are detected automatically and can be off."*

### 12.12 The play-along player as shipped (Slice 1a, #288) (NEW in v2.0)

> ⟲ **v2.1 (2026-11-21) — what changed since #288, and what Phase A will supersede.**
> - **Shipped since:** the "See all chords" chart and editor use guitarist notation (#294 `18d84b5`, so P1.5 is met); the player clock stays right when a repeating loop changes (#296 `ee29c40`); with the loop off, tapping a section loops just that section (#303 `0f7ee6b`, Jon's QA C-10 decision, superseding the "tap outside the run extends it" rule when no loop is on); every chord tap target is ≥ 24 px on phones, in the chart sheet and on tablet/desktop (#312 `18119dd`, #324 `337a3ab`, #326 `8d490c6`); landscape, library states and iOS audio session fixes (#301 `48e38d4`); "Song library" label (#316 `d75b4f4`).
> - **Known defects found by the design review [DR]:** the chord-change popover is a dead control (`ChordOverlay.tsx` `onChordEdit` not wired, issue #135); on the Lucky Ticket demo 87 of 201 chord segments are shorter than one beat, so the stage drops to sequence mode with no beat countdown; "Chorus" is an energy guess over 4-bar loop slices, leaving about 55% of the song in no section; section colours are gone; turning your part down takes 2–3 taps behind a modal sheet that hides the chords.
> - **Superseded when Phase A merges** (⟲ v2.2: **superseded — Phase A merged**: #330 `4682594`, #332 `4bed0a6`, #331 `5717bb3`, #333 `fdf4aae`; see §12.16.1. v2.1 text: PRs opened 2026-11-21 15:07–15:20Z, in review [L17 15:43Z]): **DR-D4** a section tap **jumps and plays**, a long-press loops (replaces the P2.1 tap rules below); **DR-D5** my-part stem pills on the play screen, and the Mix sheet becomes **half-height and non-modal** (replaces "a modal bottom sheet"); **DR-D6** Simple chords by default, display layer only; **DR-D2** neutral section names. See §12.15 and V3-PS1…PS6 in §9.
> - **DB-13 (a) "Mute my part" (ask the part once) is kept**, not replaced: DR-D5's pills act on any stem directly, and #331 adds a "Solo my part" preset that uses the same remembered part (PR #331 title). The pills do not remove the ask-once flow (⟲ v2.2: #331 merged `5717bb3`; whether the ask-once flow is untouched is still not re-verified on `fdf4aae` **[UNVERIFIED]**).

Built from the approved design (P1.1–P1.5, P2.1) and Jon's approved mockups. P1 was approved via the mockups (16:55 PT) and the whole work plan (19:05 PT), not as a separate P1 decision [DP]. This is what `/jobs/[id]` does on `v3/main` at `f29bf17`. [#288]

**P1 — layout.**
- One fixed **`100svh`** screen that does not scroll when it fits: compact header (back · song title as the h1 · `<BPM> BPM · <key>` · ⋯) → chord stage → section strip → seek line → transport (−5 · Play/Pause · +5 · Loop · Mix). When it cannot fit (e.g. 400% zoom), it scrolls rather than clip (WCAG 1.4.10).
- **One notice bar** at the top of the stage (error > degraded > loading > hint), keeping `role=alert` / `role=status`. `viewportFit: 'cover'` on the `app/jobs/[id]` segment only. The site nav is hidden while the player is mounted.
- **Chord stage:** Now/Next on the fit ladder 72→64→56→44→40→36→32→28 px (larger starts when the stage has room), then a slash-bass second line, then Next below; beat row; two bar lines; `aria-current`; **no `aria-live`**.
- **Widths:** ≥ 1024 wide (and ≥ 500 tall): two columns with the mixer always visible. 560–1023: the phone layout, centred. Short landscape (height < 500, width ≥ 560): two columns. Jon, 2026-11-17: portrait-only use, no rotation needed [DP].
- **Wake Lock** held while playing, released on pause; feature-detected.
- **Back link:** "Back to song library" (`/history`) signed in (was "Back to library" until #316), "Back to home" (`/`) signed out.

**P2.1 — runs of sections (DB-14 (a), adjacent runs now).** A loop is **no loop** or a **run** of adjacent sections *i..j*. Tap outside the run extends it; tap inside a 2+ run shrinks it to that chip; tap the only chip clears it; long-press (500 ms, cancels on move, swallows its release click) loops only that chip. The Loop button has three states: on, off with a run remembered, and disabled "Tap a section to loop it". "Looping" is shown only while the engine's loop equals the run. `tapSection` / `longPressSection` / `toggleRunLoop` / `runRegion` in `lib/play/sections.ts`; `nextLoop` removed. Non-adjacent runs wait (DB-14).

**P1.3 — the Mix sheet and presets.**
- A modal bottom sheet (`role=dialog`, `aria-modal`, focus trap; Escape / Close / backdrop / swipe-down; focus returns to Mix); a right-side panel on short landscape screens. The header shows the live Now/Next chords and play/pause. Six stem rows with M · S · slider.
- **Presets** (`lib/play/presets.ts`): **Mute my part · Full song · No vocals · Drums + bass**. A preset sets mutes; any later mute, solo or slider change relabels the selection **"Custom"**.
- **DB-13 (a):** the first tap on **Mute my part** asks *"Which part do you play?"* — Guitar (pre-selected) · Bass · Keys · Drums · Vocals — and remembers the answer in `localStorage`. Jon took the recommendation under the approved plan [DP].

**No-chords state.** When a song has no chords, the stage shows the current **section name** large, **`bar n / N · beat b`**, the line *"No chords for this song."*, and the presets. This is the state every new song reaches after 2026-12-05 if DB-17 (§12.8) is not decided. Accepted residue: its beat count runs from the section start, while the chord stage's bars use the chord-derived downbeat, so the two can differ by a beat.

**BPM and key.** The header shows BPM from **`jobs.bpm`** (rounded) and the key from **`jobs.musical_key`**, each hidden when null, with a screen-reader "Detected: " prefix. ⋯ → Song info says *"Tempo and key are detected automatically and can be off."* Jon asked for BPM + key on 2026-11-17 [DP]. `GET /api/jobs/[id]` selects both columns.
- **Known issue (v2.0.1): key display is shipped, but the detected key is currently unreliable.** Prod key detection was wrong on 3/3 demo songs (§12.11); the demo rows were corrected by a Jon-approved named write, but every other song still shows the detector's key. See the key-detection bug investigation in §11.

**`--chord-now` token.** `--chord-now: #f59e0b` (Amber Gold), declared once in `design-tokens.css` section 1. **One job:** the current chord at the playhead — the big Now chord, the current bar's edge and chord text, and the Mix-sheet header chord; it stays amber while paused. Never a button, link, selected/pressed state, progress, status or decoration, and **never on the same view as `--status-expiry` `#fb923c`** (colour-blind confusion); `--status-expiry` does not appear on `/jobs/[id]`. Pinned by `test/brand-tokens.test.mjs` (declaration, one job, contrast ≥ 7:1, expiry guard). Jon, 2026-11-17 16:55 PT. [BB2.3-A1], [#288]
- Selected/pressed states are neutral everywhere (#222 fill, 2 px #fff edge), including the mixer's M/S; lime fills only Play [BB2.3-A3]. Section chips are 22 px pills (Jon 19:05 PT) [BB2.3-A2].

**One display formatter.** **`lib/play/notation.ts`** formats **chords and keys**: guitarist notation (`C`, `Am7`, `G7`, `C/E`); ♭/♯ glyphs on screen and "flat"/"sharp" in aria-labels; flats where conventional (B♭ major, not A♯ major). Stored data is unchanged (Harte labels). [BB2.3-A4], [#288]
- **Partly met:** the stage, the Mix header and the key use it. The **"See all chords" chart and the chord editor still show Harte labels** (`C:maj`, `A:min7`) because switching them breaks the #212 geometry gates; that is the chart-notation PR (§11). The chart is in its own sheet, so the two notations never share a screen. [#288]
- Accepted residue (S4, WCAG 2.5.3): chord buttons are named in words ("A minor 7 — edit") while the visible text is "Am7". [#288]

**Not in Slice 1a** (deferred in #288): desktop seek-line drag handles (custom range), the strip-edge "+2 →" badge, the iOS silent-switch hint, "Add to playlist" (Slice 3), artist/uploader in the subtitle (no column until P5). Browser journeys j1/j7/j8 were updated but not run (advisory job).

### 12.13 The pricing page as shipped (P6, #287) (NEW in v2.0)

No price or plan change (DB-15 (a), Jon 2026-11-17 [DP]); this is presentation only. [#287]

| Item | As shipped |
|---|---|
| **Indexable** | `robots: { index: false, follow: false }` removed. `/pricing` is in the page registry (`lib/seo/pages.ts`), so it is in `sitemap.xml` and `llms.txt`; metadata via `app/pricing/layout.tsx`. Pinned by `test/pricing-indexable.test.mjs` |
| **In the nav** | "Pricing" → `/pricing` in the top nav on every page, signed in and signed out (`SignedInNav.tsx`), `aria-current` on `/pricing` |
| **CAD everywhere** | Every price ends in " CAD", **including Free ("$0 CAD")**; plans and packs share one formatter |
| **Retention wording** | Once per card, word for word from **`RETENTION_BULLET`** (`apps/web/src/lib/pricing-copy.ts`): Free *"Songs deleted after 24 hours"*; Pro and Studio *"Song library: kept while you subscribe, plus 30 days"* |
| Cards | Mobile-first (one column on phones, three from 900 px); each opens with `benefitLine()` from `monthly_job_quota` ("50 songs a month"); Pro highlighted with no "Recommended"/"Most popular" text; no annual price (none exists in any migration); no "Coming soon" block |
| Lime | Signed out: one lime action (Get Pro). **Signed in: the three "Buy credits" buttons are still lime**, hard-coded in `BillingButton.tsx`, which #287 could not edit — the **[billing] quiet credit buttons** PR (§11) [BB2.3-A3] |

### 12.14 Deploy facts (NEW in v2.0 — verified 2026-11-17)

| What | How it reaches production | Evidence |
|---|---|---|
| **Web app** (`apps/web`) | **Auto-deploys on merge to `v3/main`.** Observed (from the Deployments API, not read from Vercel project settings): Vercel's Git integration on `stem-loops-web` treats `v3/main` as its production branch; `vercel[bot]` creates a "Production – stem-loops-web" deployment for each merge commit | [GH] Deployments API: `f29bf17` → environment *"Production – stem-loops-web"*, creator `vercel[bot]`, 2026-11-18T03:30:47Z (one minute after #288 merged); [#289] |
| **Migrations** | **Manual.** Nothing applies them on merge — `ci.yml` migrates only its own throwaway containers. Supabase SQL editor (then `INSERT INTO public._migrations(filename) …`) or `make migrate` with the prod `DATABASE_URL`. **Never** the Supabase connector's `apply_migration`, which writes to the wrong ledger. A migration a web change depends on must be applied **before** the merge, because the merge deploys the web | [#289], migration 040 header |
| **Worker** (`apps/worker`, Fly) | **Manual.** GitHub Actions → **Deploy** (`deploy.yml`, `workflow_dispatch` only) → target **`worker`**, ref `v3/main`. `fly.toml` has no `release_command` | [GH] Deploy run **44236315618** at `f29bf17`, created 2026-11-18T04:17:39Z: "Deploy Worker to Fly.io" success, "Deploy Web to Vercel" skipped; [#289] |

- `deploy.yml` also offers `web` and `all` targets (`vercel deploy --prod`). They still exist; the normal web path is the merge.
- **No line in v1.10 said the web app deploys manually**, so none needed a strike-through. Lines that remain correct alongside this: §12.9's *"a redeploy after the keys land"* (an env edit alone changes nothing, since `NEXT_PUBLIC_*` is build-time inlined — a merge or a manual redeploy both satisfy it), and §8.2's (and §11 O-4's) *"rollback is promote-previous-deployment"*. §12.6's note that *"`fly deploy` builds from the local working tree"* describes a deploy run from Jon's machine; the Deploy workflow builds from the checked-out ref (`flyctl deploy --remote-only`).

---

### 12.15 Product evolution, 2026-11-17 → 2026-11-21 (NEW in v2.1)

**What the product is now.** A **phone-first play-along**: paste a YouTube link on a phone, then play along with the chords going by, the BPM and key shown, sections to jump to or loop, and your own part turned down or soloed. **Download loops** (the original stem-loops product) is a **secondary** product on its own page (`/loops`), for about 5% of users. Sources: design proposal v1.5, approved by Jon on 2026-11-17 (more than half of users on phones; about 95% want to play along) [DP]; Jon's primary user story, 2026-11-20 21:21 PT [DR]. The PRD half of this document follows from that: the user stories that define the product are **v4.0, APPROVED by Jon on 2026-11-21 as written** [Jon 11-21b], built on Jon's story; they **replace v3.1** (2026-11-14), which stays in the Claude Project as history.

#### 12.15.1 Slice outcomes (design proposal v1.5)

| Slice | Scope | Outcome | Evidence |
|---|---|---|---|
| P6 pricing | `/pricing` indexable, in nav, CAD, mobile cards | Shipped | #287 `9aeae03` |
| 0 | `jobs.is_demo`, demo retention to 2099-12-31 | Shipped; migration 040 applied prod 2026-11-18 02:08Z; demos flagged 04:47Z | #289 `cbe5b16`; [L17 02:08Z, 04:48Z 11-18] |
| 1a | Phone player: one-screen layout, Mix sheet + presets, section runs, `--chord-now`, BPM/key | Shipped; worker deployed run 44236315618 | #288 `f29bf17` |
| 1b | Copy true-today, titles + thumbnails for new songs, sign-up fixes | Shipped | #290 `4351160` |
| 2a | Demo songs play signed out; home-page live demo; "Library" rename | Shipped; verified live 2026-11-18 13:21Z | #302 `3a69c2c` |
| 2 (rest) | Claim-on-sign-in redesign (P3.2) | **[UNVERIFIED]** — not in #302; no later PR found | — |
| 3 | Playlists, section rename | Not built; replaced by design-review Phases B/C (§12.15.6) | — |

#### 12.15.2 Billing and money safety (shipped)

All `[billing]` PRs merged only on Jon's named approval and an independent review ≥ 90 [L17].

| What | PR |
|---|---|
| Credit-pack buttons quiet (one lime action per view) | #292 `6c95fcb` |
| Refund jobs we fail or abandon; per-job deadline; no refund for over-length uploads (Jon) | #297 `4cf820c` |
| Stripe webhook applies the current subscription state under a per-subscription lock; price from line items | #298 `a356fc6` |
| Proxy failures are ours: fail fast, honest copy, Sentry, fetch canary | #307 `9965f5c` |
| Our-fault link failures give the monthly song back (+ migration 042) | #308 `3ec00e1` |
| Server refuses a second plan checkout while a subscription is live | #310 `1fe5edc` |
| Proxy-check hysteresis + total deadline, redaction, restore isolation | #313 `e209a38` |
| Account deletion cancels paused and incomplete subscriptions | #314 `8aa3064` |
| Account deletion closes open Checkout Sessions; webhook cancels + refunds subscriptions of deleted users (proof-gated) | #325 `45d39df` |

Deferred by Jon: Stripe restricted-key permissions until 5 users (until then, deleting an account that has a Stripe customer may 502 with an alert) [L17 01:44Z 11-21]. Open residue: QA-69 (#310), QA-81 (#325).

#### 12.15.3 Demo songs are public

*Lucky Ticket*, *I'm Asking You*, *Offline* (The Royal Sundowners; rights: DB-16) open signed out at `/demo/<slug>` (#302), are in the sitemap and `llms.txt` (#304 `b7c5b9f`), and the Terms, Privacy, FAQ and home say so (#305 `add22e7`). Keys corrected by a Jon-approved named write to A major / A minor / G major [L17 04:57Z 11-18].

#### 12.15.4 Operations and reliability

| What | Evidence |
|---|---|
| Security hardening: `_migrations` RLS (migration **041**, applied prod + staging 2026-11-18 18:01Z), Next image optimiser off, anonymous caps with advisory locks, same-origin guard, worker input allow-lists | #300 `d212bcc`; [L17 18:02Z 11-18] |
| Orphan-sweep safety brake + missing-song-file alerts (QA-57, QA-59) | #306 `6bbb992`. **The QA log still lists QA-57 and QA-59 as OPEN** (statuses at 2026-11-21 04:40Z): #306 is the code half; the deleter's root cause and full alerting are not recorded as closed |
| Drain the current job on restart; web deploy pnpm fix | #309 `f2d076d` (V3-OP3) |
| Flaky process-group test fixed | #328 `4419080` |
| **Allowance restore live end to end:** migration **042** applied by Jon in the SQL editor; verified staging + prod: 40 `_migrations` rows, last `042_v3_job_allowance_debits.sql`, RLS on, `stemloops_app` EXECUTE true, `anon` EXECUTE false | [L17 04:01Z 11-21] (V3-OP1) |
| **First-byte stall cut:** `ms_first_byte` recorded; non-final stalled attempts cut at 15 s | #327 `ddf1a18`; worker run 44861295141 success (V3-OP2) |
| **Klangio poll deadline 600 s → 120 s** (MJC-D9: raise to 180 s only if healthy tracks time out) | #317 `15c290f`; worker run 44826467472 |
| Vercel Web Analytics on (Jon enabled 2026-11-20) | #315 `3924078`; [L17 01:44Z 11-21] |
| R2 credential incident 2026-11-19 ~03:08–03:50Z (web playback only): restored by Jon setting the Production R2 key rows and redeploying | [L17 03:34Z–03:50Z 11-19] |

**State on 2026-11-21 ~14:05Z [GH]:** `v3/main` = `8d490c6` (#326); web production deployment of `8d490c6` success 04:25Z; worker last deployed at `ddf1a18` (run 44861295141), and no `apps/worker` file changed between `ddf1a18` and `8d490c6`; worker `/health` ok, fetch canary ok; DB migration level **042** (prod and staging); open PRs: **0** at 14:05Z (this PR, #329, was opened at 14:08Z as a draft; Phase A #330–#333 opened 15:07–15:20Z); open issues #318, #319, #321, #322, #323, #286, #143, #135.

#### 12.15.5 Jon's decisions (carried)

| ID | Decision | Date / source |
|---|---|---|
| DB-12 (a) | Demo songs play signed out; own songs need sign-in | 2026-11-17 [DP]; built #302 |
| DB-13 (a) | "Mute my part" asks which part once (Guitar pre-selected) | 2026-11-17 [DP]; #288 |
| DB-14 (a) | Adjacent section runs now; non-adjacent only if asked | 2026-11-17 [DP]; #288 |
| DB-15 (a) | Prices unchanged. ~~Playlists Pro-only~~ **superseded 2026-11-21: set lists Free + Pro** | 2026-11-17 [DP]; superseded by [Jon 11-21b] |
| DB-16 | Rights: *"NOT NEEDED. I MADE ALL THE MUSIC WE HAVE RIGHTS"* | 2026-11-17 18:23 PT; `docs/legal/demo-songs-rights.md` |
| DB-17 | Chords after 2026-12-05 → now DR-D1, deferred | see below |
| MJC-D1 | Klangio A+C now, B (late-result backfill, #323) on the roadmap | 2026-11-20 [MJC] |
| MJC-D5 | #320 (first-byte stall) before #321 (Try again) | 2026-11-20 [MJC]; #327 shipped |
| MJC-D6 | Queued-stall notice stays at 90 min (`job-poll.ts` comment still stale: QA-79) | 2026-11-20 [MJC] |
| MJC-D7 | "Try again" capped at 2 (#321) | 2026-11-20 [MJC] |
| MJC-D8 | Set lists: a "Demo set" that must never delete; Free plan allowed (#322). Plan conflict with DB-15 (a) **resolved by Jon: Free + Pro** | 2026-11-20 [MJC]; [Jon 11-21b] |
| MJC-D9 | Klangio poll 120 s; 180 s only if healthy tracks time out | 2026-11-20 [MJC]; #317 |
| MJC-D2/D3/D4 | Process decisions (scheduled-task retry moot; do items in that session; attach repo) | 2026-11-20 [MJC] |
| — | "I APPROVE ALL MERGES" | 2026-11-20 14:03 box clock [MJC] |
| — | Stripe key permissions deferred until 5 users; system account deferred until 5 beta users; hCaptcha Pro lapsed, revisit at 10 users (DB-5) | [L17 01:44Z 11-21], [L17 16:45Z 11-18], [L17 17:00Z 11-17] |
| — | Vercel Web Analytics on | 2026-11-20 [L17 01:44Z 11-21] |
| **DR-D1** | **Chords after 2026-12-05: DEFERRED until after the design fixes; brief 2026-11-28; subscription ends 2026-12-05** | Jon 2026-11-21 [L17 13:58Z] |
| **DR-D2 A** | Neutral section names ("Part 1", "Part 2" + time); rename later | Jon 2026-11-21 |
| **DR-D3 A** | Keep the library row after the audio expires; ~~free Re-make~~ ⟲ v2.2: **a Re-make uses one monthly or trial song; an our-fault failure returns it** (PB-2 amends DR-D3, Jon [L17 17:40:41Z]) (Phase B) | Jon 2026-11-21; PB-2 |
| **DR-D4 A** | Tap a section to jump and play; long-press to loop | Jon 2026-11-21 |
| **DR-D5 A** | My-part stem pills on the play screen (tap 100 → 30 → mute; long-press solo) | Jon 2026-11-21 |
| **DR-D6 A** | Simple chords by default, Detailed toggle | Jon 2026-11-21 |
| — | All design-review recommendations approved incl. merge; M2 merge automation completes **after** the design fixes; handover to a new session after Phase A merges; play-test gate when Phase A is live ("3 songs on his phone" from the approved [DR] synthesis) | Jon 2026-11-21 [L17 13:58Z]; [DR] |
| **Set lists Free + Pro** | Supersedes DB-15 (a)'s Pro-only rule | Jon, modal answer, 2026-11-21 [L17 15:43Z] |
| **User stories v4.0 approved** | Approved as written; replaces v3.1 | Jon, modal answer, 2026-11-21 [L17 15:43Z] |
| **AGENTS.md exception** | One-time: a separate PR changes only its product-description sections; Jon reviews the diff before merge | Jon, modal answer, 2026-11-21 [L17 15:43Z] |

#### 12.15.6 The design-fix plan (design review, 2026-11-21)

- **Phase A — SHIPPED (v2.2).** Started 2026-11-21 14:02Z; all four PRs merged (#330 `4682594`, #332 `4bed0a6`, #331 `5717bb3`, #333 `fdf4aae`); Jon's play-test gate passed 2026-11-22 04:48:47Z. What shipped, with review rounds, is in **§12.16.1**. *v2.1 text, kept as the record:* A1 #333 `e029395`, A2 #331 `70bd12e`, A3 #330 `5e1497d`, A4 #332 `4809dd9` were the first heads, opened 15:07–15:20Z with CI green.
- **Phase B** — ⟲ **v2.2: re-planned by the Phase B brief r4.2 and Jon's decisions (§12.16.2)**: B0 extraction, B1 library + Re-make, B2 set lists, B3 Try again (links only). Saved chord corrections (#135, ex-B4) are **removed** (Q-E); section segmentation (ex-B5) **moves to Phase C** (PB-4). *v2.1 text, kept as the record:* (2–3 weeks, after the gate): library row + Re-make (V3-LB1), set lists (V3-LB2), Try again (V3-LB3), library search (V3-LB4), saved chord corrections (#135 / review B "B1"), real section segmentation, a second chord provider if DR-D1 says so.
- **Phase C** (later): PWA share target and "ready" notifications, progressive decode, slow-down / transpose, count-in, section rename, the chord-edit flywheel.
- **Gate 2:** chord work beyond Phase A waits on DR-D1.


### 12.16 Phase A as shipped, Phase B decisions, M2 status (NEW in v2.2)

#### 12.16.1 Phase A — shipped 2026-11-21/22, play-test PASSED

Every Phase A PR merged only after an **independent** review PASS above 90 (OR-4: a PASS file the merger did not write, `behind_by` 0, CI 19 success + 2 skipped). All four were merged by `JDC000000` (GitHub `merged_by`); **0 bot merges**. No migrations. Web auto-deploys on merge; no worker change.

| PR | Scope (requirement) | What shipped | Review rounds (score) | Merged (`merged_at`, squash) |
|---|---|---|---|---|
| **#330 A3** | Sections + transport (V3-PS4, PS5) | Neutral "Part N" names + time (DR-D2); contiguous parts, a part split above **16 bars + 4-bar slack** (45 s when there is no BPM) — Jon approved [L17 17:26:31Z]; section colours **`--section-a` #8fa6c9 (slate), `--section-b` #98b59c (sage), `--section-c` #b796b5 (mauve)** — new tokens, not stem hues, Jon approved [L17 17:26:31Z], `design-tokens.css:118-120` at `fdf4aae`; tap = jump and play, hold 500 ms = loop, hold another chip extends the run (DR-D4); ⟲ back to section start; chips 44 px tall | R1 FAIL 85 [L17 16:08:06Z] → R2 **PASS 93** [L17 17:50:08Z; R330-R2] | 2026-11-21 17:59:11Z `4682594` |
| **#332 A4** | Home / link / nav / copy (V3-PS6) | Link box first with a 44 px Paste button; **sign-in before a link job starts** (the pending link is kept with a 128-bit nonce, claimed once under a Web Lock, cleared on sign-out); 3-item phone nav; phone-first copy; the **chords-claim switch** (`CHORDS_CLAIMS`, read at build — a Vercel Redeploy flips every claim surface; `CHORDS_CLAIMS_CHANGED_ON` dates /terms and /privacy) | R1 FAIL 85 / M-11 88 [L17 16:15:44Z] → R2 **PASS M-9 94 / M-11 93** [L17 18:11:52Z; R332-R2] | 2026-11-21 18:20:36Z `4bed0a6` |
| **#331 A2** | My-part pills + Mix sheet (V3-PS3) | Pills Guitar · Bass · Keys · Drums · Vocals (+ Other), each ≥ 44 px: tap 100% → 30% → muted, long-press solo; never silent; Mix sheet half-height and non-modal; **while pills show, the section strip is 1 row with a "+N more" cue, and the pills sit below the strip**; the first-run hint "Tap to jump · hold to loop" sits on the strip's top edge, above the chips and never next to the pills | R1 FAIL 84 [L17 16:43:35Z] → R2 FAIL 89 [L17 21:33:45Z, backfilled] → R3 delta **PASS 93** [R331-R2 §R3 delta; L17 22:34:35Z] | 2026-11-21 22:34:29Z `5717bb3` |
| **#333 A1** | Chord stage (V3-PS1, PS2) | **Simple chords** by default, Detailed toggle: Simple hides chords under **2 beats** (Jon [L17 21:35:02Z]), **1 s** where there is no beat grid; same-root merge; a span no chord holds for half its length shows "?" (Offline has 2 such spans); measured 24.2 / 24.5 / 23.2 changes/min on the 3 demos [L17 22:23:04Z]. **Now ≥ 72 px on every phone** (100% of 12,712 positions at 390×844, 360×800, 375×667, 390×664 [R333-R3]); Next 44 px (32 px only to keep the NEXT line); degrade order: keep Now ≥ 72; keep the NEXT line while Next can shrink (44 px growing → 44 px → 32 px, full height then squeezed); only then drop the NEXT line and retry at 44 px [R333-R3 §2]. **Neutral countdown** (#e0e0e0 lit / #737373 unlit, no amber); BPM and key 20 px; Wake Lock while visible; the dead chord editor hidden (Q-E). `ci.yml` chord-chip-browser-gate timeout 15 → 45 min (code-owned path; Jon approved) | R1 CHANGES 80 [L17 16:25:18Z] → R2 FAIL 87 [L17 23:17:38Z] → R3 delta **PASS 93** [L17 04:18:02Z 11-22; R333-R3] | 2026-11-22 04:27:39Z `fdf4aae` |

- **Live:** Vercel production deployment of `fdf4aae` [GH, created 04:28:46Z]; the orchestrator's live check (Chromium 390×844, 3 demos): HTTP 200, 0 page errors, pills, section strip, Now 120/120/72 px, no page scroll; the old "Best in Chrome on a computer" home copy is gone [L17 04:30:42Z 11-22].
- **Gate:** Jon's play-test **PASSED** 2026-11-22 04:48:47Z [L17].
- **Known follow-ups** (QA bug log QA-85…QA-90): the pending-link URL stays in `localStorage` (QA-85); the Web-Lock fallback claim token is untested (QA-86); `/privacy` does not mention the locally saved link (QA-87); windows 500–559 px tall with a notice bar still scroll (QA-88); #333 gate gaps T15 / T17 / T08b, the G05 overlap test and F06c (QA-89); the Offline "?" spans and a hint-copy idea (QA-90). Uploads still start signed out; about 5 taps to first sound (AC 1.1 partial) [L17 18:20:43Z].

#### 12.16.2 User stories v4.0.2 / v4.0.3 and Phase B decisions

**User stories v4.0.2** [US 4.0.2] are current: v4.0 approved as written [L17 15:43:55Z]; v4.0.1 wording (1.8 / 5.3: a Re-make uses one monthly or trial song and an our-fault failure returns it; 1.4 / 3.5 correction clauses DEFERRED) approved [L17 18:13:06Z]; v4.0.2 adds to 5.5 "v1 covers link songs only; a failed upload offers **Upload again** at the normal cost" (Jon, Q-F [L17 21:35:02Z]). ⟲ **v4.0.3** (2026-11-22) [US 4.0.3] updates the status column after Phase A shipped and the play-test passed, and records Jon's 2-beat Simple floor in AC 1.2 / 3.1 (~22–25 changes/min) [L17 21:35:02Z]; it is now current.

| ID | Decision (Jon unless marked) | Source |
|---|---|---|
| PB-1 | Keep Free library metadata past 24 h (link, title, BPM, key; no audio), Remove per row, deleted with the account; `/privacy` and `/terms` updated in B1 | [L17 17:40:41Z] |
| PB-2 | A Re-make **counts as a monthly song** (amends DR-D3 "free Re-make") | [L17 17:40:41Z] |
| PB-3 | Try again = free retry, cap 2, charged only if the original was refunded (no net double charge) | [L17 17:40:41Z] |
| PB-4 | Section segmentation (ex-B5) → Phase C | [L17 17:40:41Z] |
| Q-A | No outage breaker for now (waives #321 constraint 7; the cap of 2 bounds it) | [L17 18:11:52Z] |
| Q-B | Refund outage-time `DOWNLOAD_BLOCKED` at the source: its own small worker PR **after** Phase B, money path, Jon approves | [L17 18:11:52Z] |
| Q-C | The app refuses (409) to delete an account that owns `is_demo` jobs; B2 becomes `[billing]` | [L17 18:11:52Z] |
| Q-D | User stories v4.0.1 wording approved | [L17 18:13:06Z] |
| Q-E | "Fix chords" removed from the workflow for now; B4 and migration 046 dropped; #135 to the backlog | [L17 18:11:52Z, 18:13:06Z] |
| Q-F | Try again v1 = **link songs only** (was an orchestrator default until then) | [L17 21:35:02Z] |
| Q3, Q5, Q6 | Orchestrator defaults, not Jon decisions: expired upload = "Upload again" at normal cost; set-list tap counts as in B2 AC 7; the Demo set is defined in code | [PB r4.2 §5]; [L17 17:40:41Z] |

**Phase B plan (brief r4.2, ≈ 42 agent-h, wall ≈ 19–21 h)** [PB r4.2 §0, §7]. Every PR carries `needs-jon-approval`; Jon applies migrations 043–045 before the matching merge.

| PR | Scope | Migration | Requirement |
|---|---|---|---|
| **B0** `[billing]` | Extract the signed-in link-job path into `lib/jobs/create-link-job.ts`; no behaviour change; merges first | none | enabler |
| **B1** | Library keeps every song after the audio expires; Re-make (1 monthly song); Remove; title search; Recent sort; BPM · key on rows | 043 `library_entries` | V3-LB1, V3-LB4 |
| **B2** `[billing]` | Set lists for Free, Pro and Studio; a code-defined "Demo set"; the Q-C demo-account guard | 044 `set_lists`, `set_list_songs` | V3-LB2 |
| **B3** | Try again on failed **link** songs, cap 2, charge-neutral; C-1: `retried_at` written only when the INSERT returned a row | 045 `jobs.retry_of` | V3-LB3 |
| ~~B4~~ | Saved chord corrections — **removed** (Q-E) | ~~046~~ | V3-LB5 (deferred) |
| ~~B5~~ | Section segmentation — **Phase C** (PB-4) | — | — |

Brief review history: R1 FAIL 68 [L17 17:47:13Z]; R2 FAIL 86 [L17 18:02:54Z]; R3 delta PASS 92 [L17 18:11:52Z]; r4 accuracy PASS 94, r4.1 re-check PASS 95 [L17 18:24:25Z, 18:25:16Z]. Jon (2026-11-21 17:31:18Z): after Phase A, M2 and Phase B run in parallel, with no merges during the 90-minute M2 freeze.

#### 12.16.3 M2 merge automation — status at 2026-11-22 05:03Z

| Item | State | Source |
|---|---|---|
| Owner steps 1–5, §5 steps 1–3 | Done 2026-11-17 | [L17 18:21Z, 18:42Z 11-17] |
| Scope | Never money paths; class-A UI/CSS only (addendum 3.1 option b for CODEOWNERS paths) | [L17 17:14:24Z 11-21] |
| G5a | **Met on evidence** by Jon's written DB-11 override of pack l.923; stem-loops-automerge App = R metadata + R/W code and PRs only, one repo | [L17 17:14:24Z, 17:20:29Z 11-21] |
| **G5** (d7 ≥ 3 on an A-2 card) | **MET**: A-2 card 26/40, d7 = 3 Direct (#297 run 44261433560 red before review); d5 = 2, so the Level-4 gate stays shut | [A-2]; [L17 17:31:56Z] |
| **G0** | A one-time GitHub job (Jon ~17:22Z): `m2-g0-review.yml`, `workflow_dispatch` only, environment `m2-review`, `contents: read`, sends the pinned pack to gpt-5.4 and posts the score; allow-list = pack v1.4.12 only | [L17 17:59:47Z, 18:20:43Z, 18:28:46Z] |
| **Step 4 = two PRs** | **PR-4a** (G0 job + pack v1.4.12) first → Jon runs G0 → **PR-4b** (the pinned `M2-workflow.diff`) | [L17 18:13:06Z] |
| PR-4a review | R2 M-9 FAIL 89 (body) → R3 delta **PASS M-11 96 / M-9 95** on `503520a` (base `4bed0a6`) | [L17 18:25:36Z, 18:29:56Z]; `reviews/M2-STEP4A-REVIEW-R3.md` |
| **Pack v1.4.12** (to be superseded by v1.4.13, next row) | FINAL sha256 `fddf309395edce5c13e882112c5c9212c0cb72346014a308c2410fe7f1956aec`; test pin `00d2b680…` 622/622 (py3.11–3.13); legs e, f, g1, g2, g3 re-targeted after #288 removed the old Transport.tsx lines | [L17 18:11:52Z]; [M2 ws `SHA256SUMS`] |
| Re-check at `fdf4aae` | Legs e–g3: anchors ok, 131/131 web tests each, Transport.tsx unchanged; local PR-4a `ec1d8aa` and PR-4b `6aa1327` rebased byte-identical on `fdf4aae`. **BLOCKER found:** the M2 suite is **621/622** at `fdf4aae` (`test_every_class_file_exists`), because #332 deleted 3 CLASS_A files (DemoArt, PlayerArt, Lanes). Orchestrator decision: **pack v1.4.13** (CLASS_A minus 3 names, the test's 15 → 12, new `M2_PINS`, a new pinned diff; 4a/4b/step-5 re-pinned), with a delta review **before PR-4a opens**. Nothing pushed | [L17 05:03:21Z 11-22]; [M2 ws `legcheck_v1412_fdf4aae.out`] |
| Step 6 | Jon: Sunday 2026-11-22 morning | [L17 17:31:18Z, 01:35:32Z, 04:48:47Z] |
| Open for the step-4 reviewer | GitHub holds 0 reviews on merged code-owned PRs although ruleset 26478884 requires code-owner review; how bot merges satisfy it must be checked | [L17 17:31:56Z]; [A-2] |
| #143 | Closed 2026-11-21 17:31:17Z with an evidence comment (Jon approved) | [GH]; [L17 17:31:18Z] |

---

## Changelog — v1.3 → v1.4 (2026-11-04 — Y1 chord-model drift fixes + decision log entries)

Source: session 5 + 6 postmortems (TSD drift audit) + Phase-2 Y1 chord-model decision record v1.3 (`claude/phase-2-y1-chord-model-decision.md`). This amendment is **surgical**: only §5.4, §9, and this changelog are touched. No schema or route contract moves.

| § | Change | Source |
|---|---|---|
| §0 Header | v1.3 → v1.4; date 2026-11-04 | session 6 TSD drift audit |
| §5.4 chord detector bullet | Replaced the "run the Phase-2 allin1 model" phrasing with ChordNet 2E1D student (PR-Y1.4) + Klangio bridge (PR-Y1.1) per decision record v1.3. `allin1` is a structure-analysis model (beats/downbeats/sections), **not** a chord recognizer; the drafting error is corrected inline | session 5 postmortem + decision record v1.3 |
| §5.4 browser matrix bullet | **Firefox removed from the supported matrix.** `getDisplayMedia({audio:true})` silently drops audio on tab/window sources on Firefox (confirmed). New "Unsupported browsers" sub-bullet enumerates Firefox, Safari (desktop + iOS), and mobile; UX spec: feature-detect and show a "Chrome or Edge required" banner instead of a broken start button | session 6 postmortem + session-5 browser-support audit |
| §5.4 V3-Y1 pass-bar bullet | "server-side allin1" → "server-side chord-recognition provider (Klangio bridge → ChordNet 2E1D student per PR-Y1.1 / PR-Y1.4; decision record v1.3)" | session 5 postmortem + decision record v1.3 |
| §9 V3-Y1 row | Same substitution as §5.4 pass-bar bullet, and inline note that `allin1` is not a chord recognizer; wording corrected v1.4 | session 6 TSD drift audit |

**Decision log entries (2026-11-04, carrying decision record v1.3 forward into the TSD):**

- **2026-11-04 — 60-label extended alphabet.** majmin + 7ths (maj7, min7, dom7) + sus (sus2, sus4) + dim + aug. Canonical at `apps/training/model/alphabet.py` (**PR-Y1.4**). Browser mirror at `apps/web/src/chord/alphabet.ts` (**PR-Y1.5a**), generated by **PR-Y1.alphabet-sync** codegen to keep the two sides SHA-locked. Supersedes any prior "majmin-only" or alphabet-size assumption carried in earlier V3 drafts. Source: decision record v1.3 §alphabet.
- **2026-11-04 — CQT plan v1 pinned.** `sr=22050`, `hop=2048`, `fmin=32.70` Hz (C1), `n_bins=144`, `bins_per_octave=24`, log-amplitude, global z-norm. Canonical at `apps/training/model/cqt_plan.py` (**PR-Y1.3**). Browser-side parity gated by `cqt-plan.v1.json` SHA match (if the client-side CQT drifts from the training plan, the chord model silently degrades; the SHA gate is the only reliable canary). Source: decision record v1.3 §features.
- **2026-11-04 — Training compute: Modal L4** at **$0.80 / GPU-hr** for the Month-1 ChordNet 2E1D training burn. Hosted training only; no on-prem GPU dependency. Source: decision record v1.3 §dispatch.
- **2026-11-04 — Klangio Startup $99 / 1 billing cycle only (hard cap).** The Klangio bridge (PR-Y1.1) is a **Month-1 bridge** to ship Variant Y before the ChordNet 2E1D student is trained + distilled. Hard contractual cap: **one Klangio Startup billing cycle at $99**, swap out by end of Month 1 to the self-hosted ChordNet student. Source: decision record v1.3 §hard bridge cap.

**Items flagged but NOT amended in v1.4** (documented as discrepancies — do not invent sections):

- **Panel reuse decision** — session-6 postmortem mentioned this as a candidate decision-log entry, but the current TSD-V3-DELTA.md has no `§Panel` section and no existing Variant-Y panel-component decision beyond the pointer at §5.4 ("uses the pinned chord panel component from TSD-P2-6 with a different data source"). Not amended here; carry to the next TSD pass once Jon confirms the decision wording.
- **Daily cap decision** — flagged for check against decision record v1.3 §Flywheel. The free-tier 3/day cap is already stated inline at §5.4 ("Free-tier daily cap applies (3/day)"); no new scope change for v1.4. Carry to the next TSD pass only if a different cap number lands in decision record v1.3 §Flywheel.
- **"Decision log" section** — TSD-V3-DELTA.md does not have a standalone `§Decision log` section; it uses dated `Changelog — vX → vY` sections at the top. The Y1 decisions above are therefore appended as this new changelog rather than as a (non-existent) decision-log section, per the "don't invent sections" rule.

Items intentionally UNCHANGED in v1.4: §0 scope summary, §1 commercial layer (all subsections), §2 users + RLS, §3 Variant D engine, §4 Spotify resolver, §5.1–§5.3, §5.5, §6 routes, §7 observability, §8 rollback contract, §10 cross-ref matrix, §11 still-open-for-Jon list. The v1.4 pass is a Y1 chord-model drift fix only.

---

## Changelog — v1.2 → v1.3 (2026-11-03 — Patreon removed per Jon 2026-11-03)

Source: Jon's directive 2026-11-03T11:13 Vancouver — "no patreon - remove this from the business model". V3 relies solely on Stripe (primary) + Paddle (warm-standby adapter) for monetization; the Patreon "Founding Supporter" bridge tier is stripped from scope entirely. No replacement feature was requested.

| § | Change | Source |
|---|---|---|
| §0 Header | v1.2 → v1.3; date 2026-11-03 | Jon directive 2026-11-03 |
| §0 Scope summary | Credits-SKU scope line no longer mentions the Patreon bridge | Jon directive 2026-11-03 |
| §1.2 | Removed Patreon Founding Supporter row from the pricing/SKU table | Jon directive 2026-11-03 |
| §1.2a | Dropped Patreon from the "paid tiers never touch link ingest" enumeration (Credits/Pro/Studio only) | Jon directive 2026-11-03 |
| §1.3 | Removed Patreon-mapped reference from `check_processor_separation`; dropped the Patreon-tier promo-code exclusion carve-out | Jon directive 2026-11-03 |
| §1.5a | Promo codes no longer carry the Patreon carve-out; Patreon-tier exclusion sentence deleted | Jon directive 2026-11-03 |
| **§1.8** | **DELETED** — "Patreon parallel-bridge (V3-C11)" section removed in full. V3 does not reconcile Patreon members or issue synthetic entitlements | Jon directive 2026-11-03 |
| §8.2 | `ENABLE_V3_PLAY=true` behavior no longer enumerates Patreon tiers (Credits + Pro + Studio only) | Jon directive 2026-11-03 |
| §9 req table | Removed V3-C11 (Patreon reconciler) and V3-M4 (Patreon downgrade email) rows | Jon directive 2026-11-03 |
| §11 "Still open for Jon" | No Patreon-related items were listed; no change required there. "Items intentionally CLOSED" list updated to drop the Patreon $5 clause from the LOCKED pricing row | Jon directive 2026-11-03 |

Items intentionally UNCHANGED in v1.3: §1.6 / §1.6a Chordify-aligned legal posture; §1.9 Credits ledger DDL (credits SKU unchanged); §2 users + RLS; §3 Variant D engine; §4 Spotify resolver chain; §5 fetch chain + Variant Y; §6 routes; §7 observability; §8.1 feature-flag priority order; §10 cross-ref matrix. No replacement feature or alternative bridge was introduced per Jon's directive.

Scope risk acceptance (per Jon 2026-11-03, codified in `03-adversarial-review/ADVERSARIAL-REVIEW.md` §7): V3 now relies on Stripe PRIMARY + Paddle warm-standby adapter alone. The adversarial-review F-B7 "Patreon bridge" mitigation is explicitly declined; the single-processor + warm-standby posture is accepted.

---

## Changelog — v1.1 → v1.2 (2026-11-03 Chordify-aligned legal posture)

Source of each change is bracketed inline below. Overarching source: Jon's directive 2026-11-03 ("Copy and reference any of chordify's best practice into our PRD / TSD / terms of service. Stems wedges for V3 is a critical part of the value proposition.") + live verification of chordify.net/pages/terms-and-conditions/ on 2026-11-02 and 2026-11-03.

| § | Change | Source |
|---|---|---|
| §0 Header | v1.1 → v1.2; date 2026-11-03 | Jon directive 2026-11-03 |
| §1.6 | Reworded to point at §1.6a as the pre-launch legal posture; Phase 5 DMCA agent gate unchanged | Jon directive 2026-11-03 |
| **§1.6a** | **NEW** — Chordify-aligned legal posture: (a) Variant Y IFrame-embed mirrors Chordify §2.8; (b) V3 claims ownership of generated chord/section/mix analysis data per Chordify §9.1 pattern; (c) user indemnity clause per Chordify §2.5; (d) informal `takedown@stem-loops.com` pre-Phase 5, DMCA agent at Phase 5 | Jon directive 2026-11-03 + Chordify Terms §2.3/§2.5/§2.8/§9.1/§12 (chordify.net/pages/terms-and-conditions/, verified 2026-11-02 and 2026-11-03) |
| §1.6a note | Explicit limit: Chordify's §8 vocal-removal prohibition CANNOT be adapted verbatim (V3's core wedge is stems); V3 instead prohibits user-side rights violations in uploaded content, keeping the tool itself legitimate | Chordify Terms §8 vs V3 PRD stems wedge |

Items intentionally UNCHANGED in v1.2: §0 scope summary, §1.1–§1.5a, §1.7–§1.9, §2 (users + RLS), §3 (engine), §4 (Spotify resolver — Deezer still out, MusicBrainz primary), §5 (fetch chain + Variant Y), §6 (routes), §7 (observability), §8 (rollback contract), §9 (req IDs), §10, §11. The v1.2 pass is a legal-posture overlay only; code and schema contracts are unchanged.

---

## Changelog — v1.0 → v1.1 (2026-11-02 amendment pass)

Source of each change is bracketed inline below. Overarching source: Jon's locked decisions 2026-11-02T22:45 + adversarial review (`03-adversarial-review/ADVERSARIAL-REVIEW.md`) + Control Room agent answers (`9b3d6034-COWORK-ANSWERS-2026-11-02.md`).

| § | Change | Source |
|---|---|---|
| §0 | Scope summary updated to add Credits SKU + Variant Y fast-track (Patreon tier removed per Jon 2026-11-03) | per Jon 2026-11-02T22:45 (approve credits) + adversarial review F-B1 |
| §1.1 | Added Stripe merchant description (verbatim, binding), MCC target 7372, Paddle adapter as working code day-1, hCaptcha + Radar + 3DS + per-IP RL | per Jon 2026-11-02T22:45 (processor underwriting) + adversarial review F-B1/F-B2 |
| §1.2 | **REPLACED** plan tier table — now Free (link ingest, 3/day) + **Credits (PRIMARY SKU)** $5/$12/$30 + Pro Monthly $4.99 + Studio $12 (Patreon tier removed per Jon 2026-11-03) | per Jon 2026-11-02T22:45 (approve credits model) |
| §1.2a | NEW — The paid-tier/free-tier separation rule (link ingest NEVER touches paid tiers) | per adversarial review Lens B (CAP 84→90+) |
| §1.3 | Entitlement denial reasons extended for credit-balance decrement; new `CREDIT_BALANCE_INSUFFICIENT` | per Jon 2026-11-02T22:45 (credits model) |
| §1.5a | NEW — Promo codes (Stripe Coupons API) + 3-song no-card trial | per Jon 2026-11-02T22:45 (keep V3-R-BILL-PROMO/TRIAL) |
| §1.6 | DMCA agent — explicitly deferred to Phase 5 gate (not Phase 1a blocker) | per Jon 2026-11-02T22:45 (defer DMCA) |
| §2.1 | Auth clarified: Supabase Auth email+password + magic link + Google OAuth; **CI gate for RLS+per-user policy on every new user-scoped table** | per Jon 2026-11-02T22:45 + Control Room answer top-3 #1 (SL-B26) |
| §4 | Spotify resolver — **MusicBrainz PRIMARY (CC0), iTunes Lookup fallback, Deezer DROPPED (NC terms)** | per adversarial review F-C4 |
| §5.1 | **T-F1 Phase 1 entry gate CHANGED** from "T-F1 ≥95%" to "T-F1 ≥90% within 2 attempts AND own-file p95 <2s on 100 sessions; link-fetch degrades to opt-in beta on free tier" | per adversarial review F-X3 + Control Room answer 1.1 (SL19 pw-length mismatch) |
| §5.4 | NEW — Chordify-style Variant Y (official IFrame + tab-capture) **moved from Phase 4 to Phase 2 fast-track** as processor-safe chord overlay for free-tier link path | per Jon 2026-11-02T22:45 + adversarial review Lens B |
| §7 | Sentry scrub extended `^x-vercel-sc-` + bearer tokens; `apps/web/instrumentation.ts` must move to `src/` subtree | per Control Room answer top-3 #3 (SL-B10a) |
| §8 | Rollback contract clarified — **flag OFF = exactly today's product (unchanged); flag ON = V3 Play experience** | per Jon 2026-11-02T22:45 (preserve rollback) |
| §9 | New V3 req IDs: V3-C8 (credits ledger), V3-C9 (promo codes), V3-C10 (free trial), V3-F1 (fetch Phase 1 entry gate), V3-Y1 (Variant Y free-tier overlay) (V3-C11 Patreon reconciler removed per Jon 2026-11-03) | this amendment |
| §11 | "Still open for Jon" refreshed; added BC Ltd. BN confirmation flag | per Jon 2026-11-02T22:45 |

Items intentionally UNCHANGED: §2.3 DDL stubs for `users/plans/customers_billing/subscriptions/entitlements/usage_events` (still correct — credits ledger is additive in §1.9); §3 Variant D engine (orthogonal); §6 route table (Credits endpoints added in §6.1a); §9 §10 cross-ref matrices.

Inputs read: PRD v3 (`PRD-v3-2026-11-02.md`), pinned TSD §0–§12, PHASE-PLAN §0–§9, QA-GATES §0–§7, BUILD-R §1–§15, T-E2 report (`evidence/T-E2-REPORT.md`), stack doc (`02-stack-and-platforms.md`), rollback runbook (`08-runbooks.md` §4–§5), RLS template (`10-db-rls-and-roles.sql`), open items (`09-open-items.md`).

Rollback anchor (critical): the live product is tagged **`stem-loops-com-2026-11-02`** (main `c3f6a911`, worker `91bc917f`, v23 image `op10-91bc917` — `02-stack-and-platforms.md` row "Fly release"; restore runbook `08-runbooks.md` §4–§5). V3 must preserve this. See §9 Rollback Contract.

---

## 0. Scope summary — what V3 adds over the pinned TSD

| V3 scope item | Section | Pinned-TSD anchor | New reqs |
|---|---|---|---|
| Commercial layer: Stripe billing, **Credits (PRIMARY SKU)**, subscriptions, entitlements, usage metering | §1 | none (new) | V3-C1..V3-C11 |
| User accounts (Supabase Auth), anonymous→authed job stitching | §2 | TSD §3.1 (anonymous today) | V3-U1..V3-U4 |
| Variant D engine (WebCodecs rolling window + Int16 worklet rings) | §3 | TSD §3.8 (interface), TSD-P1-11..15 | V3-E1..V3-E4 (replaces R-C1 memory assumption) |
| Spotify resolver (**MusicBrainz PRIMARY**, iTunes fallback, Deezer DROPPED) | §4 | TSD §3.1 Spotify branch, TSD-P1-4 | existing R-A3 (upgraded) |
| Fetch reliability + fallback branch (post-T-F1 outcomes) + **own-file-primary pivot** | §5 | TSD §2 Phase 0 chain | existing R-K1 + V3-F1 |
| **Variant Y (Chordify-style free-tier chord overlay)** — moved up from Phase 4 to Phase 2 | §5.4 | — | V3-Y1 |
| New API routes (billing/entitlements/credits/play) | §6 | TSD §3 | V3-C* routes |
| Observability deltas (Stripe events, usage, dashboards) | §7 | — | — |
| Email transactional flows (Resend) | §8 | — | V3-M1..V3-M3 |
| Rollback contract (feature flag `ENABLE_V3_PLAY`) | §9 | — | V3-R1 |
| New requirement IDs appended | §10 | PRD §3.0 | V3-* |

Pinned reqs that this doc leaves untouched: R-A0, R-A1, R-A2, R-A4, R-B1, R-B2, R-D1, R-E1, R-E2, R-F1, R-F2, R-G1, R-G2, R-H1, R-I1, R-I2, R-K1, R-K2, R-X1, R-X2, R-X3, R-X4. R-A3 (Spotify) is tightened in §4. R-C1 (mixer) is unchanged but its implementation assumption changes per T-E2 (§3).

---

## 1. Commercial layer

### 1.1 Processor choice & abstraction (V3-C1)
- **Primary: Stripe** (Billing + Customer Portal + Checkout + **Coupons API** for promo codes). Rationale: largest coverage of accepted-risk S4 fallback paths (BUILD-R §12), native Supabase integrations, mature webhook signatures, dashboard-managed coupons (no code change for new promo codes). **LOCKED per Jon 2026-11-02T22:45.**
- **MCC target: 7372 (prepackaged software), NOT 5815.** The MCC determines underwriting classification; 5815 (digital goods) is a higher-risk bucket on Stripe and would surface the YouTube-downloader association sooner. Must be set at account creation.
- **Merchant description for Stripe underwriting (verbatim, binding — per Jon 2026-11-02T22:45):**
  > "Stem-Loops is a web application that helps musicians practice. Users upload audio files or paste streaming links; the application displays chords and allows per-track mixing and looping for solo practice. Audio is retained for 24 hours and never redistributed."
  **NEVER use the phrases "YouTube downloader" or "stem separator" in underwriting materials, business description, website meta, or support macros.** This phrasing is binding across Stripe application, Paddle application (if ever submitted), and any marketing copy within the processor-visible surface.
- **Paddle adapter as working code (NOT just an interface) from Day 1** (per Jon 2026-11-02T22:45): the `BillingProvider` interface is implemented by BOTH `StripeProvider` AND `PaddleProvider` on day one. Paddle code is behind the same `provider` discriminator and gets its own CI test matrix. If Stripe freezes payout (accepted risk S4), a swap takes hours not weeks — Jon has verified rollback possible.
- **Abstraction surface** (per PRD §0 S4):
  - all processor-specific code lives under `apps/worker/src/worker/billing/providers/` and `apps/web/src/lib/billing/providers/` (new);
  - the rest of the code calls an interface `BillingProvider` with 9 methods: `createCustomer(userId, email)`, `createCheckoutSession(userId, planCode, successUrl, cancelUrl)`, `createCreditPurchaseSession(userId, pack, successUrl, cancelUrl)` **(new, V3-C8)**, `createPortalSession(customerId, returnUrl)`, `getSubscription(subscriptionId)`, `cancelSubscription(subscriptionId, atPeriodEnd)`, `handleWebhook(rawBody, signature)` -> `BillingEvent`, `listInvoices(customerId)`, `applyPromoCode(sessionId, code)` **(new, V3-C9)**;
  - the DB stores a `provider` discriminator column on `subscriptions`, `customers_billing`, and the new `credit_purchases` (§1.9) so a mid-flight swap is a backfill, not a schema change.
- **No raw PAN/card data touches our servers.** Checkout is hosted; Portal is hosted. Webhooks only.
- **Card-testing / fraud protection — day-1 non-optional (per Jon 2026-11-02T22:45):**
  - **Stripe Radar** enabled (default rules + custom rule: block cards <$1 auth test attempts >3/min from same IP);
  - **3D Secure (3DS)** forced on all one-time credit purchases (Radar rule `request_three_d_secure='any'`);
  - **hCaptcha** on `/signup` and on the credits-purchase form (`apps/web/src/components/HCaptcha.tsx` + `HCAPTCHA_SITE_KEY` + `HCAPTCHA_SECRET_KEY` env);
  - **Per-IP rate limit** on `/api/billing/checkout` (3/5min) and `/api/users/me/claim-jobs` (10/day) via existing M5 pattern.

### 1.2 Plan tiers / SKUs (V3-C2) — **RE-PRICED per Jon 2026-11-11 (v1.8); credits model still LOCKED per Jon 2026-11-02T22:45**

| Tier | What | Price | Payment surface | Processor touches link-ingest? |
|---|---|---|---|---|
| **Free** | Link + file ingest, **5 tracks converted to play-along / month**, device-fingerprint rate limited, no account needed | $0 | — | **NO** (free tier is zero-processor exposure) |
| **Credits (PRIMARY SKU)** | **20 songs $5** / **60 songs $12** / **180 songs $30**. Never expire. One-time charges. StemSplit-style model. | $5 / $12 / $30 | Stripe one-time Checkout | **NO** — own-file only |
| **Pro Monthly** (secondary) | **50 tracks converted to play-along / month**, chord/section cache per account, promo codes work here | $4.99/mo | Stripe recurring + Portal | ~~**NO** — own-file only (see **O-8**)~~ ⟲ **v1.10: YES** — YouTube links, counted against the 50 |
| **Studio** | **150 tracks converted to play-along / month**, recording, higher rate limits, priority queue | $12/mo | Stripe recurring + Portal | ~~**NO** — own-file only (see **O-8**)~~ ⟲ **v1.10: YES** — YouTube links, counted against the 150 |

Plan→feature mapping is in a `plans` table (DB-driven; not hard-coded) so adding/pricing a plan is a row insert, not a deploy. (Patreon "Founding Supporter" bridge tier removed per Jon 2026-11-03 — V3 relies solely on Stripe + Paddle adapter for monetization.)

### 1.2b The metered unit, and where plan values live (v1.8)

**The metered unit is one track converted to play-along.** It is counted by `public.plans.monthly_job_quota` and enforced by `checkMonthlyQuota()` in `apps/web/src/lib/billing/rate-limit.ts`, which compares `entitlements.jobs_used` against that column and rolls on `period_end` — a **calendar month**. No daily cap exists anywhere in the system; every document that said "3/day" or "3 songs per day" was describing something that was never built.

**Source of truth for plan values: `apps/worker/migrations/034_v3_pricing_model_truth.sql`.** `014_v3_seed_plans.sql` seeded the catalog and is retained unedited as the historical record; 034 applies after it and wins. Both insert all three rows idempotently (`ON CONFLICT (code) DO UPDATE`), so a fresh database lands the full catalog — contrary to a reading that only `free` is ever seeded, which `013` seeds **deliberately and minimally** (a self-contained `ON CONFLICT DO NOTHING` row) purely so the `handle_new_user` trigger's FK into `plans(code)` cannot fail if 013 is applied before 014.

**Two flags are false on every plan and must stay false until the features exist:**

| flag | why false |
|---|---|
| `export_stems` | No stem-export route exists. `/api/jobs/[id]/stems` serves **Opus playback** urls, and `mintStemDownloadUrl()` has no production caller. |
| `export_wav24` | Loops are already 24-bit WAV for **every** tier, free and anonymous included. A paid flag here can only overstate what a paid plan adds. 24-bit WAV loop download is named on all three tiers in the UI, which is the truth. |

The pricing page derives its bullets from these columns, and `apps/web/test/pricing-features-table.test.mjs` asserts the rendered bullets against both the migration **and** a ban list of capabilities absent from the repo. Before it, the whole feature table was unasserted: a mutant renaming a bullet shipped with the suite green.

### 1.2a Critical processor-exposure rule — **NON-NEGOTIABLE** (per adversarial review Lens B 84→90+)

> 🔴 **REVERSED BY JON, 2026-11-16 — DO NOT FOLLOW THIS SECTION.** Pro and Studio may paste YouTube links. Paid link jobs are metered against the plan's monthly quota exactly like uploads and kept in the account's library under the paid retention rule (#279). **Reason:** paid plans build a library of songs, and most of those songs arrive as links. The exposure this section removed is **accepted by the owner**. What still holds: credits are spent on uploads only (`check_credit_decrement`, unchanged). Free credit holders' links are capped at the free allowance — a separate decision, Jon 2026-11-16 "Cap at 5/month" (see the changelog Credits row). The text below is preserved as the audit trail, not an instruction — see the v1.9 → v1.10 Changelog.

**The paid tiers (Credits, Pro Monthly, Studio) NEVER touch the YouTube / Spotify / SoundCloud link-ingest path. Link ingest lives in the free tier forever.** (Patreon tier removed per Jon 2026-11-03.) This is the structural separation that keeps paid-tier processor underwriting clean:

- Any paid-tier action (credit decrement, Pro-gated feature, Studio queue priority) is gated on `input_kind='upload'`. The entitlement guard (§1.3) returns `PAID_LINK_INGEST_DISALLOWED` 400 if a paid-tier user attempts a link URL — the fallback is to use the free-tier allowance instead (same anonymous rate-limit cohort). ⟲ **v1.8:** that allowance is **5 tracks / calendar month** (`plans.monthly_job_quota`), not the "3 songs/day" this line used to claim. The separation rule itself is unchanged — see **O-8**.
- The DB enforces this: `credit_purchases` ledger decrements only on `job_completed WHERE input_kind='upload'`. A trigger (`check_credit_decrement`) rejects any attempted debit against a link-ingest job.
- Link ingest telemetry (`fetch_attempts`, Sentry breadcrumbs) carries NO `user_id` even when a logged-in user triggers it — the row is anonymous (`client_ip_hash` only). The free-tier RL cohort rules apply.
- **Rationale**: this is what moves adversarial-review Lens B (CAP, 84/100) above 90. The processor sees a software product that accepts audio uploads and sells credits — the merchant description in §1.1 remains truthful. The YouTube-link path is a free, no-processor-touch experience.

Price points LOCKED per Jon 2026-11-02T22:45. The $4.99 / $12 numbers are no longer planning placeholders — they are the launch numbers. Studio tier scope and Pro Monthly scope separation to be finalized before Phase 5 Jon approval.

### 1.3 Entitlement checks (V3-C3) — **UPDATED for credits model + processor separation (per Jon 2026-11-02T22:45)**

Every billable action goes through a single server-side guard: `enforceEntitlement(userId, action, context)`.
- Actions and when they are checked:
  - `create_job`: at `POST /api/jobs` (TSD §3.1), before admission and after the kill-switch gate. On free tier, blocks on the monthly quota (`plans.monthly_job_quota`, **5** as of v1.8) via `checkMonthlyQuota()` — **not** a `jobs_today >= 3` daily cap, which was never implemented. On paid tier with `input_kind='upload'`, blocks on `credits_remaining <= 0` AND no active Pro/Studio subscription.
  - **`check_processor_separation`** (new): if the request carries `user_id` with ANY active paid entitlement (credits balance > 0, Pro, or Studio) AND `input_kind != 'upload'`, the guard either (a) routes the request to the anonymous free-tier cohort (preferred — transparent) or (b) returns `PAID_LINK_INGEST_DISALLOWED` 400. ⟲ **v1.8:** the "3 free songs today" condition described a daily cap that was never built; the real gate is the monthly quota. This is the enforcement half of §1.2a. (Patreon-mapped entitlement check removed per Jon 2026-11-03.)
  - `fetch_service:<name>`: inside `create_job`, discriminated by host (`youtube | spotify | soundcloud`). All services available on free tier (link ingest is free tier only). Apple/Tidal remain Phase 4 trigger-based.
  - `export_stems`: **DENIED ON EVERY PLAN as of v1.8 (2026-11-11).** `plans.export_stems` is false across the catalog per migration 034, because **no stem-export route exists** — `/api/jobs/[id]/stems` serves Opus **playback** urls and documents that in its own header, and `mintStemDownloadUrl()` has **no production caller**. The guard is still data-driven, so it starts allowing the moment a plan row sets the flag and a route exists to honour it. ⚠️ **This supersedes the v1.7 amendment below**, which specified a 3-download allowance against a feature that has never been built; the allowance cannot be "3 free then paid" when it is 0 and unbuildable. `export_wav24` is likewise false everywhere: loops are 24-bit WAV for every tier already.
    > ⟲ **Superseded 2026-11-11 (v1.8).** Retained verbatim because this document records decisions rather than rewriting them:
    > 🟡 **AMENDED 2026-11-10 (v1.7), per Jon: "stem download = 3 free then move to paid once stripe is integrated."** So at launch `export_stems` is **not** a hard paid gate — it is a **3-download allowance, then paid**. This resolves the contradiction the M-9 review found between this line and §12.2 (v1.6 had specified a free per-stem download outright, which would have given away the paid tiers' differentiator). Two constraints carried forward: the `input_kind='upload'` restriction **no longer applies** (Jon's link-path override, v1.5 §5.4), and **`.wav` is the download format** (Jon). ⚠️ **Open:** the allowance needs an identity, and the launch path is anonymous — see §11.
  - `play_access`: at `GET /api/jobs/:id` when `play` block is requested.
- Guard order: kill switch → **processor separation** → entitlement → rate limit → admission (per TSD §3.1 M5 pattern). Guard runs in the request handler, not in the client, and is covered by T-V3-C3 (mutant: remove the guard → test must fail).
- `enforceEntitlement` returns a typed denial reason that maps to a user copy entry in `apps/web/src/lib/error-copy.ts`:
  - ~~`FREE_DAILY_LIMIT` 402 → "You've used your 3 free songs today."~~ **NOT IMPLEMENTED and never was** — there is no daily cap and no such code in `error-copy.ts`. The real monthly denial is a 402 from `checkMonthlyQuota()` carrying `resets_at`.
  - `CREDIT_BALANCE_INSUFFICIENT` 402 → "You're out of credits. Buy 20 for $5, 60 for $12, or 180 for $30."
  - `PAID_LINK_INGEST_DISALLOWED` 400 → **CORRECTED v1.8** → "Credits, Pro and Studio only work with files you upload." / "Upload your file instead, or use link import on the free tier — see /pricing for the monthly allowance." The old copy promised a **"(3/day)"** allowance that has never existed, and its headline omitted **Studio**, which the guard also refuses.
  - ~~`PLAN_EXPORT_UNAVAILABLE` 402 → "Stem export is on Credits, Pro, and Studio."~~ **WITHDRAWN v1.8** — no stem-export route exists, so no plan can offer it. `enforceEntitlement('export_stems')` denies on every plan with `ENTITLEMENT_UNAVAILABLE`.
  - `SUB_PAST_DUE` 402 → "Your subscription needs attention. Open the billing portal."
  - `TRIAL_EXHAUSTED` 402 → "You've used your 3 trial songs. Buy credits to continue — $5 for 20."
- HTTP 402 Payment Required is used across the board; the body includes `upgrade_url` from the current Stripe Checkout session (credits-pack checkout for free, Pro for Credits users wanting a larger monthly allowance — **no tier is unlimited as of v1.8**).

### 1.4 Usage metering & rate limiting per tier (V3-C4)
- Metering model: an append-only `usage_events` table (DDL §2.3) counts billable facts (`job_created`, `job_completed`, `export_minted`, `play_opened`, etc.). The counter is derived (`COUNT(*) WHERE user_id=$1 AND kind='job_created' AND created_at >= period_start`), not stored, so a double-count bug can be corrected by replay.
- Rate limiting:
  - Monthly: `COUNT(*)` against the current billing period start (`subscriptions.current_period_start`); evaluated at admission.
  - Burst (anti-abuse, atop the pinned M5 10/24h IP cap in TSD §3.1): 3 jobs per 5 min per `user_id` on free, 20 on pro, 60 on max.
- Period rollover is driven by Stripe `invoice.paid` webhook, not by wall-clock cron — a late webhook does not open free jobs early.

### 1.5 Email transactional flows (V3-M1..M3)
- **Resend** (abstracted via `EmailProvider` interface so swap to Postmark/SES is one file). API key in Fly secret `RESEND_API_KEY`.
- Flows (all idempotent, keyed by Stripe event id or user id + action):
  - V3-M1 welcome: on first `auth.users` insert, send welcome + verify link (Supabase sends verification; we send the branded wrapper).
  - V3-M2 subscription-changed: on `customer.subscription.updated` where `status` changed to/from `active|past_due|canceled`.
  - V3-M3 receipt: on `invoice.paid`; include invoice PDF URL from Stripe.
- All templates live in `apps/web/src/emails/*.tsx` using `@react-email/components` (static render, no runtime bundle). Audit log in `job_events` with `kind='email_sent'`, `detail={flow, provider_id}`.

### 1.5a Promo codes + Free trial (V3-C9, V3-C10) — per Jon 2026-11-02T22:45

**Promo codes (V3-C9):**
- Implementation: **Stripe Coupons API** — dashboard-managed; no code change needed to add/retire a code.
- Flow: `POST /api/billing/checkout` accepts optional `promo_code` field, forwarded to Stripe Checkout as `discounts: [{coupon: <id>}]`. Stripe validates (code exists, active, within use-count, matches customer eligibility) and rejects or applies.
- Promo codes apply to Credits packs AND Pro/Studio subscriptions. (Patreon bridge removed per Jon 2026-11-03 — no third-party promo exclusion carve-out required.)
- Audit log: `promo_redemptions` table (new) with `(user_id, code, stripe_promotion_code_id, applied_at, stripe_discount_amount_cents)`. Append-only; RLS self-read only; `stemloops_app` writes on webhook `checkout.session.completed`.
- The old req IDs `V3-R-BILL-PROMO` are retained as aliases pointing to V3-C9 per Jon's "rename references but keep" directive.

**Free trial (V3-C10):**
- 3-song trial on the link-ingest path (YouTube today; Spotify/SoundCloud when their branches ship). **NO card required.** Per-user cohort (one trial per authenticated user, lifetime).
- Backed by a new `trial_grants` table `(user_id, granted_at, songs_used, expires_at=granted_at+7d)` — RLS self-read; worker writes via `stemloops_app`.
- The trial path is `input_kind='youtube'` (the link-ingest branch per §1.2a Round-2 channel-separation rationale — upload is the credits/paid path and MUST NOT burn a trial song). When Spotify/SoundCloud link kinds are added, they inherit the same trial branch; upload stays separate. On trial exhaustion the free-tier gate takes over (see §1.3 — `TRIAL_EXHAUSTED` is emitted by `enforceEntitlement` when the snapshot has no active plan and the trial row is `songs_used = 3`).
- Trial grant is one-per-user-ever (PK on `trial_grants.user_id`; not resettable). No fingerprint column, no fingerprint hashing — the PK is the idempotency boundary. Re-calling `POST /api/users/me/trial/grant` is an idempotent no-op that returns the existing row (`granted=false`).
- Trial consume runs in-tx with the `/api/jobs` INSERT (`consumeTrialInTx`, see §6.1). Per-IP admission runs BEFORE the trial tx so a rate-limited request cannot leak a trial song; if the atomic rate-limit WHERE in the INSERT returns 0 rows the tx rolls back and the song is NOT burned.
- The old req IDs `V3-R-BILL-TRIAL` are retained as aliases pointing to V3-C10.

**Decision log:** session 6 (2026-11-04) reconciled §1.5a prose to match shipped code per Round-2 §1.2a reviewer finding (PR #39 + #59). Trial-as-upload would require ~2-3 weeks of rewrites and weaken Lens B processor separation; trial-as-link is the shipped and reviewed path.

### 1.6 DMCA agent & legal pages (V3-C5) — **Phase 5 gate, NOT Phase 1a blocker (per Jon 2026-11-02T22:45)**

Per Jon's directive: **defer DMCA agent registration until needed**. Confirmed Phase 5 (go-paid launch) gate only. Rationale: pre-paid product does not host or distribute copyrighted content (free tier audio is R-X2 24h ephemeral, never redistributed); the DMCA Safe Harbor becomes material at the point of commercial relationship with users. Still a hard pre-launch gate — see WORKPLAN-V3 §9 pre-launch checklist. US Copyright Office eCO processing is 2–4 weeks historically; **start registration no later than Phase 4 or Day-1 of Phase 1b, whichever is first**, to beat the processing wait.

**Pre-Phase-5 posture is defined in §1.6a (Chordify-aligned legal posture).** §1.6 is the Phase-5 destination; §1.6a is the standing posture V3 ships with from Phase 1a through to the Phase-5 gate flip.

### 1.6a Chordify-aligned legal posture (NEW, v1.2 — per Jon directive 2026-11-03)

Chordify (chordify.net) is a 12-year-old competitor in an adjacent space (chord detection on streamed audio) that has operated continuously without a terminal payment-processor action. V3 adopts, as pre-launch legal posture, four patterns Chordify codifies in its Terms (verified 2026-11-02 and 2026-11-03 at chordify.net/pages/terms-and-conditions/). The chord-only, stems-off posture Chordify runs CANNOT be adopted whole — V3's stems wedge is the paid-tier value proposition per PRD §0 and §1.2 — but each of the four patterns transfers cleanly either verbatim or with a scoped adaptation.

**(a) IFrame-embed pattern for free-tier link ingest — mirrors Chordify §2.8**
> "Chordify uses YouTube API Services to play embedded videos." — Chordify Terms §2.8 (verified 2026-11-02)

TSD-V3-DELTA §5.4 (Variant Y) already specifies the official YouTube IFrame + browser-side `getDisplayMedia({audio:true})` tab-capture + 100%-client-side WASM chord detection. This architecturally matches Chordify §2.8 for the free-tier link path: **V3 never fetches or hosts the audio of a linked video on our servers in the Variant Y path**. Audio stays within the user's browser. The ToS (DRAFT-V3-TERMS.md §4) adopts the Chordify §2.8 shape in V3's own voice: "Stem-Loops uses YouTube's official embedded player to display linked videos. Embedded playback is governed by YouTube's own terms. Chord and section analysis in the link-ingest path runs in your browser; the audio of a linked video is never sent to our servers."

Scope limit: this applies ONLY to the free-tier link path. The paid-tier (Credits, Pro, Studio) path is file-upload only (§1.2a) — Chordify §2.8's embed-only posture does not and cannot cover it.

**(b) Ownership of generated analysis data — adapts Chordify §9.1 ("The Chordify Service contains material which is owned by us.")**

Chordify's §9.1 claims ownership of its site's design, software, graphics and (by extension via Chordify's commercial practice) its chord transcriptions as derivative data created by Chordify's models. V3 adopts the same claim for its own generated outputs:

> V3 (Stem-Loops) owns the chord labels, section boundaries, key estimates, beat grid, and mix-level analysis metadata that V3's models generate from user-submitted audio. The user retains all rights in the audio they upload or link to. V3 grants the user a non-exclusive, non-transferable, revocable licence to use V3-generated analysis for their own personal, non-commercial practice.

This is codified in DRAFT-V3-TERMS.md §5 (Intellectual property). Rationale: the stem outputs (`mix.m4a`, per-stem Opus files from Demucs on Replicate) are a transformation of the user's audio and the user keeps their rights there; the chord/section/key labels are V3's own model output on top of that audio, so V3 can claim them without claiming ownership of the audio itself. This is the same split Chordify operates under.

Scope limit: V3 CANNOT claim ownership of **separated stems themselves** the way Chordify claims chord transcriptions — stems are a lossy re-synthesis of the user's audio and the audio copyright flows through. V3's ownership claim stops at analysis metadata. Stems are governed by §6 (prohibited uses: no redistribution) and §9 (indemnity) instead.

**(c) User indemnity against third-party claims — adapts Chordify §2.5**
> "You shall be responsible for the data and other results processed and created by you" — Chordify Terms §2.5 (verified 2026-11-02)

V3 adopts the full user-indemnity shape from Chordify §2.5 verbatim in posture (reworded in V3's voice for DRAFT-V3-TERMS.md §9). The user is responsible for ensuring they have the rights to the audio they upload or link to; the user indemnifies V3 against third-party claims arising from that audio or from the user's use of V3's outputs (stems, chord data, loops) outside personal non-commercial use. This is the single most important Chordify pattern for V3 — it is the explicit written transfer of upload-rights responsibility from the service to the user, and it is what makes a "the tool is legitimate even if a given user's upload isn't" posture written-down defensible.

Combined with Chordify §2.3's "as is" + no-infringement guarantee ("The Chordify Services are provided to you 'as is'" — §2.3), V3's ToS (DRAFT-V3-TERMS.md §10) ships the same two-clause pairing: no warranty of non-infringement + user indemnity.

**(d) Informal takedown pre-Phase-5, DMCA agent at Phase 5 — adapts Chordify §12**
> Chordify §12 (verified 2026-11-02): rights holders report infringing content by emailing `retract@chordify.net` with content title + rights held; valid complaints are removed "as soon as possible". Chordify operates without a US-registered DMCA designated agent per the US Copyright Office directory as of 2026-11-02; this is a known legal gap that §1.6 addresses for V3 at the Phase 5 gate.

Pre-Phase-5 posture for V3 (ships at Phase 1a): informal takedown via `takedown@stem-loops.com`, response SLA 72 h, mirroring Chordify §12's "as soon as possible" shape but with a stated SLA. Required contents: content identifier (job id, uploaded filename, or link URL), the rights the complainant holds, contact info, and a statement of good-faith belief that the use is unauthorized. Internal flow: operator (Jon) reviews, acts within SLA, logs in `takedown_requests` table (new, migration deferred to Phase 1b — not Phase 1a blocker; ad-hoc email queue acceptable until the table lands).

Phase 5 gate (unchanged from §1.6): V3 DOES register a US Copyright Office DMCA designated agent in eCO before go-paid launch. This moves V3 **ahead** of Chordify on this axis — Chordify's informal-only posture is a known risk inherited from pre-DMCA practice. V3 inherits the informal pattern only for the pre-launch window where no commercial relationship with users exists; at Phase 5 flip, the full §512 safe harbor posture kicks in and the informal path becomes an on-ramp into the formal process rather than a substitute for it.

**Repeat-infringer policy** (adopted at Phase 5, drafted in DRAFT-V3-TERMS.md §8): accounts receive strikes; three strikes within 180 days = account termination + credit-balance forfeiture. Chordify does not publish a repeat-infringer policy; this is a V3 addition beyond the Chordify baseline and is required for §512 safe harbor eligibility.

**What V3 does NOT copy from Chordify Terms:**

- **Chordify §8** (lyrics / no-vocal-removal / no-circumvention) — V3's PRD stems wedge is lawful under US and Canadian law when operated on user-rightsful audio (Demucs is a research tool with legitimate uses; the paid tier is file-upload only; §1.2a enforces the processor-separation rule). V3 CANNOT prohibit vocal removal in general — it is the product. V3 instead prohibits user-side rights violations: a user may not upload or link content they do not have the rights to process (ToS §2 and §6).
- **Chordify §3.3** (credits expire 12 months after purchase) — V3's locked pricing (§1.2, per Jon 2026-11-02T22:45) is **credits never expire**. This is a competitive differentiator against Chordify's expiring-credits model; keep it.
- **Chordify's commercial-use carveout for lyrics** — V3's stems and chord data are both subject to §6 (no redistribution, no commercial use of outputs). V3 is stricter on commercial-use of outputs than Chordify is on lyrics; this is the correct direction given stems are a lossier transformation than chord labels.

**Sources (direct Chordify Terms section quotes, verified 2026-11-02 and 2026-11-03 at chordify.net/pages/terms-and-conditions/):**
- §2.3 "The Chordify Services are provided to you 'as is'." (as-is + no non-infringement guarantee)
- §2.5 "You shall be responsible for the data and other results processed and created by you" (user responsibility + indemnity)
- §2.8 "Chordify uses YouTube API Services to play embedded videos." (official embed, not fetched)
- §9.1 "The Chordify Service contains material which is owned by us." (service-owned material + reserved rights)
- §12 takedown via `retract@chordify.net` (informal takedown, no statutory DMCA agent)

### 1.8 Patreon parallel-bridge — intentionally not implemented, see Jon decision 2026-11-03

Removed in full per Jon's directive 2026-11-03 ("no patreon - remove this from the business model"). V3 does not integrate Patreon, does not reconcile Patreon members, and does not issue synthetic entitlements from a Patreon source. V3-C11 (Patreon reconciler) and V3-M4 (Patreon downgrade email) are retired. The adversarial-review F-B7 "Patreon bridge" mitigation is explicitly declined; the single-processor (Stripe PRIMARY) + Paddle warm-standby posture is accepted. See `03-adversarial-review/ADVERSARIAL-REVIEW.md` §7.

### 1.9 Credits ledger (V3-C8) — per Jon 2026-11-02T22:45

The credits SKU needs an auditable append-only ledger (never a mutable integer balance).

**DDL additions to migration `013_v3_commercial.sql`:**
```sql
-- 9. credit_purchases (append-only, one row per Stripe one-time charge)
CREATE TABLE IF NOT EXISTS public.credit_purchases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('stripe','paddle')),
  provider_charge_id text NOT NULL,
  pack_code     text NOT NULL CHECK (pack_code IN ('credits_20','credits_60','credits_180')),
  credits_granted integer NOT NULL CHECK (credits_granted IN (20,60,180)),
  amount_usd_cents integer NOT NULL,
  promo_code    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_charge_id)
);

-- 10. credit_consumption (append-only, one row per job that charged a credit)
CREATE TABLE IF NOT EXISTS public.credit_consumption (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  job_id        uuid NOT NULL REFERENCES public.jobs(id) ON DELETE RESTRICT,
  consumed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id)
);

-- 11. derived balance view (never store the integer)
CREATE OR REPLACE VIEW public.v_credit_balance AS
  SELECT u.id AS user_id,
    COALESCE((SELECT SUM(credits_granted) FROM credit_purchases WHERE user_id=u.id),0)
    - COALESCE((SELECT COUNT(*) FROM credit_consumption WHERE user_id=u.id),0)
    AS credits_remaining
  FROM users u;

-- 12. trigger: credit_consumption may ONLY be inserted for input_kind='upload'
CREATE OR REPLACE FUNCTION public.check_credit_decrement() RETURNS trigger AS $$
BEGIN
  IF (SELECT input_kind FROM public.jobs WHERE id = NEW.job_id) != 'upload' THEN
    RAISE EXCEPTION 'credit_consumption rejected: job % is not input_kind=upload (processor separation §1.2a)', NEW.job_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER credit_decrement_check BEFORE INSERT ON public.credit_consumption
  FOR EACH ROW EXECUTE PROCEDURE public.check_credit_decrement();
```

RLS: `credit_purchases` and `credit_consumption` are self-read `USING (auth.uid() = user_id)`; `stemloops_app_all` for worker writes; `cowork_ro` A3 read for diagnostics (per the §A3 DO loop — SL-B26 pattern).

Charging a credit happens exactly once per successful upload job in the worker's `job_completed` handler, idempotent on `job_id` (the UNIQUE constraint). Refunds (support flow): manually insert a `credit_purchases` row with a negative-amount Stripe refund id → NO; refunds happen through Stripe and a cancellation row in `credit_adjustments` (deferred, Phase 5 if needed).

### 1.7 Entitlement caching (V3-C6)
Entitlement reads MUST be fast. Rules:
- 30 s cache (same window as kill-switch per TSD §3.6) keyed on `user_id`.
- Invalidated synchronously by the webhook handler (`stripe/webhook.ts`) on `customer.subscription.updated` or `invoice.paid`.
- Fail-closed: if the cache miss + DB read both fail, deny the action with `ENTITLEMENT_UNAVAILABLE` 503 — exactly as `LINKS_PAUSED` (TSD §3.6). Upload jobs on the free tier are **not** affected (free plan always has >=0 upload jobs available).

---

## 2. User accounts & data model

### 2.1 Auth choice (V3-U1): Supabase Auth — **LOCKED per Jon 2026-11-02T22:45**
**Decision: Supabase Auth** with THREE sign-in methods required at launch:
- **Email + password** (primary; adds a password manager-friendly path for musicians who prefer it)
- **Magic link** (passwordless; one-click fallback)
- **Google OAuth** (fastest-path for new users)

Justification:
- Supabase is already the DB (`02-stack-and-platforms.md`), so no new vendor and no new secret store.
- RLS pattern (`10-db-rls-and-roles.sql`) extends naturally: policies on new tables use `auth.uid()` directly.
- Email templates can be branded; verification flow owned by Supabase.
- Downside acknowledged: platform lock to Supabase for identity. Mitigation: all code reads `user_id` (opaque UUID), never Supabase-specific JWT internals outside `apps/web/src/lib/auth/supabase.ts`.

### 2.1a RLS CI gate (per Jon 2026-11-02T22:45 + Control Room top-3 #1 SL-B26)

**Hard CI rule, repo-wide, applies to every V3 migration AND backfilled to all current tables:**

A GitHub Actions job `rls-coverage-check` runs on every PR touching `apps/worker/migrations/*.sql`:
1. Spins up a fresh Postgres with all migrations applied.
2. Queries `pg_catalog.pg_tables` for every table in `public` schema.
3. For each table, asserts: (a) `rowsecurity=true` (RLS enabled), AND (b) at least one policy exists where the USING or WITH CHECK clause mentions `auth.uid()` (per-user policy), AND (c) the `stemloops_app_all` policy exists (worker write path), AND (d) the `cowork_ro_read` policy exists (diagnostics per §A3 DO loop).
4. **Fails the PR** if any new user-scoped table lacks (a)+(b)+(c)+(d).

Script lives at `apps/worker/scripts/check_rls_coverage.py`. Tables exempt from (b): `plans` (public catalog), `kill_switches` (operator-only). Everything else must have per-user RLS.

This gate is a direct Phase 1a entry prerequisite (per adversarial review and SL-B26 open item). It CANNOT ship as "we'll backfill RLS later" — the backfill goes in before the first V3 migration PR merges.

### 2.2 Anonymous → authenticated stitching (V3-U3)
- Today's jobs are anonymous (keyed on `client_ip_hash`). V3 keeps anonymous access on `free` (3 jobs/mo per `client_ip_hash` OR per `user_id`, whichever is lower).
  > ⟲ **v2.0.1:** superseded by §12.9 v2.0 — your own songs need sign-in (Jon, 2026-11-10); only the three demo songs play signed out (DB-12(a), not yet built — Slice 2).
- On sign-up, a client-side `claim_jobs` call (`POST /api/users/me/claim-jobs`) attaches any jobs from the current `client_ip_hash` (last 24 h) to the new `user_id`. Audit row in `job_events` kind `job_claimed`.
- History (`/history`) becomes user-scoped post-signup; anonymous history continues via the existing cookie.
  > ⟲ **v2.0.1:** superseded by §12.9 v2.0 — your own songs need sign-in (Jon, 2026-11-10); only the three demo songs play signed out (DB-12(a), not yet built — Slice 2).

### 2.3 DDL stubs — migration `013_v3_commercial.sql`

> ⟲ **v2.0 (2026-11-17):** later migrations this delta names, all in `apps/worker/migrations/` with a `down/` twin: **034** `034_v3_pricing_model_truth.sql` (plan values, §1.2b), **039** `039_v3_paid_plans_youtube_links.sql` (§1.2a reversal), **040** `040_v3_jobs_is_demo.sql` (`jobs.is_demo`, §12.11). No migration is applied to production by a merge — see §12.14.

Follows the §A1/A2/A3 template of `10-db-rls-and-roles.sql`. All 5 tables get `ENABLE ROW LEVEL SECURITY` + `stemloops_app_all` policy in the SAME migration, plus a `cowork_ro_read` policy under the A3 DO block, per the Phase 0 lesson (SL-B26, `09-open-items.md`). An `013_v3_commercial_down.sql` is required.

```sql
-- 013_v3_commercial.sql  (V3; migrates to users, subscriptions, entitlements, usage_events, plans)
-- Precondition: migration 008b/011+ has back-filled RLS/role/policies for the 8 pinned tables (SL-B26).

-- 1. users (shadow table mirroring auth.users for FK + extra app fields)
CREATE TABLE IF NOT EXISTS public.users (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email         citext UNIQUE NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  display_name  text,
  marketing_opt_in boolean NOT NULL DEFAULT false
);

-- 2. plans (DB-driven feature flags per tier; seed in 013_v3_seed.sql)
CREATE TABLE IF NOT EXISTS public.plans (
  code          text PRIMARY KEY,                   -- 'free' | 'pro' | 'max'
  display_name  text NOT NULL,
  price_usd_cents integer NOT NULL DEFAULT 0,
  monthly_job_quota integer NOT NULL,
  services      text[] NOT NULL,                   -- {'youtube','spotify',...}
  export_stems  boolean NOT NULL DEFAULT false,
  export_wav24  boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 3. customers_billing (one row per user per provider)
CREATE TABLE IF NOT EXISTS public.customers_billing (
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('stripe')),
  provider_customer_id text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider),
  UNIQUE (provider, provider_customer_id)
);

-- 4. subscriptions
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  provider_subscription_id text NOT NULL,
  plan_code     text NOT NULL REFERENCES public.plans(code),
  status        text NOT NULL CHECK (status IN ('trialing','active','past_due','canceled','incomplete','paused')),
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id)
);
CREATE INDEX subscriptions_user_active_idx ON public.subscriptions (user_id) WHERE status IN ('trialing','active','past_due');

-- 5. entitlements (denormalized cache rebuilt by webhook; readable for 30s cache)
CREATE TABLE IF NOT EXISTS public.entitlements (
  user_id       uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  plan_code     text NOT NULL REFERENCES public.plans(code),
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  jobs_used     integer NOT NULL DEFAULT 0,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  source_subscription_id uuid REFERENCES public.subscriptions(id)
);

-- 6. usage_events (append-only facts for metering + analytics)
CREATE TABLE IF NOT EXISTS public.usage_events (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  anon_ip_hash  bytea,
  kind          text NOT NULL,       -- job_created|job_completed|export_minted|play_opened|...
  job_id        uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_user_period_idx ON public.usage_events (user_id, created_at);
CREATE INDEX usage_events_kind_idx ON public.usage_events (kind, created_at);

-- 7. link to jobs (nullable so anonymous jobs still work)
ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS jobs_user_id_idx ON public.jobs (user_id) WHERE user_id IS NOT NULL;

-- 8. RLS + stemloops_app_all policy per 10-db-rls-and-roles.sql §A2 (every table, this file)
-- (expanded in the real migration; abbreviated here)
```

RLS policies (one per table, additive):
- `users`: self-read `USING (auth.uid() = id)`, no self-insert (Supabase trigger seeds row via `handle_new_user()`).
- `plans`: public read `USING (active)`, no public write.
- `customers_billing`, `subscriptions`, `entitlements`: self-read `USING (auth.uid() = user_id)`, no direct write (webhook writes as `stemloops_app`).
- `usage_events`: self-read own rows; no self-write.
- `jobs.user_id`: existing `stemloops_app_all` policy already covers it (no change).
- `cowork_ro` read policy applied via the §A3 DO loop so diagnostics work (`09-open-items.md` SL-B26).

### 2.4 Supabase `auth.users` trigger (V3-U4)
```sql
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger AS $$
BEGIN
  INSERT INTO public.users (id, email) VALUES (NEW.id, NEW.email);
  INSERT INTO public.entitlements (user_id, plan_code, period_start, period_end)
    VALUES (NEW.id, 'free', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
```

---

## 3. Variant D engine (bakes the T-E2 result into design)

> 🟢 **PROMOTED TO THE LAUNCH PATH, 2026-11-10 (v1.5, banner added for real in v1.7).** This engine **is** the per-stem mixer of §12.1, and the mixer is now the product. §9 and §10 still place V3-E1…E4 in "Phase 1b" — ⚠️ **treat §12's LAUNCH designation as authoritative over those two tables.** ⚠️ **§3.3 (tempo/pitch) is the one exception: DEFERRED out of launch** per Jon 2026-11-10. ⚠️ **`apps/web/src/lib/play/` does not exist** — this engine is greenfield, and §3.1's `SharedArrayBuffer` requires COOP/COEP headers that this document does not yet specify. See §11.

**T-E2 verdict (`evidence/T-E2-REPORT.md`): variant D passes at 287 MB peak; the full-decode fallback peaks at 643 MB and FAILS the 400 MB bar. Variant A peaks at 1384 MB.** The pinned TSD §3.8 interface is correct; the implementation that TSD-P1-11..15 names (decode-all-to-float32) is NOT viable at 5 min × 6 stems. V3 replaces that implementation with D.

### 3.1 V3-E1 — Decoder architecture
- Each stem is held in memory as the **Opus-encoded bytes** (compressed, 4–5 MB per stem).
- A **WebCodecs `AudioDecoder`** per stem is driven by a rolling 20 s window scheduler.
- Decoded frames go to a per-stem **Int16 ring buffer** (SharedArrayBuffer) consumed by the AudioWorklet playback node.
- Playback is sample-locked across stems via a shared `startFrame` set at `play()`; all workers key off the same `AudioContext.currentTime` snapshot.
- Opus is natively 48 kHz; `AudioContext` is created at 48 kHz to avoid resample cost.

### 3.2 V3-E2 — Loop wrap / seek
- Opus packets are all key frames (per T-E2 "Reading" §(a)); re-seeding on wrap or seek is a packet-boundary close + reopen of the decoder, measured <= 20 ms in the T-E2 prototype.
- Loop seams keep the pinned R-G1 bar (0-sample gap, click-free, 5 ms crossfade): the crossfade is applied in the AudioWorklet across the ring boundary, not in the decoder.

### 3.3 V3-E3 — Tempo / pitch at non-1.0×
- One master stretch worklet (SoundTouchJS, MPL-2.0 per TSD-P1-14) on the master bus.
- The decoder window scheduler widens proportionally when playbackRate != 1.0 (e.g. at 0.5× the window becomes 40 s wall-clock to cover 20 s of output).
- Pinned R-I1 bar unchanged (0.5–1.5×, ±6 st, added latency <= 100 ms).

### 3.4 V3-E4 — Browser matrix
| Browser | Opus in WebCodecs | Fallback |
|---|---|---|
| Chrome ≥ 94, Edge ≥ 94 | ✓ (primary) | n/a |
| Firefox ≥ 130 | ✓ | n/a |
| Safari ≥ 17.4 (iOS 17.4) | partial (CAF/Opus); verify in-browser | fall back to **variant S** (sequential full decode) with warning that memory may be tight for songs > 4 min |
| Older | n/a | upload-only mode, mix playback via `<audio>` element (variant C per T-E2) |

Capability detection on page load via `navigator.userAgent` + `AudioDecoder.isConfigSupported({codec:'opus', sampleRate:48000, numberOfChannels:2})`. T-E2 open item (c) — Safari verification — is a Phase 1b gate (V3-TE2b).

### 3.5 Files added / replaced vs TSD-P1-11..15
| Pinned TSD task | V3 change |
|---|---|
| TSD-P1-11 engine core | **REPLACED by V3-E1 impl**: `apps/web/src/lib/play/engine.ts` interface unchanged; graph now reads from Int16 rings rather than `AudioBufferSourceNode`s |
| TSD-P1-12 stem swap | **UNCHANGED** (same sample-index swap, now across rings) |
| TSD-P1-13 A-B loops | **UPDATED** per V3-E2 wrap/seek |
| TSD-P1-14 tempo/pitch | **UNCHANGED** (SoundTouchJS; window widening per V3-E3) |
| TSD-P1-15 memory fallback | **OBSOLETE**: V3-E1 is itself the fallback; this task becomes "capability detection + Safari-S fallback + warn-on-mobile" (V3-E4) |

### 3.6 Engine acceptance (new)
- **T-V3-E2 memory on reference laptop**: peak <= 320 MB (safety margin below the 400 MB pinned bar) on 2020 4-core Chrome; measured on real hardware (closes T-E2 open item (d) — "re-run on the reference laptop").
- **T-V3-E3 Safari-S path**: variant S at 240 s × 6 stems peaks <= 400 MB on Safari 17.4+ (per T-E2 variant S number 885 MB server-headless proxy; INFERRED laptop ~500–700 MB; **may force a 3-min song cap on Safari pending measurement**).

---

## 4. Spotify link resolver (worker-side) — **REWRITTEN per adversarial review F-C4 (ISRC source)**

Scope: Spotify link → canonical track metadata (artist, title, duration, ISRC when available) → YouTube match via `ytsearch`. V3 **replaces Spotify Web API as PRIMARY** with a licence-safe lookup chain. Spotify's Web API ToS includes a commercial-restriction clause (Developer Terms §II.1.i.iv-v "Prohibited Uses: commercial purposes") that creates ambiguity for a paid product; **MusicBrainz is CC0 and has no commercial restriction**.

### 4.1 Resolver service shape (unchanged structurally)
- Worker-side (NOT a separate service): same Fly app, same consumer, invoked when `input_kind='spotify'`, status transitions `resolving` → `awaiting_confirm` (confidence < 0.8) → `queued`.
- Lookup chain (**NEW ORDER per F-C4**):
  1. Parse Spotify URL → extract `spotify_track_id` from path.
  2. Fetch Spotify public page meta (`og:description`, `music:duration`, no auth, respects robots.txt) with pinned UA — gives artist, title, duration.
  3. **PRIMARY ISRC: MusicBrainz** (`https://musicbrainz.org/ws/2/recording/?query=artist:"X"+recording:"Y"+dur:...&fmt=json`). CC0 data, no commercial restriction, rate limit 1 req/sec per IP (polite UA required). Caches with 30-day TTL in `isrc_cache` table (key = `spotify_track_id`, value = `isrc`).
  4. **FALLBACK: iTunes Lookup API** (`https://itunes.apple.com/search?term=...`). Free, no ISRC but gives verified duration + 30s preview URL for a confidence sanity-check. Rate limit ~20 req/min per IP.
  5. **DROPPED: Deezer** (NC terms — Deezer API ToS §4.2 restricts to non-commercial use). The `DEEZER_ISRC_ENABLED` env is REMOVED. The P75 spike remains in evidence as reference.
  6. **DROPPED (demoted to tertiary fallback behind opt-in flag): Spotify Web API** — kept behind `SPOTIFY_WEB_API_ENABLED` env (default `false`). Jon decides pre-Phase-5 whether to flip on; if on, we need to resolve the ToS commercial-use question with counsel first. For now treat as inactive.
- `ytsearch` ISRC first (when MusicBrainz returned one), then "artist − title" with duration tolerance ±3 s → scorer picks top 1 + 2 alts.

### 4.2 ISRC cache & rate-limit shape
- One new table `isrc_cache` (migration `013_v3_commercial.sql`): `(spotify_track_id text PK, isrc text, source text CHECK IN ('musicbrainz','itunes','manual'), fetched_at timestamptz, expires_at timestamptz)`. RLS: `cowork_ro` read, `stemloops_app` write.
- Worker-local token-bucket limiter (MusicBrainz 1 rps; iTunes 15 rpm) in `apps/worker/src/worker/isrc/limiter.py`. Falls back to a short backoff on 429.
- Daily report `v_isrc_sources` (MV): count of ISRC hits by source. Any day where MusicBrainz hit-rate < 70% triggers a Sentry warning (points to a UA-blocking or rate issue).

### 4.3 Entitlement + match card UX
- Phase 1a: **link ingest is free-tier only (§1.2a)**. There is no "Spotify is Pro-only" entitlement check — Spotify link ingest would be part of the free tier's monthly allowance. ⟲ **v1.8:** Spotify has **no implementation at all** — no downloader, route or error code — and has been removed from `plans.services`, so it is no longer advertised on /pricing. The guard check is `check_processor_separation` (§1.3), not `fetch_service:spotify`.
- Match card (`MatchCard.tsx`, TSD-P1-18) adds a "Buy credits to run this through our Studio engine" footer when the user has exhausted their monthly allowance and the match is high-confidence (A/B behind flag `V3_MATCH_UPSELL`).

### 4.4 Open items from PRD §2 that this delta resolves
- "ISRC via Spotify Web API" — **REVERSED** (V3 §4.1). Primary is MusicBrainz; Spotify Web API gated behind env flag + legal review.
- Apple Music / Tidal: still Phase 4 per PRD R-A4.
- Deezer: officially **removed from scope** per F-C4 (NC terms incompatible with paid product).

---

## 5. Fetch reliability + fallback chain — **UPDATED per adversarial review F-X3 + Control Room 1.1**

### Current T-F1 state (per Control Room answers 2026-11-02)
- T-F1 days 2+3 **NOT RUN YET**; wake jobs disabled or pending (operator action required to kick them off).
- Day 1 + day 2 pooled path c (yt-dlp, no proxy) = **~82% effective** (34/45 day 2, 85.6% day 1).
- **No path has hit 95%** across all 3 days as the pinned PRD required.
- SL19 proxy likely has a **password-length mismatch (10 chars configured vs 68 chars expected)** — Jon to re-collect all 4 proxy fields (host, port, user, password) from IPRoyal dashboard before retesting path a.

### 5.1 Phase 1 entry gate — **CHANGED per adversarial review F-X3**

**OLD gate:** T-F1 ≥ 95% across all 3 days before Phase 1 start.

**NEW gate (per F-X3, LOCKED):**
> T-F1 ≥ **90% within 2 attempts** (allows retry to succeed) AND **own-file p95 < 2s proven on 100 real sessions**. Link-fetch can degrade to an **opt-in beta on free tier** without stopping the product.

**Rationale:** V3's commercial surface (Credits, Pro, Studio) is **own-file only (§1.2a)**. Link-fetch is the free-tier marketing surface; a 90%-within-2-attempts link path with "retry" button UI is a product the user can live with. Blocking the entire V3 launch on a 95% YouTube bar is a wrong call now that paid revenue is decoupled from link-ingest.

### 5.1a Own-file-primary pivot (V3-F1)
At V3 launch, the **primary surface is own-file upload**. The homepage CTA leads to the upload box; the "paste a link" affordance is secondary and labeled "beta — may fail, retry works for most". This matches the processor-separation story and converts the T-F1 risk from a critical-path blocker to a known limitation of the free-tier marketing path.

### 5.1b Planning branches (post-T-F1 completion when it runs)
| T-F1 final outcome | V3 implication |
|---|---|
| **(α) ≥90% within 2 attempts** (new target) | Launch V3 with the own-file-primary pivot. Link-fetch labeled beta. Keep IPRoyal proxy credentials ready as path-a reserve (opt-in via `kill_switches.use_proxy_reserve`, default off). Jon re-collects SL19 fields pre-Phase 1a. |
| **(β) <90% within 2 attempts** | Link-fetch disabled on launch (`fetch_youtube=false`); only own-file + Spotify-metadata + MusicBrainz chord lookup (no audio) available on the free tier's link path. **Variant Y (§5.4) becomes the sole free-tier link experience** — tab-capture overlay against the official YouTube IFrame. |
| **(γ) Mixed per-service** | Per-service switches `fetch_youtube`, `fetch_spotify_audio` (default off), `fetch_soundcloud`. |

### 5.2 Fetch chain reorder (confirms pinned TSD §2 Phase 0)
Order (V3 unchanged from pinned, modulo branch α dropping the proxy):
1. yt-dlp with mweb + PO token via sticky residential proxy, 2 attempts on a fresh exit IP (TSD-P0-4);
2. yt-dlp without proxy (new path, enabled when branch α holds; under `fetch_proxy_strict=false`);
3. Cobalt (default off per TSD-P0-1; stays off);
4. tab capture (Phase 4; Chrome/Edge desktop);
5. "upload your own file" — always on.

### 5.3 Observability on the fetch path (V3 add)
- Daily report: block rate per path over 3 days (feeds the Phase 4 trigger: PRD §12 BUILD-R §9 "> 10% blocked over 3 days").
- Sentry breadcrumb: every attempt row's `fetch_attempt_id` is attached to the Sentry event so a user-reported failure can be joined to the DB row.
- NEW: `v_fetch_success_by_source` MV — slices success rate by `input_kind` (`youtube_link`, `spotify_link`, `soundcloud_link`, `upload`) and by day. The own-file row MUST stay > 99% as a canary.

### 5.4 Variant Y (Chordify-style free-tier chord overlay) — **moved up from Phase 4 to Phase 2 fast-track (V3-Y1, per Jon 2026-11-02T22:45 + adversarial review Lens B)**

> 🟡 **RECLASSIFIED 2026-11-10 (v1.5): Variant Y is NO LONGER ON THE LAUNCH PATH.** It existed *because of* the constraint struck through below, and that constraint is now overridden. With server-side separation permitted on the link path, chords come from the **server-side provider pass** (already wired end to end) and playback is of **our own stems** — so the launch path depends on **none** of: the WASM librosa port (`ChordOverlay.tsx:15`), ONNX Runtime Web, ChordNet 2E1D (PR-Y1.4), tab-capture, or the Chrome/Edge-only `getDisplayMedia` matrix. Variant Y is **optional future work**, not deleted: `apps/web/src/chord/*` and issue #135 stand. **Everything below this banner is retained for that future, and is not a launch requirement.**

**What it is:** The PRD's Variant Y (official YouTube IFrame + browser tab-capture `getDisplayMedia({audio:true})` + real-time chord detection on the captured audio stream). This matches Chordify's architecture — the chord overlay lives alongside the IFrame, never on a downloaded audio file.

**Why move it up:** 
- Processor-safe: on the "paste a link" happy path, **the free tier never fetches audio on our servers**. Audio stays within the user's browser (tab-capture, 100% client-side chord detection — the chord model runs in WASM on the client).
- ~~Stem separation on the free-tier link path is NOT offered. Stems come only via file upload (paid tier, §1.2a). This is the direct processor-exposure mitigation that moves Lens B from 84 to 90+.~~
  > 🔴 **OVERRIDDEN BY JON, 2026-11-10 — DO NOT FOLLOW THE STRUCK-THROUGH LINE.** *"I want stems from a youtube link."* / *"APPROVED — I do not care about the legal risk decision."* **Link-path stem separation is PERMITTED.** The original reasoning is preserved above, struck through, deliberately: it is the audit trail, not an instruction. The Lens B 84→90+ exposure it removed is now **accepted by the owner**. See the v1.4 → v1.5 changelog for the full record. Stems are consequently **no longer paid-tier-only** — §1.2a's paid/free separation rule is otherwise unamended and must be revisited when Stripe lands.
- Chord-only is the Chordify model and has clear precedent as fair-use adjacent (teaching/practice annotation).

**Delivery (Phase 2):**
- `apps/web/src/components/VariantY/` — IFrame wrapper + tab-capture button + WASM chord detector + overlay UI (uses the pinned chord panel component from TSD-P2-6 with a different data source).
- Chord detector: run the Phase-2 **ChordNet 2E1D student** model (PR-Y1.4) via ONNX Runtime Web (WebGPU preferred, WASM fallback). Server-side chord ground truth is the **Klangio bridge** (PR-Y1.1) for Month 1 and the same ChordNet 2E1D model (hosted) thereafter; `allin1` is a structure-analysis model (beats/downbeats/sections) and is **not** a chord recognizer — all chord references point at the chord-recognition provider per **decision record v1.3 (`claude/phase-2-y1-chord-model-decision.md`)**. This is new engineering; **Phase 2 lane L2-VARIANT-Y**.
- Supported browsers: **Chrome ≥ 94 / Edge ≥ 94 desktop only** (tab-capture requires `getDisplayMedia({audio:true})` on a tab-source with the audio track honored).
- **Unsupported browsers** (block + show incompatibility banner):
  - **Firefox** — `getDisplayMedia({audio:true})` silently drops the audio track on tab/window sources (confirmed session-5 audit); the chord overlay would receive no audio and look broken. Explicitly dropped from the supported matrix in v1.4.
  - **Safari (desktop and iOS)** — no `getDisplayMedia` for tab audio on Safari 17; iOS Safari has no `getDisplayMedia` API at all. Mobile Chrome/Edge likewise.
  - **UX:** on an unsupported browser, feature-detect at page load and **do not render the "start chord overlay" button**; instead render an inline banner — "Chrome or Edge required to enable the chord overlay. Your browser does not support tab-audio capture." — pointing to a short help page. Never surface a click-through button that would fail silently.
- Reqs: V3-Y1 pass bar = chord detection median latency < 500 ms end-to-end on 2020 4-core laptop Chrome; chord accuracy within 2% of the **server-side chord-recognition provider** (Klangio bridge → ChordNet 2E1D student per PR-Y1.1 / PR-Y1.4; decision record v1.3) on the 20-song eval set.
- Entitlement: no credit charge, no Pro requirement. The free-tier **monthly** quota applies (5 tracks / month as of v1.8) — there is no daily cap.

### 5.5 Vercel REST uploader footgun (NOTE — Control Room answers)
`evidence/health-check/vercel-deploy.mjs` currently **hard-codes `NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT=true`**. This is a V3 pre-deploy footgun: a V3 deploy must not re-enable or override that env from a baseline script. **Fix before any V3 deploy script merges.** Phase 1a entry pre-work item for the operator. (D-1 open question is RESOLVED separately: YouTube input IS intentionally ON in prod since 2026-07-18; the fix is to the RESTORE doc wording in `08-runbooks.md` §5, not to the deployed state.)

---

## 6. New API routes (V3)

All routes return the pinned error shape `{error_code, message}` (TSD §3). Rate limiting per plan tier (§1.4). Entitlement guard (§1.3) applied before any work.

### 6.1 Billing routes (`apps/web/src/app/api/billing/*`) — **RECONCILED to shipped Phase 1a code per audit 2026-11-03**

**Reconciliation notes (what changed vs the 2026-11-02 draft):**
- `POST /api/billing/checkout` was unified: one route accepts **either** `plan_code` (subscription) or `pack_code` (one-time credits), not both. This drops the separate `POST /api/billing/credits/checkout` route from the draft — the single-route shape keeps auth, rate-limit, and provider-abstraction in one place (TSD §1.1).
- Trial grant/consume moved from `POST /api/billing/trial/start` to `POST /api/users/me/trial/*` (user-scoped). Shipped in PR #39 with per-user idempotency (PK on `trial_grants.user_id`; see §1.5a channel separation). The 2026-11-02 draft's "per-fingerprint idempotency" wording was a stale half-fix — removed per session-6 audit.
- `GET /api/billing/subscriptions` and `GET /api/billing/invoices` are **deferred to Phase 1b** — not blocked by Phase 1a; the Customer Portal (`POST /api/billing/portal`) covers the user-facing listing path in the interim.

| Method/Path | Purpose | Input | Output / Errors | Phase |
|---|---|---|---|---|
| POST `/api/billing/checkout` | Create Checkout session for a Pro/Studio subscription **or** a one-time credits pack (exactly one code required) | `{plan_code?: 'pro'\|'studio', pack_code?: 'credits_20'\|'credits_60'\|'credits_180', promo_code?: string}` | 200 `{checkout_url}` ; 401 `UNAUTHENTICATED` ; 400 `CHECKOUT_FAILED` (unknown code, both codes supplied, neither supplied) ; 400 `INVALID_PROMO` ; 409 `ALREADY_SUBSCRIBED` (plan path only) | 1a ✅ |
| GET `/api/billing/credits/balance` | User's current credit balance (reads `v_credit_balance`) | — | 200 `{credits_remaining: int, purchases: Purchase[], recent_consumption: Consumption[]}` ; 401 | 1a ✅ |
| POST `/api/billing/portal` | Open Customer Portal (recurring customers only) | `{returnUrl}` | 200 `{url}` ; 401 ; 404 `NO_CUSTOMER` | 1a ✅ |
| POST `/api/billing/webhook` | Stripe webhook endpoint (verifies signature) — handles `checkout.session.completed` (recurring + one-time), `invoice.paid`, `customer.subscription.updated`, `charge.refunded` | raw body | 200 (idempotent) ; 400 `BAD_SIGNATURE` ; 500 `WEBHOOK_HANDLER_ERROR` (logs + Sentry) | 1a ✅ |
| POST `/api/users/me/trial/grant` | Grant the 3-song trial (one-per-user-ever — PK on `trial_grants.user_id`; no card). See §1.5a channel separation — trial is the link-ingest branch (`input_kind='youtube'`). | — (no body) | 200 `{granted: bool, songs_remaining: int, expires_at: string, expired: bool}` (idempotent — a re-call returns `granted=false` with the existing row) ; 401 `UNAUTHENTICATED` ; 503 `TRIAL_UNAVAILABLE` | 1a ✅ |
| POST `/api/users/me/trial/consume` | Decrement the caller's trial grant by one song (atomic in same tx as job INSERT per PR #39 round-2 fix when called from `/api/jobs`; this HTTP route exists for tests/ops and shares the same `consumeTrial` body). | — (no body) | 200 `{ok: true, songs_remaining: int, expires_at: string}` or 200 `{ok: false, reason: 'no_grant'\|'expired'\|'exhausted'}` ; 401 `UNAUTHENTICATED` ; 429 `rate_limit_burst` ; 503 `TRIAL_UNAVAILABLE` | 1a ✅ |
| GET `/api/billing/subscriptions` | List current user's subs | — | 200 `{items: Subscription[]}` ; 401 | 1b ⚪ |
| GET `/api/billing/invoices` | List invoices from provider | `?limit=20` | 200 `{items: Invoice[]}` ; 401 | 1b ⚪ |

**Trial error-code reconciliation (session-6 audit):**
- `TRIAL_ALREADY_USED` 409 is **not emitted** by shipped code. A re-call of `POST /api/users/me/trial/grant` is an idempotent no-op that returns 200 with `granted=false` and the existing row's state — no 409. The code is reserved for future use if we ever need to distinguish "already used" from "just granted" at the HTTP layer; for now, clients discriminate on the `granted` boolean.
- `TRIAL_EXHAUSTED` 402 **is** emitted — surfaced by `enforceEntitlement` in `apps/web/src/lib/billing/entitlements.ts` (see §1.3). The `/api/users/me/trial/consume` route itself returns `ok: false, reason: 'exhausted'` (200) rather than a 409; the 402 is for the entitlement path, not the consume path.

**Request body convention:** snake_case (`plan_code`, `pack_code`, `promo_code`) across all billing routes. The 2026-11-02 draft table used mixed camelCase (`planCode`) and snake_case; shipped code is snake_case throughout.

### 6.2 Entitlement routes
| Method/Path | Purpose | Input | Output |
|---|---|---|---|
| GET `/api/entitlements` | Current user's effective entitlements | — | 200 `{plan_code, period_start, period_end, jobs_used, jobs_quota, services:string[], export:{stems:bool, wav24:bool}}` ; 401 unauth returns the anonymous entitlements envelope (free plan limits by IP) |

Cache-Control: `private, max-age=15`. Mutations to this view go through webhook; the client re-fetches on `visibilitychange`.

### 6.3 User routes
| Method/Path | Purpose |
|---|---|
| GET `/api/users/me` | profile + plan code |
| PATCH `/api/users/me` | update `display_name`, `marketing_opt_in` |
| POST `/api/users/me/claim-jobs` | V3-U3 anon→authed stitching |
| DELETE `/api/users/me` | account deletion (cascades per DDL §2.3) |

### 6.4 Play route
| Method/Path | Purpose |
|---|---|
| POST `/api/jobs/play` | Convenience wrapper around `POST /api/jobs` that always requests the V3 Play block; equivalent to `POST /api/jobs` with `play=true`. Added as a stable name for Phase 1b clients; the underlying route stays `/api/jobs`. |
| GET `/api/jobs/:id/play` | Same payload as `GET /api/jobs/:id` but **only** the `play` subtree (`match`, `mix`, `w0`, `stems`, `analysis`). Faster poll body. |

### 6.5 Admin routes (operator only, V3-C7)
Behind Supabase RLS on an `operators` table (seed = Jon's user id). Not exposed in the public API surface:
- POST `/api/admin/plans` manage plans
- POST `/api/admin/users/:id/plan-override` manual grants (customer support)
- POST `/api/admin/kill-switches/:scope` wrap of the pinned CLI (TSD §3.6)

### 6.6 Contract types
All new types regenerate into `packages/types/src/generated.ts` via the existing codegen (`packages/types/scripts/codegen.mjs`), per pinned TSD §3.2. One extra codegen input: `apps/worker/src/worker/billing/models.py` (new).

---

## 7. Observability deltas

| Signal | Where | Tool |
|---|---|---|
| Stripe webhook received | `job_events` kind=`billing_webhook` + Sentry breadcrumb; **PII not logged** (no email in event payload) | Sentry (existing) |
| Checkout started / completed | `usage_events` kind=`checkout_started`/`checkout_completed` | PostHog (new; opt-in; via feature flag `V3_ANALYTICS`) |
| Entitlement denial | `usage_events` kind=`entitlement_denied` with `detail.action` | — |
| Play opened | `usage_events` kind=`play_opened` with `detail.{stage, from_cache}` | — |
| Fetch attempt (existing) | `fetch_attempts` + Sentry breadcrumb | Sentry |
| Email sent | `job_events` kind=`email_sent` | — |

Dashboards (Supabase SQL + Postgres materialized views, refreshed hourly by a cron on the worker):
- `v_revenue_mrr`: MRR by plan.
- `v_funnel`: `job_created → entitlement_denied | job_completed`.
- `v_activation`: % of new signups that reach `play_opened` within 24 h.
- `v_support_queue`: `past_due` subscriptions and `job_events` where kind=`email_bounced`.

Sentry: NO payment data; webhook payloads SCRUBBED (same scrub list as pinned TSD + add `/^stripe-signature$/`, `/^authorization$/`, `/.*email.*/`, **`/^x-vercel-sc-/`**, **bearer tokens `/[Bb]earer\s+[A-Za-z0-9_\-.=]+/`**). Extends open-item SL-B10(a) header scrub list.

**SL-B10a FIX (per Control Room top-3 #3):** Move `apps/web/instrumentation.ts` **into the `src/` subtree** (`apps/web/src/instrumentation.ts`) so Next.js picks up server+edge instrumentation; the current root-level file is ignored by the Next.js 14+ `src/`-dir convention. Scrub-list extension lands in the SAME PR as this move. **Phase 1a critical-path item.**

---

## 8. Rollback contract (critical — Jon's clean-rollback requirement)

### 8.1 Feature flag `ENABLE_V3_PLAY`
Three surfaces, read in this priority order (first non-null wins), cached 30 s:

1. **Env var** `ENABLE_V3_PLAY` on Vercel (web) and Fly (worker). Default: `false` through all V3 phases; flipped to `true` at Phase 5 go-paid.
2. **DB kill-switch** `kill_switches.scope='v3_play'` (`enabled=true` means V3 is OFF; same semantics as pinned TSD §3.6). Allows a sub-30 s rollback without a redeploy.
3. **User-level override** `users.v3_beta_opt_in` (bool). Lets Jon beta the V3 Play while env + switch both say "off" for public.

### 8.2 Switch surface — what each surface does (**rollback contract clarified per Jon 2026-11-02T22:45**)

**Rule:** `ENABLE_V3_PLAY=false` MUST produce **exactly today's product (unchanged)**. `ENABLE_V3_PLAY=true` produces the full V3 Play experience. No partial states; no "V3 UI but no billing" or "billing but no V3 engine" — the flag is the single master switch.

> 🔴 **SUPERSEDED for the launch defined in §12 — 2026-11-10 (v1.7).** The M-9 review found there is **no state of this flag in which §12's launch is shippable**: §12 ships the V3 engine **free, before Stripe, with Variant Y off the path**, which `true` forbids (it enforces paid tiers and activates Variant Y) and `false` forbids (it mandates exactly today's product, while V3-J2 changes the worker and the `Job` contract). **§12 is authoritative; this rule is not a launch gate.**
>
> ⚠️ **And `ENABLE_V3_PLAY` does not exist in code** — 0 hits in the codebase, 8 in this document. The tracker has recorded this since session 8. So this section describes a switch that was never built, and **rollback is promote-previous-deployment**, not a flag. The whole of §8.2 needs rewriting against reality; **that rewrite is deliberately NOT in v1.7**, which is a corrections pass, and is recorded in §11 instead.

- `ENABLE_V3_PLAY=false` and switch off and no user opt-in:
  - `/play` page returns the pinned-TSD UI (variant R from TSD-P1-17): mix-first, w0 then full stems, no V3 engine, no auth.
  - `POST /api/billing/*`, `POST /api/billing/credits/*`, `POST /api/users/*`, `POST /api/jobs/play`, `GET /api/entitlements` return 404 `NOT_FOUND` (routes are present but hidden).
  - `POST /api/billing/webhook` is reachable but logs-and-200s silently without touching DB (idempotent no-op) so Stripe does not retry forever when the switch is off during a controlled Stripe-connected test.
  - `GET /api/jobs/:id` has no `play` block **in V3-shape**; the existing shape is served.
  - **The product behaves exactly as `stem-loops-com-2026-11-02`** (the tag). Byte-equivalent `/play` HTML snapshot is a Phase 5 drill-1 acceptance test.
- `ENABLE_V3_PLAY=true`:
  - V3 Play engine, auth, billing routes exposed, Credits + Pro + Studio tiers enforced, Variant Y active on free-tier link path, MusicBrainz ISRC chain enabled, own-file-primary pivot active. (Patreon tier removed per Jon 2026-11-03.)

**Rename note (per Jon 2026-11-02T22:45):** The old req IDs `V3-R-BILL-PROMO` and `V3-R-BILL-TRIAL` are kept as aliases (now V3-C9 and V3-C10 respectively). The `ENABLE_V3_PLAY` feature flag stays as the master kill switch — no new flag name.

### 8.3 Code organization that keeps the switch cheap
- All V3-specific business logic lives under `apps/web/src/lib/v3/*`, `apps/web/src/app/api/billing/*`, `apps/web/src/app/api/users/*`, `apps/worker/src/worker/billing/*`.
- The pinned code paths are not changed by V3 except where the switch is read. Example: `POST /api/jobs/route.ts` adds exactly one import and one call `if (await isV3Enabled()) { await enforceEntitlement(...) }`. If V3 is off, the pinned route runs unchanged.
- DB migrations are **additive only** (same rule as TSD §4). Dropping V3 means ignoring the new tables; nothing on the pinned tables is altered by V3 except the nullable `jobs.user_id` column (safe to leave; nullable FK is a no-op when always NULL).
- The ONE non-additive risk is the Stripe webhook endpoint: once registered, Stripe will send events to our URL. Mitigation: when the switch is off, the webhook endpoint logs and 200s silently without touching DB (idempotent no-op), so a late event cannot corrupt state.

### 8.4 Rollback drills (V3-R1 — must pass before Phase 5)
- Drill-1: flip `kill_switches.v3_play` ON in staging; measure that `/play` reverts to pinned UI in ≤30 s (same bar as T-K1).
- Drill-2: with the switch ON for 24 h, verify no V3 writes to new tables, and that a canary job on the pinned path still succeeds (`check.sh` + `canary.cjs` from `08-runbooks.md`).
- Drill-3: full code rollback — redeploy `stem-loops-com-2026-11-02` tag; verify V3 DB tables remain but unused; verify pinned product works end-to-end.

---

## 9. New requirement IDs (V3-*)

| Req | Phase | Pass bar | Test |
|---|---|---|---|
| V3-C1 | 1a | Stripe webhook signature verified in CI with recorded fixture; a wrong signature returns 400 | T-V3-C1 |
| V3-C2 | 1a | Three plans seeded; `/api/entitlements` returns correct `services[]` per plan | T-V3-C2 |
| V3-C3 | 1a | `enforceEntitlement` denies free Spotify with 402; denies when `jobs_used >= quota`; passes when under quota | T-V3-C3 |
| V3-C4 | 1a | 60/60 jobs succeed, 61st returns 402; metering match between `usage_events` count and `entitlements.jobs_used` | T-V3-C4 |
| V3-C5 | **5 (deferred)** | DMCA agent registered; terms page updated; link on footer | release gate (not CI); registration must start by Phase 1b Day 1 to beat eCO 2–4 wk processing |
| V3-C6 | 1a | Entitlement cache invalidated ≤5s after webhook; fail-closed on DB outage | T-V3-C6 |
| V3-C7 | 1a | Admin routes 403 for non-operator; 200 for operator | T-V3-C7 |
| **V3-C8** | 1a | Credit purchase: 20/60/180 credits granted on `checkout.session.completed`; `v_credit_balance` reflects within 2s | T-V3-C8 |
| **V3-C9** | 1a | Promo code applied via Stripe Coupons API; `promo_redemptions` row written; invalid code 400s cleanly | T-V3-C9 |
| **V3-C10** | 1a | 3-song trial, no card, one-per-fingerprint-ever, `TRIAL_EXHAUSTED` after 3 | T-V3-C10 |
| V3-U1 | 1a | Supabase Auth sign-up → `public.users` row + `entitlements` row within 2 s (trigger) | T-V3-U1 |
| V3-U2 | 1a | Magic-link + Google OAuth both succeed in Playwright | T-V3-U2 |
| V3-U3 | 1a | Anonymous job IDs attach to new user within 1 s of claim call | T-V3-U3 |
| V3-U4 | 1a | `handle_new_user` trigger idempotent (re-run leaves 1 row) | T-V3-U4 |
| V3-E1 | 1b | Peak browser RSS ≤320 MB on reference laptop, 6 stems × 5 min (margin below T-E2 bar) | T-V3-E2 |
| V3-E2 | 1b | A-B loop seam reseed <= 20 ms (closes T-E2 open (a)) | T-V3-E2b |
| V3-E3 | 1b | Tempo 0.5–1.5× maintains R-I1 added-latency ≤100 ms with D ring widening | T-V3-E3 |
| V3-E4 | 1b | Safari fallback-S honored on Safari 17.4; Chrome/Edge/FF stay on D | T-V3-E4 |
| V3-M1..M3 | 1a | Each email flow fires once per trigger (idempotent by id); bounces recorded | T-V3-M* |
| **V3-F1** | 1a entry gate | T-F1 ≥90% within 2 attempts AND own-file p95 <2s on 100 sessions | T-V3-F1 |
| **V3-Y1** | **2 — NO LONGER ON THE LAUNCH PATH (v1.5)** | Variant Y chord detection median <500ms E2E on 2020 4-core Chrome; accuracy within 2% of server **chord-recognition provider** (Klangio bridge → ChordNet 2E1D student per PR-Y1.1 / PR-Y1.4; decision record v1.3) on 20-song eval. `allin1` is a structure-analysis model, **not** a chord recognizer; wording corrected v1.4 | T-V3-Y1 |
| **V3-J1** | **LAUNCH** | Jon performs the full journey — YouTube link → stems → play along with a per-stem fader and a synced chord timeline — on a real song with his own guitar, and confirms it. **A green test suite is explicitly NOT a pass**. ⟲ v2.1: run as the **Phase A play-test gate** (3 songs on Jon's phone). ⟲ **v2.2: gate PASSED 2026-11-22 04:48:47Z** [L17] (§12.1, §12.16.1); whether a self-pasted link was among the 3 songs is not recorded | **owner acceptance**, not CI |
| **V3-J2** | **LAUNCH** | 6 full-length Opus stems retained and reachable by short-TTL signed URL for a real job id; **a `.wav` per stem downloadable**; all bound by the existing 24-hour expiry. ⟲ v2.1: stems retained and served (Opus playback) — met; the `.wav` stem **download** half is **superseded** (v1.8: `export_stems` false on every plan, no route); one retention rule with three answers (§12.2) | T-V3-J2 |
| **V3-J3** | **LAUNCH** | The chord under the playhead is the chord being heard, within a stated and measured tolerance. ⚠️ **Tolerance number, test id and clock source are still UNSPECIFIED** — see §11 | T-V3-J3 |
| **V3-J4** | **LAUNCH** | **REVISED v1.9:** any song is converted; one longer than 300 s is trimmed to its first 300 s (upload and link), Replicate never receives more than 300 s, and the job page says *"Using the first 5:00 of a M:SS track."* (v1.7 withdrew it; v1.8 reinstated it as a refusal.) See §12.5 | T-V3-J4: `test_link_duration_cap.py`, `test_upload_duration_cap.py`, `test_link_money_path_e2e.py`, `job-input-trim.test.mjs` |
| ~~**V3-J5**~~ | ⛔ **SUPERSEDED v2.1** → V3-PS* (phone-first) | ~~Chrome/Edge desktop pass V3-J1.~~ Kept as the record:  Unsupported browsers show a feature-detected banner, never a failing button | T-V3-J5 (historical) |
| **V3-J6** | — | **ID RETIRED in v1.7** to avoid collision: v1.6 used V3-J6 for the Dec-5 deadline, now **V3-J8** | — |
| **V3-J7** | ✅ **MET 2026-11-17** (§12.6) | Three different public YouTube links reach `done`. ~~**Currently 0%** — two measured failures 2026-11-10.~~ 3/3 on 2026-11-17 [L17 17:37Z]; kept healthy by the fetch canary (#307, #313) and V3-OP2. ⚠️ Depends on an external purchase (residential proxy), not on code | T-V3-J7 |
| **V3-J8** | **LAUNCH — dated** | V3-J1 validated by Jon's own use **before 2026-12-05**, when the Klangio bridge expires with no working replacement. ⟲ v2.1: the chords half moves to **V3-CH1** (DR-D1 deferred, brief 2026-11-28) | **date gate** |
| **V3-PS1** | ✅ **shipped** Phase A (A1) #333 `fdf4aae` | **Simple chords by default** (DR-D6). ⟲ v2.2 as shipped: Simple **hides chords shorter than 2 beats** (Jon 2026-11-21 [L17 21:35:02Z]; Detailed keeps them), **1 s** where there is no beat grid; same-root chords merge first; a span no chord holds for half its length shows "?"; measured 24.2 / 24.5 / 23.2 changes/min on the 3 demos (target ~22–25). Simple / Detailed toggle remembered per user (`localStorage`, try/catch); stored chord data unchanged (display layer). *v2.1 text:* any chord shorter than one beat merges into its neighbour; target ≤ ~20 changes/min | #333 tests + real-Chromium gates (chord-phone-view, chord-sheet-tap, chord-chip-fit, player-text-size in both modes) |
| **V3-PS2** | ✅ **shipped** Phase A (A1) #333 `fdf4aae` | Next-chord lead. ⟲ v2.2 as shipped: **Now ≥ 72 px at 100% of positions on every tested phone** (390×844, 360×800, 375×667, 390×664, with pills, strip and hint on screen [R333-R3]); **Next 44 px, 32 px only to keep the NEXT line**; degrade order: keep Now ≥ 72; keep the NEXT line while Next can shrink (44 px growing → 44 px → 32 px, full height then squeezed); only then drop the NEXT line and retry at 44 px [R333-R3 §2]; **neutral beat countdown** (#e0e0e0 / #737373, never amber); BPM and key 20 px; the dead chord-edit control hidden; Wake Lock held while visible. Full criteria: user stories v4.0.3 AC 1.3, 1.5, Story 3.3 | #333; real-viewport gates require 0 positions with Now < 72 |
| **V3-PS3** | ✅ **shipped** Phase A (A2) #331 `5717bb3` | **My-part pills on the play screen** (DR-D5): Guitar · Bass · Keys · Drums · Vocals (+ Other), each ≥ 44 px; tap 100% → 30% → muted → 100%; long-press solos / un-solos; never silent; the Mix button shows the state; the Mix sheet half-height and non-modal; `aria-pressed` + level labels. ⟲ v2.2: pills sit **below** the section strip | #331 never-silent property tests (24,576 Mixer-reachable gestures) + real-engine gate |
| **V3-PS4** | ✅ **shipped** Phase A (A3) #330 `4682594` | **Section tap = jump and play; long-press (500 ms) = loop** (DR-D4); long-press on another chip extends the run; tapping the active looped chip stops it; a ⟲ back-to-section-start button on the transport; keyboard equivalents | #330 tests; section-strip-fit gate |
| **V3-PS5** | ✅ **shipped** Phase A (A3) #330, strip rule #331 | **Neutral section names** ("Part N" + time), never the heuristic labels (DR-D2). ⟲ v2.2 as shipped: section colours are **new tokens** `--section-a/b/c` (#8fa6c9 / #98b59c / #b796b5; ≥ 4.36:1 on every surface; Jon approved [L17 17:26:31Z]); parts capped at 16 bars + 4-bar slack; chip rows by screen height (1 below 600 px, 2, 3 at ≥ 800 px), but **only 1 row with a "+N more" cue while the pills are shown** (orchestrator design call within DR-D2/D5 [L17 18:00:16Z]); rename later (Phase C) | #330 / #331; section-strip-fit gate |
| **V3-PS6** | ✅ **shipped** Phase A (A4) #332 `4bed0a6` | Home: the link box first with a Paste button; **sign-in before a link job starts** (the job is the user's own from the start; uploads still start signed out); phone nav 3 items; the chords-claim switch `CHORDS_CLAIMS` read at **build** (a Redeploy flips every claim surface; pages stay static); landing copy phone-first | #332 tests incl. journey j10; two-tab race 50/50 |
| **V3-LB1** | Phase B (B1) | **Library row kept after the audio expires, with a Re-make** of the same link (DR-D3). ⟲ v2.2: **a Re-make uses one monthly or trial song; an our-fault failure returns it** (PB-2, amends "free Re-make"); Free metadata kept past 24 h with Remove per row (PB-1); migration 043. Not built | — |
| **V3-LB2** | Phase B (B2, `[billing]`) | **Set lists** (issue #322): a "Demo set" that never deletes (MJC-D8), defined in code; user lists; create ≤ 2 taps, add 1 tap, "Next song" 1 tap. Plans: **Free, Pro and Studio** (Jon 2026-11-21 Free + Pro [L17 15:43Z]; Studio is a superset of Pro [PB r4.2 §0]). ⟲ v2.2: the app refuses (409) to delete an account that owns `is_demo` jobs (Q-C); migration 044. Not built | — |
| **V3-LB3** | Phase B (B3) | **"Try again"** on a failed song, capped at 2 (issue #321, MJC-D7). ⟲ v2.2: **link songs only** (Q-F); free retry, charged only if the original was refunded (PB-3); no outage breaker (Q-A); migration 045. Not built | — |
| **V3-LB4** | Phase B (B1) | Library search by title, recently played, BPM·key on rows. Not built | — |
| **V3-LB5** | ⏸ **DEFERRED** (Q-E, Jon 2026-11-21) | Saved chord corrections (≤ 2 taps, persisted, marked "yours"; #135). Removed from the workflow for now: the dead editor is hidden (#333); user stories 1.4 / 3.5 correction clauses DEFERRED; `/privacy` and `/terms` keep the disclosure of past saved `chord_edits` [L17 18:11:52Z, 18:13:06Z] | — |
| **V3-CH1** | dated: **2026-12-05** | New songs get chords on **≥ 90% of days** after the Klangio subscription ends, **or** every surface stops promising chords the same day (DR-D1; user stories v4.0.3 AC 1.11). Brief 2026-11-28 | date gate |
| **V3-OP1** | ✅ shipped | An our-fault link failure gives back the monthly song or trial song it used, once per job: #308 `3ec00e1` + migration **042** (applied staging + prod by Jon, verified 2026-11-21 04:01Z) | #308 tests (real PG in CI) |
| **V3-OP2** | ✅ shipped | First byte recorded (`ms_first_byte`); a stalled non-final download attempt is cut at 15 s; the final attempt is never cut: #327 `ddf1a18`, worker deployed run 44861295141. Tune from p99 after 1 week (QA-82) | #327 tests |
| **V3-OP3** | ✅ shipped | A worker restart drains the current job (SIGTERM, `kill_timeout` 300) instead of killing it: #309 `f2d076d`, deployed run 44811403150 | #309 tests |
| V3-R1 | pre-launch | Rollback drills 1–3 pass; drill-1 includes byte-equivalent `/play` HTML snapshot when flag OFF | T-V3-R1 |

---

## 10. Cross-reference checklist (for the WORKPLAN)

| V3 scope | Pinned TSD section | Pinned PRD/req | Pinned PHASE |
|---|---|---|---|
| Commercial layer | NEW (§1 here) | V3-C* | Phase 1a (new) |
| Users | NEW (§2 here) | V3-U* | Phase 1a (new) |
| Variant D engine | TSD §3.8 + TSD-P1-11..15 (impl replaced) | R-C1, V3-E* | Phase 1b (= pinned Phase 1 engine) |
| Spotify resolver | TSD §3.1 + TSD-P1-4..6 | R-A3 (tightened) | Phase 2 (per pinned PHASE-PLAN) |
| Fetch branching | TSD §2 Phase 0 + §3.1 | R-K1 (unchanged) | Phase 0 (done) + branch at T-F1 final |
| API routes | TSD §3 | V3-C/U routes | Phase 1a |
| Observability | — | — | continuous |
| Rollback contract | NEW (§8 here) | V3-R1 | Phase 0 pre-work + revisit each phase |

---

## 11. Still open for Jon (post-v1.1 amendment — items awaiting decision)

### Added 2026-11-10 (v1.7) — open items from the corrections pass

| # | Open item | Why it matters |
|---|---|---|
| ~~**O-1**~~ | ~~Can a 3-free stem-download allowance be enforced on an anonymous launch path?~~ **DECIDED by Jon 2026-11-10: require sign-up.** See the new **§12.9** — this pulls the authed path into launch scope | ✅ **CLOSED** |
| ~~**O-2**~~ | ~~The residential proxy~~ **DECIDED by Jon 2026-11-10: IPRoyal.** See the new **§12.10** — ~$7/GB, ≈100–170 jobs per GB | ✅ **CLOSED** |
| **O-3** | **What happens to chords on 2026-12-05** — keep the Klangio subscription, implement `autochord`, or resource ChordNet training | Chords stop that day. See §12.8. ⟲ v2.0: still OPEN (= DB-17). Jon 2026-11-17: *"LETS WAIT AND SEE"*; cliff 2026-12-05; options in §12.8 |
| **O-4** | **§8.2 needs rewriting against reality.** `ENABLE_V3_PLAY` does not exist in code (0 hits), and §8.2 describes it as the rollback master switch. Rollback is actually promote-previous-deployment | A rollback contract naming a switch that was never built is worse than none |
| **O-5** | **§12.3's sync tolerance is unspecified** — no number, no test id, no clock source (§3.1's `startFrame` vs `AudioContext.currentTime`) | V3-J3 is stated but not yet actionable |
| **O-6** | **COOP/COEP for `SharedArrayBuffer`.** §3.1's engine requires it; this document has zero mentions of COOP, COEP or `crossOriginIsolated`, and cross-origin isolation interacts with R2 signed URLs, hCaptcha, Stripe and Sentry embeds | Could block the engine late. Raised by the M-9 review |
| **O-7** | **Opus container, bitrate and demuxer are unspecified.** WebCodecs needs demuxed packets | V3-J2 is not fully actionable without it |
| **O-8** | **Reverse the §1.2a link-ingest separation for paid tiers?** Jon's 2026-11-11 pricing model gives Pro/Studio YouTube link import and takes it off Free. Not implemented in v1.8 — see that changelog. §1.2a calls the separation **NON-NEGOTIABLE** and credits it with moving adversarial-review Lens B from 84 to 90+ by keeping **payment-processor underwriting** clean; v1.5 reversed only the stems half and said this half *"must be revisited when Stripe lands."* | **Blocks the link-import row of the approved pricing table.** Until it is decided, /pricing names link import on Free only — which is what the code actually does |
| **O-8 ✅** | **CLOSED 2026-11-16 — REVERSED by Jon.** Pro and Studio get YouTube link import (migration 039; data-driven gate in `entitlements.ts`); paid link jobs metered like uploads and kept in the library; credits stay upload-only. Reason: a library of linked songs on paid plans. See v1.9 → v1.10 | Resolved |
| **O-9** | **Re-price review trigger: at 10 users OR 100 song sessions** (Jon, 2026-11-11: *"lets review this once we have 10 users OR 100 song sessions to get real cost per song from"*). Baseline 2026-11-11: **1 user, 5 jobs (4 done)**. SQL to check is in the PR body and in `claude/pricing-review-trigger-2026-11-11.md` | The approved margins rest on a **4-job, Replicate-only** cost sample |


### Open after 2026-11-17 (v2.0)

Shipped on 2026-11-17: #287 (pricing), #289 (Slice 0 `is_demo`), #288 (Slice 1a player) — §12.11–§12.13. What is still open, from [DP] *"In progress"* and its delivery plan, and [BB]:

| Item | What it is | Source |
|---|---|---|
| **DB-17** | Chords after 2026-12-05 — **open, "wait and see"**. See §12.8 and O-3 above | [DP] |
| ✅ **Slice 1b** | **v2.1: shipped #290 `4351160`.** Copy, titles, sign-up fixes (in progress). The design's Slice 1 also lists P7 copy true-today, P5 thumbnails from `video_id` and titles for new songs, and §8 analytics | [DP] |
| **Slice 2** (next) | **v2.1: Slice 2a shipped #302 `3a69c2c`** (demo routes, home live demo, rename; then "Song library", #316). The claim-on-sign-in redesign (P3.2) **[UNVERIFIED — not in #302's scope; no later PR found]**. **Demo routes** (`is_demo` read branch in `mayReadJob` and the page gate; explicit `is_demo` denial on download and loop cutting — which also closes the §12.11 Dashboard-deletion residue; static demo assets); **the new home page** with the live demo (P4); **the claim-on-sign-in redesign** (P3.2); **"Job history" renamed "Library"**; P2 runs are already in (§12.12) | [DP] §1, [#289] |
| **Slice 3** | **v2.1: not built; replaced by the design-review Phases B/C** (set lists #322 = V3-LB2, **Free + Pro** per Jon 2026-11-21, superseding Pro-only; section rename = Phase C). **Playlists** — Pro-only per DB-15 (a); P2 section rename; non-adjacent loops only if users ask (DB-14) | [DP] |
| ✅ **Chart-notation PR** | **v2.1: shipped #294 `18d84b5`.** The "See all chords" chart and the chord editor onto `lib/play/notation.ts` (P1.5 is partly met until then; §12.12). In progress, Jon approved 2026-11-17 21:39 PT | [DP], [BB2.3-A4] |
| ✅ **[billing] quiet credit buttons** | **v2.1: shipped #292 `6c95fcb`.** Signed-in `/pricing` still shows three lime "Buy credits" buttons, hard-coded in `BillingButton.tsx` (§12.13). In progress, Jon approved 2026-11-17 21:39 PT | [BB2.3-A3] |
| ~~**Staging catch-up**~~ ✅ | **DONE 2026-11-18.** Staging `_migrations` has 38 rows (001–040 minus the non-existent 010 and 036); 009, 011, 012 and 013–040 applied 2026-11-18; 004 recorded as pre-applied after verification; `jobs.is_demo` present; plans match prod; 0 jobs, 0 users (§12.11). Verified read-only by the orchestrator 05:08Z | Jon 2026-11-17 21:39 PT, *"a now"* / *"do it yourself"*; LEDGER-17 |
| **Migration re-run safety** | **v2.1: still open (no QA ID; the related QA-18 covers 014/034 re-runs reverting the plans catalog).** Migrations **004** (bare `ADD CONSTRAINT jobs_input_source_chk`) and **026** (9 unguarded `ADD CONSTRAINT`s) are **not re-run-safe**, despite the migrations README's claim that every migration is idempotent; a fix PR is planned | staging catch-up 2026-11-17/18 |
| **Demo static export** | **v2.1: [UNVERIFIED] — no record of it being done.** [DP] Slice 0 step (2): export the three demos' stems, chords and sections to the static demo host. **Not done** (§12.11) | [DP] §1 |
| ✅ **Key-detection bug** | **v2.1: fixed #295 `f7f3350`** (key from all stems, not the drums reference); deployed 2026-11-18. Diagnose why prod `musical_key` diverges from the same detector run locally (3/3 demos wrong, §12.11). Affects every user's song. Investigation PR in progress; the three demo rows were already corrected by a Jon-approved named write (2026-11-17 21:56 PT) | §12.11; LEDGER-17 |

### Open after 2026-11-21 (v2.1)

| Item | What it is | Source |
|---|---|---|
| **DR-D1 / V3-CH1** | Chords after 2026-12-05. Deferred by Jon; brief 2026-11-28; subscription ends 2026-12-05 | Jon 2026-11-21 |
| ✅ **Phase A (A1–A4)** | **v2.2: SHIPPED** — #330 `4682594`, #332 `4bed0a6`, #331 `5717bb3`, #333 `fdf4aae`; play-test gate PASSED 2026-11-22 04:48:47Z (§12.16.1). *v2.1:* V3-PS1…PS6; PRs #333 A1, #331 A2, #330 A3, #332 A4 open and in review; then Jon's play-test gate (3 songs on his phone) | Jon 2026-11-21; [DR]; [L17 04:48:47Z 11-22] |
| **Set lists** | Decided: Free + Pro (supersedes DB-15 (a)) (⟲ v2.2: Studio included as a superset of Pro — orchestrator reading [PB r4.2 §0], not a Jon decision); build in Phase B (V3-LB2) | Jon 2026-11-21 [L17 15:43Z] |
| ✅ **AGENTS.md product sections** | **v2.2: done** — #334 `c097792` merged 2026-11-21 17:14:19Z after Jon's "Merge 334". *v2.1:* One-time exception: a separate PR updates only the product-description sections; Jon reviews the diff | Jon 2026-11-21 [L17 15:43Z]; [L17 17:14:24Z] |
| **Phase B** | ⟲ **v2.2: re-planned** (§12.16.2): B0–B3; saved chord corrections (#135) **removed** (Q-E); section segmentation **→ Phase C** (PB-4). *v2.1:* V3-LB1…LB4, saved chord corrections (#135), section segmentation | [DR]; [L17 17:40:41Z, 18:11:52Z] |
| **M2 merge automation** | ⟲ **v2.2: see §12.16.3** (step 4 = two PRs; step 6 Sunday 2026-11-22). *v2.1:* Owner steps 1–5 and §5 steps 1–3 done 2026-11-17; §5 steps 4–6 (DB-10) after the design fixes | [L17 18:42Z 11-17], Jon 2026-11-21 |
| **Real-device phone test** | Locked-screen audio, iPhone silent switch, memory on a real iPhone and Android | [DR] review A/B |
| **Open issues** | #318 drain reported as KeyboardInterrupt; #319 Nov 19 artifact burst; #321 Try again; #322 set lists; #323 Klangio backfill; #286 j8 flake; #143 App secrets (⟲ v2.2: **closed** 2026-11-21 17:31:17Z); #135 chord-correction flywheel | GitHub, 2026-11-21 |
| **Open QA (every item the log does not mark closed)** | Open / queued: QA-10, 15, 17, 18, 19, 20, 57, 59, 62, 69, 70, 71, 74 (→ #318), 75 (→ #319), 77, 78, 79, 80, 81, 82, 83. Waiting on Jon: QA-08 (decision), QA-42 (real-device iOS test). Follow-up / watch / note: QA-23, 31, 33 (rest after #294), 43, 44, 51. QA-55 is "to fix" in the log but fixed by #304/#305 (log drift) | QA bug log, statuses 2026-11-21 04:40Z |
| **Staging R2 key** | Preview/Development `R2_*` rows point at the staging bucket with a key Jon must replace with a staging-scoped token | [L17 01:00Z 11-21] |


### Open after 2026-11-22 (v2.2)

State at 2026-11-22 ~04:58Z [GH]: `v3/main` = `fdf4aae` (#333); web production deployment of `fdf4aae` created 04:28:46Z; **0 open PRs** (before this PR); open issues **#323, #322, #321, #319, #318, #286, #135** (#143 closed 2026-11-21 17:31:17Z). No worker file changed in Phase A; DB migration level unchanged at **042**.

| Item | What it is | Source |
|---|---|---|
| **M2 step 4–7 (Sunday 2026-11-22)** | Finish pack **v1.4.13** (the M2 suite is 621/622 at `fdf4aae` after #332 deleted 3 CLASS_A files) and its delta review, then open PR-4a (G0 job + pack) → Jon runs G0 → PR-4b (pinned workflow diff) → step-5 script PR → step 6 (90-min freeze, no other merges) → step 7. Jon merges the workflow PRs (one-time exception) | §12.16.3; [L17 17:14:24Z, 18:13:06Z, 17:31:18Z 11-21; 05:03:21Z 11-22] |
| **Phase B build** | B0 + B2 first, then B1 and B3 (brief r4.2); every PR `needs-jon-approval`; Jon applies 043–045; runs in parallel with M2 but no merges in the freeze | §12.16.2; [PB r4.2] |
| **Q-B worker PR** | Refund outage-time `DOWNLOAD_BLOCKED` at the source; after Phase B; money path | [L17 18:11:52Z] |
| **DR-D1 / V3-CH1** | Chords after 2026-12-05: brief due 2026-11-28 (scheduled task); subscription ends 2026-12-05 | [L17 14:02:41Z 11-21] |
| **Phase A follow-ups** | QA-85 (pending-link URL kept in `localStorage`), QA-86 (fallback claim token untested), QA-87 (/privacy silent on the saved link), QA-88 (500–559 px windows with a notice bar scroll), QA-89 (#333 gate gaps T15/T17/T08b, G05 overlap test, F06c), QA-90 (Offline "?" spans; hint copy); uploads still start signed out; ~5 taps to first sound (AC 1.1 partial) | QA bug log v1.1; [L17 18:20:43Z, 04:18:02Z 11-22] |
| **Real-device phone test** | Locked-screen audio, iPhone silent switch (QA-42), memory on a real iPhone and Android: still open (the play-test passed, but the ledger records no device matrix) | [DR] review A/B; QA-42 |
| **Residual gap R9** | Quota-funded Pro/Studio upload failures are not restored; a re-upload costs another unit (pre-existing; not fixed by link-only B3) | [PB r4.2 §6 R9] |
| **Code-owner review record** | 0 GitHub reviews on merged code-owned PRs although ruleset 26478884 requires code-owner review; mechanism unexplained | [A-2]; [L17 17:31:56Z] |
| **Staging R2 key** | Unchanged from v2.1: Jon to replace the Preview/Development `R2_*` key with a staging-scoped token | [L17 01:00Z 11-21] |

#289's operator steps are done (v2.0.1): the demos were processed and flagged on 2026-11-18 04:47Z, and the R2 bucket has no lifecycle rules (§12.11). Still outstanding: the demo static export and the key-detection bug (rows above).

Items 1–6 below are the only remaining open items for Jon after the 2026-11-02T22:45 lock-in pass. Everything else in v1.0 that was open has been decided (processor, auth, pricing model, DMCA deferral, Variant Y promotion, Spotify ISRC chain). Numbered for clean reference:

1. **BC Ltd. / incorporation + CRA BN attachment** — Jon has a CRA BN but has **NOT** confirmed whether it is attached to a sole prop or an incorporated entity. **Flagged open but NOT a Phase 1a blocker** per Jon 2026-11-02T22:45. Lens C F-C1 stays open at MEDIUM priority. **If sole prop, must be resolved before Phase 5 go-paid** (Stripe payout flow for a Canadian merchant benefits from BC Ltd. for tax + liability reasons; sole prop is viable at launch but a known tax-planning sub-optimality). Pending Jon confirmation.
2. **SL19 proxy fields** — Jon to re-collect host, port, user, **password (currently 10 chars; expected ~68 chars)** from the IPRoyal dashboard. Blocks the "path a reserve" option in the Phase 1a fetch-chain config. Not a blocker if the own-file-primary pivot (§5.1a) proceeds and path a stays off by default.
3. **T-F1 days 2+3 run** — the wake jobs are disabled or pending; operator to kick off within 72 h so Phase 1a entry gate can be assessed under the new V3-F1 threshold.
4. **Spotify Web API tertiary fallback** — kept behind `SPOTIFY_WEB_API_ENABLED=false` (§4.1). Jon decides pre-Phase-5 whether to flip on; requires counsel review of Developer Terms §II.1.i.iv-v commercial-use question first.
5. **Studio tier scope vs Pro Monthly scope** — the $4.99 vs $12 differentiation is "recording + higher rate limits + priority queue" per Jon's locked list, but which recording features and what rate-limit ratio is still TBD before Phase 5 pricing-page copy ships.
6. **Stripe account creation + MCC 7372** — Jon's operator task Day 1 of Phase 1a. The merchant description (§1.1 verbatim) is binding at underwriting; Jon must not deviate from it when filling the Stripe application form.

### Items intentionally CLOSED by this amendment (vs v1.0 §11)
- ~~"Billing processor"~~ → Stripe LOCKED + Paddle adapter day-1 (§1.1).
- ~~"Auth provider"~~ → Supabase Auth LOCKED, three methods (§2.1).
- ~~"Plan pricing"~~ → Credits SKU LOCKED at $5/$12/$30 + Pro $4.99 + Studio $12 (§1.2). (Patreon $5 tier removed per Jon 2026-11-03.)

(The three "top-3" items from v1.0 are now closed. Items 1–6 above are the fresh open list.)
