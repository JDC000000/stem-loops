# TSD-V3-DELTA: Stem-Loops V3 (commercial layer + Play engine + Spotify + fetch) — delta over the pinned TSD

Author: SL-V3 architect lane. Date: 2026-11-10 (v1.5 amendment pass — Jon's play-along launch directive and the link-path stems override; see Changelog below). Status: DRAFT for Jon's review.
This document EXTENDS the pinned TSD at `stem-loops-handoff/07-roadmap/TSD.md` (SL21-tsd, commit c3f6a911 of `stem-loops`). It is a DELTA only — anything the pinned TSD covers (job state machine, kill switches, blocklist, fetch chain, loops/export, R2 layout, migrations 001–012) is NOT restated here, only cross-referenced by section number (e.g. `TSD §3.1`). All new requirement IDs are prefixed **V3-**; new tests prefixed **T-V3-**. Pinned reqs use their existing IDs (R-A0, R-X2, etc.).

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

**Explicitly OUT of scope for V3-J1**, per Jon's answer that the guitar is mixed in hardware: live audio input, input monitoring, round-trip latency budgets, and any `getUserMedia` path. The guitar never enters the browser.

**Pass bar:** Jon performs the journey end to end on a real song with his own guitar and confirms it. A green test suite is **not** a pass for V3-J1 — this requirement is defined by the owner's own use.

### 12.2 V3-J2 — stem retention and serving (NEW — blocking V3-J1)

**Measured gap, 2026-11-10:** `apps/worker/src/worker/storage/r2_uploader.py` exposes **`upload_input`, `upload_loop`, `upload_play_chords`** and **no `upload_stem`**; `packages/types` `Job` carries `loops?: Loop[]` and **no stems field**. Full-length separated stems are produced from Replicate, used to cut loops, and **discarded**. V3-J1 is impossible until they are retained.

Requirements:
- The worker **retains** the 6 full-length stems and uploads them under the job's R2 prefix.
- Stems are **Opus**, consistent with §3.1's engine assumption (*"the Opus-encoded bytes (compressed, 4–5 MB per stem)"*) and with `AudioContext` at 48 kHz to avoid resample cost.
- `Job` gains a stems collection; stem URLs are **short-TTL signed GETs** from the private bucket, matching the existing `loops` and `play-chords` pattern — never public objects.
- Stems obey the **same 24-hour expiry** as every other job artifact. The retention promise in §1.6a does not change.
- Adds R2 storage and egress per job. Bounded by the 24-hour expiry.

### 12.3 V3-J3 — chord / playhead synchronisation (NEW)

`ChordOverlay` already renders a timeline from `play.chords.json`. V3-J3 adds a playhead input and auto-scroll so the chord under the playhead is the chord being heard, within a **stated and measured** tolerance. The component's existing `onChordEdit` / `onChordLabelEdit` props stay unwired — the write path is incomplete (issue **#135**) and V3-J3 does not open it.

### 12.4 Sequencing

V3-J2 → V3-J3 → §3 engine + faders → **V3-J1 (Jon's own acceptance)** → §3.6 hardening. Loop download survives unchanged; the landing copy must be rewritten, since it currently sells loops and not play-along.

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

### 1.2 Plan tiers / SKUs (V3-C2) — **REPLACED per Jon 2026-11-02T22:45 (credits model LOCKED)**

| Tier | What | Price | Payment surface | Processor touches link-ingest? |
|---|---|---|---|---|
| **Free (forever)** | Link + file ingest, **3 songs/day**, device-fingerprint rate limited, no account needed | $0 | — | **NO** (free tier is zero-processor exposure) |
| **Credits (PRIMARY SKU)** | **20 songs $5** / **60 songs $12** / **180 songs $30**. Never expire. One-time charges. StemSplit-style model. | $5 / $12 / $30 | Stripe one-time Checkout | **NO** — own-file only |
| **Pro Monthly** (secondary) | Unlimited own-file processing, chord/section cache per account, promo codes work here | $4.99/mo | Stripe recurring + Portal | **NO** — own-file only |
| **Studio** | Recording, higher rate limits, priority queue | $12/mo | Stripe recurring + Portal | **NO** — own-file only |

Plan→feature mapping is in a `plans` table (DB-driven; not hard-coded) so adding/pricing a plan is a row insert, not a deploy. (Patreon "Founding Supporter" bridge tier removed per Jon 2026-11-03 — V3 relies solely on Stripe + Paddle adapter for monetization.)

### 1.2a Critical processor-exposure rule — **NON-NEGOTIABLE** (per adversarial review Lens B 84→90+)

**The paid tiers (Credits, Pro Monthly, Studio) NEVER touch the YouTube / Spotify / SoundCloud link-ingest path. Link ingest lives in the free tier forever.** (Patreon tier removed per Jon 2026-11-03.) This is the structural separation that keeps paid-tier processor underwriting clean:

- Any paid-tier action (credit decrement, Pro-gated feature, Studio queue priority) is gated on `input_kind='upload'`. The entitlement guard (§1.3) returns `PAID_LINK_INGEST_DISALLOWED` 400 if a paid-tier user attempts a link URL — the fallback is to use their free-tier 3 songs/day allowance instead (same anonymous rate-limit cohort).
- The DB enforces this: `credit_purchases` ledger decrements only on `job_completed WHERE input_kind='upload'`. A trigger (`check_credit_decrement`) rejects any attempted debit against a link-ingest job.
- Link ingest telemetry (`fetch_attempts`, Sentry breadcrumbs) carries NO `user_id` even when a logged-in user triggers it — the row is anonymous (`client_ip_hash` only). The free-tier RL cohort rules apply.
- **Rationale**: this is what moves adversarial-review Lens B (CAP, 84/100) above 90. The processor sees a software product that accepts audio uploads and sells credits — the merchant description in §1.1 remains truthful. The YouTube-link path is a free, no-processor-touch experience.

Price points LOCKED per Jon 2026-11-02T22:45. The $4.99 / $12 numbers are no longer planning placeholders — they are the launch numbers. Studio tier scope and Pro Monthly scope separation to be finalized before Phase 5 Jon approval.

### 1.3 Entitlement checks (V3-C3) — **UPDATED for credits model + processor separation (per Jon 2026-11-02T22:45)**

Every billable action goes through a single server-side guard: `enforceEntitlement(userId, action, context)`.
- Actions and when they are checked:
  - `create_job`: at `POST /api/jobs` (TSD §3.1), before admission and after the kill-switch gate. On free tier, blocks on `jobs_today >= 3` (device-fingerprint + IP cohort). On paid tier with `input_kind='upload'`, blocks on `credits_remaining <= 0` AND no active Pro/Studio subscription.
  - **`check_processor_separation`** (new): if the request carries `user_id` with ANY active paid entitlement (credits balance > 0, Pro, or Studio) AND `input_kind != 'upload'`, the guard either (a) routes the request to the anonymous free-tier cohort (preferred — transparent) or (b) returns `PAID_LINK_INGEST_DISALLOWED` 400 if the user has already used their 3 free songs today. This is the enforcement half of §1.2a. (Patreon-mapped entitlement check removed per Jon 2026-11-03.)
  - `fetch_service:<name>`: inside `create_job`, discriminated by host (`youtube | spotify | soundcloud`). All services available on free tier (link ingest is free tier only). Apple/Tidal remain Phase 4 trigger-based.
  - `export_stems`: at the signed-URL mint path (TSD §3.2 `GET /api/jobs/:id`). Free gets `mix` only; Credits/Pro/Studio get stems (if the job was `input_kind='upload'`); Studio gets WAV 24-bit.
  - `play_access`: at `GET /api/jobs/:id` when `play` block is requested.
- Guard order: kill switch → **processor separation** → entitlement → rate limit → admission (per TSD §3.1 M5 pattern). Guard runs in the request handler, not in the client, and is covered by T-V3-C3 (mutant: remove the guard → test must fail).
- `enforceEntitlement` returns a typed denial reason that maps to a user copy entry in `apps/web/src/lib/error-copy.ts`:
  - `FREE_DAILY_LIMIT` 402 → "You've used your 3 free songs today. Try again tomorrow, or upload your own file with credits."
  - `CREDIT_BALANCE_INSUFFICIENT` 402 → "You're out of credits. Buy 20 for $5, 60 for $12, or 180 for $30."
  - `PAID_LINK_INGEST_DISALLOWED` 400 → "Credits and Pro only work with files you upload. Paste a link into the free tier (3/day) instead."
  - `PLAN_EXPORT_UNAVAILABLE` 402 → "Stem export is on Credits, Pro, and Studio."
  - `SUB_PAST_DUE` 402 → "Your subscription needs attention. Open the billing portal."
  - `TRIAL_EXHAUSTED` 402 → "You've used your 3 trial songs. Buy credits to continue — $5 for 20."
- HTTP 402 Payment Required is used across the board; the body includes `upgrade_url` from the current Stripe Checkout session (credits-pack checkout for free, Pro for Credits users wanting unlimited).

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
- On sign-up, a client-side `claim_jobs` call (`POST /api/users/me/claim-jobs`) attaches any jobs from the current `client_ip_hash` (last 24 h) to the new `user_id`. Audit row in `job_events` kind `job_claimed`.
- History (`/history`) becomes user-scoped post-signup; anonymous history continues via the existing cookie.

### 2.3 DDL stubs — migration `013_v3_commercial.sql`

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
- Phase 1a: **link ingest is free-tier only (§1.2a)**. There is no "Spotify is Pro-only" entitlement check — Spotify link ingest is part of the free tier's 3/day. The guard check is `check_processor_separation` (§1.3), not `fetch_service:spotify`.
- Match card (`MatchCard.tsx`, TSD-P1-18) adds a "Buy credits to run this through our Studio engine" footer when the user has used their 3 free songs and the match is high-confidence (A/B behind flag `V3_MATCH_UPSELL`).

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
- Entitlement: no credit charge, no Pro requirement. Free-tier daily cap applies (3/day).

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
| **V3-Y1** | 2 | Variant Y chord detection median <500ms E2E on 2020 4-core Chrome; accuracy within 2% of server **chord-recognition provider** (Klangio bridge → ChordNet 2E1D student per PR-Y1.1 / PR-Y1.4; decision record v1.3) on 20-song eval. `allin1` is a structure-analysis model, **not** a chord recognizer; wording corrected v1.4 | T-V3-Y1 |
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
