# stem-loops: SEO and AI-search plan

**v1.7.1, 2026-11-14 (committed with Phase 0, branch `seo/phase-0`).** Edits to v1.7, no change of scope:
- **#270 wording.** Songs over 5 minutes are now trimmed to their first 5 minutes, not refused. Every "tracks up to 5 minutes" for stem-loops now reads "uses the first 5 minutes of any song" (or "the first 5 minutes of any song"), matching the landing, terms and root layout after #270. Competitor "files up to N minutes" cells are unchanged. The figure still comes from `MAX_TRACK_MIN`.
- **Stem order** (user stories, Story 2.1): drums, bass, guitar, keys, vocals, other.
- **REVIEW-8 should-fixes:** S1 (YouTube is never added to `SAME_AS`, §6.1 and SEO-22 acceptance), S2 (G7 routine-timing exemption in the `content-copy` minute rule, §4.4), S4 (SEO-26 links clips rather than embedding them, CSP `frame-src`). S3, S5 and S6 are not Phase 0 and stay open.
- The patch at `docs/seo/phase0-prototype.patch` is regenerated on `origin/v3/main` at `6ff7198` (#270). Two hunks in `app/(landing)/page.tsx` were resolved by hand; see the PR.

**v1.7, 2026-11-13.** v1.7 fixes `SEO/REVIEW-7.md`'s must-fix (v1.6 scored 89, a fail) and its S1, S2, S4 and S5. Earlier versions are kept: v1.6 as `SEO-AIO-PLAN-v1.6.md` (patch `phase0-prototype-v1.6.patch`), v1.5 as `SEO-AIO-PLAN-v1.5.md` (and its patch as `phase0-prototype-v1.5.patch`), v1.4 as `SEO-AIO-PLAN-v1.4.md`, v1.3 as `SEO-AIO-PLAN-v1.3.md`, v1.2 as `SEO-AIO-PLAN-v1.2.md`, v1.1 as `SEO-AIO-PLAN-v1.1.md` and v1.0 as `SEO-AIO-PLAN-v1.0.md`.

**Changes in v1.7**
- **M1 (our own free limit):** the §4.2 compare fact table gains a **stem-loops** column, every cell cited `file:line` at `6846062`, including **5 tracks a calendar month free** (`034_v3_pricing_model_truth.sql:118`), the same figure as Moises Free. Wording settled: we say **"free"**, never "Free plan" (§4.0 rule 8 and `landing-copy.test.mjs:320`); the `content-copy` rule now bans `Free plan` outside competitor cells. The SEO-16 brief says to state our own limits from code beside every competitor limit. §2 A3 and the "where we are better" row are reworded.
- **S1 (first-touch KPI):** the row now names a source per D-SEO-8 option and is **dropped under (d)**; GTM-A1's kill metric is read by Jon from GTM-G4's signup events.
- **S2 (D-SEO-5 vs D-SEO-8):** D-SEO-5 is now only about Vercel Web Analytics (cookieless page views) and no longer gates SEO-11.
- **S4 (truth-rule mutants):** a new `llms-txt.test.mjs` test bans YouTube, "downbeat", "under 60 seconds" and "no account needed" in `ENTITY_ONE_LINER`, `ENTITY_LIMITS` and the llms.txt body, and pins the chord "estimate" sentence. REVIEW-7's three survivors each now fail by assertion (7 pass, 1 fail in the two files); restored, 8 pass, 0 fail.
- **S5 (review gates for SEO-P0):** the brief states that M-9 applies and that M-11 applies too.
- **Patch:** regenerated at **`6846062`** (`origin/v3/main` after #240 and #214, both worker-only). `git apply --check -p0` is clean on a clean worktree. Full suite: **1,711 tests, 1,691 pass, 0 fail, 20 skipped**. `next build` not re-run (the change is one test file).
- **Not done:** S3 (briefs for SEO-13/14/15 and the SEO-28 pin note), S6 (porting the v1.0 guide outlines), S7, N-1 to N-3.

**Changes in v1.6**
- **M1 (stale patch):** regenerated at **`764e0f2`** (`origin/v3/main` after #265 and #220, fetched 2026-11-13). #265 had already landed the `OG_DESC` edit, so that hunk is gone and the §3 bullet for it is deleted. `git apply --check -p0` is clean. Full suite: **1,709 tests, 1,689 pass, 0 fail, 20 skipped**. The SEO-P0 fallback is now "apply with `--reject`, resolve only the rejected hunks, list them in the PR". `v3/main` moves as PRs merge; §8.3 says what to do when it has moved again.
- **M2 (SEO-11):** moved out of the agent-ready set into **needs Jon decision** (new **D-SEO-8**). A brief cannot be honest yet: the consent question for EU/UK visitors is unanswered, signups take two paths (email via `api/auth/signup`, OAuth via `auth/callback`), the `public.users` row is seeded by the `on_auth_user_created` trigger on `auth.users` (migration 013), not by the route, and `apps/worker/src/worker/models.py` has no user model to edit. §7.1 records those facts, the review gates (M-9, M-11 ≥ 90, Jon merges the migration) and a host-only AI pattern, so the brief can be written in one pass once Jon answers.
- **M3 (scratchpad paths, label collisions):** SEO-00 now also commits `gtm/RESEARCH.md` and creates `docs/seo/data/`; SEO-09b, SEO-24 and SEO-27 write there, and the SEO-16 brief reads `docs/seo/RESEARCH.md`. GTM gates and work items now always carry a `GTM-` prefix (GTM-G1 to GTM-G5, GTM-N2, GTM-N4, GTM-A1 and so on), defined once under **Basis**. Bare G1–G10 mean guides only.
- **Should-fix and nice-to-have one-liners:** S1 (eight decisions, counting D-SEO-8); S2 (SEO-00 PR title); S3 (the three `content-copy` rules defined); S4 (D-SEO-1 states the training-bot trade-off; Claude-Agent noted); S5 ("drop" added to the banned list; the patch's `BANNED` gains `drop` and `hover`); S7 (`VERCEL_ENV=production`); N-1 (three new assertions pin "six stems", the llms.txt "not available yet" sentence and the offer price; each surviving mutant from REVIEW-6 now fails, 6 pass / 1 fail, and the restored baseline is 7 / 0); N-2; N-3; N-4; N-5.
- **Not done (need more than a line):** S6 (briefs for SEO-10, 13, 14, 15, 28), N-6, N-7.

**Changes in v1.5**
- **SF-1:** the §4.4 minute rule exempts quoted competitor figures and the measured runtime "about 1–3 minutes", and never feeds a competitor figure from `MAX_TRACK_MIN`.
- **SF-2:** `jsonld.test.mjs` "entity facts" now pins `'Files deleted after 24 hours'` in `featureList` and "Chrome on a desktop" in `browserRequirements`. The 48-hour mutant in `jsonld.ts` fails it (8 pass, 1 fail); restored, it passes (checked with `cmp`).
- **SF-3:** the `/practice/guitar` meta reads `${MAX_TRACK_MIN}`, and a note under §4.2 says metas with a minute figure use it. A new `seo-pages.test.mjs` test applies the landing literal-minute regex to `pages.ts`. A literal-5 mutant fails it; restored, it passes.
- **Nits:** line 37's code reference is now `65c2319`; the SEO-00 note says "this plan"; the patch's blank line at EOF in `llms.ts` is removed.
- **Patch:** regenerated at `65c2319` (the current `origin/v3/main`); `git apply --check -p0` is clean, with no whitespace warning. Full suite: **1,683 tests, 1,663 pass, 0 fail, 20 skipped**.

**Changes in v1.4**
- **R4-M1:** a new test in `test/llms-txt.test.mjs`, "ENTITY_LIMITS states the five brand limits, with the player cap as its only minute figure". It imports `MAX_TRACK_SEC` from `src/lib/play/types.ts`, then asserts:
  - the text contains `up to ${floor(MAX_TRACK_SEC/60)} minutes` (superseded in v1.7.1 by #270: now `uses the first ${MAX_TRACK_MIN} minutes of any song`);
  - that figure is the only minute figure;
  - the text contains "Chrome on the desktop", "after 24 hours", "account to open the player" and "rights to the audio".
- **Mutant runs:** each mutant made the new test fail by assertion (`AssertionError`, 1 pass and 1 fail in the file); `site.ts` was restored after each (checked with `cmp`), and the file then gave 2 pass, 0 fail:
  - M6: "6 minutes" hard-coded in `ENTITY_LIMITS`;
  - M7a: "24 hours" changed to "48 hours";
  - M7b: "It runs in Chrome on the desktop" dropped.
- **Patch:** regenerated at `65c2319` (the current `origin/v3/main`); `git apply --check -p0` is clean. Full suite: **1,682 tests, 1,662 pass, 0 fail, 20 skipped**.
- **Should-fix 1:** the §4.4 content test checks minute figures in module source, not in rendered text.
- **Should-fix 2:** the G1 brief now uses `ENTITY_LIMITS` for the limits sentence.
- **Should-fix 3:** stale version strings in §3.0 step 8, SEO-00 and §8.3 are corrected.

**Changes in v1.3**
- **R3-M1:** `test/jsonld.test.mjs` imports `MAX_TRACK_SEC` from `src/lib/play/types.ts`, where the player cap is defined (`MAX_TRACK_SEC = 300`, line 134). A new test asserts `MAX_TRACK_MIN === Math.floor(MAX_TRACK_SEC / 60)`, and that the `/` description contains that figure. Under the `MAX_TRACK_MIN = 6` mutant in `site.ts`, this test fails (4 pass, 1 fail); restored, it passes.
- **Patch:** regenerated at `65c2319` (the current `origin/v3/main`). `git apply --check -p0` is clean. Full suite: **1,681 tests, 1,661 pass, 0 fail, 20 skipped**.
- **N-F2:** SEO-00's acceptance now says four files.
- **N-F3:** the day-90 indexing KPI now matches the phases.

**v1.2** applied the three MUST-FIX items from `SEO/REVIEW-2.md` (v1.1 scored 88).

**Changes in v1.2**
- **N-M1:** the Product Hunt and modmail templates now carry all five limits (§6.3).
- **N-M2:** guides must carry the limits block (§4.0 rule 2, §8.2). The G10, G3 and G5 wording is fixed in §4.3.
- **N-M3:** in the patch, `pages.ts` builds the `/` description from `MAX_TRACK_MIN`, and the home page reads its meta description from that registry entry. A new test in `jsonld.test.mjs` ties the two together. The patch was regenerated against `65c2319`. It applies cleanly and passes the full suite (**1,680 tests: 1,660 pass, 0 fail, 20 skipped**) and `next build`.

**What v1.1 did** (below, unchanged): it replaced v1.0, which scored 71 in `SEO/REVIEW-1.md`.

**What this plan answers.** Jon's brief, 10:31 PT, as amended by his 10:35 ruling: **the primary benchmark is Moises, Chordify and Yousician.** Songsterr, Ultimate Guitar, LALAL.AI, Fadr, Capo and Transcribe! are secondary. v1.1 also adds two mobile apps, Yamaha Extrack and Audio Jam.

**Basis**
- **Code:** `origin/v3/main` at `6846062`, fetched 2026-11-13 (v1.6 used `764e0f2`; v1.5 used `65c2319`; #265 then changed the landing's `OG_DESC`, and #220 touched job routes only). `v3/main` keeps moving as PRs merge, so treat this SHA as the patch's base, not as "current". Paths are relative to `apps/web/src/` unless they start with `apps/`.
- **Phase 0 is built and tested.** The Phase 0 code in §3 is not a sketch. It is a patch, `overnight/SEO/phase0-prototype.patch` (21 files), that:
  - applies cleanly to `6846062` (`git apply --check -p0`; regenerated for v1.7);
  - passes the **full** web suite at `6846062` (1,711 tests: 1,691 pass, 0 fail, 20 skipped; at `764e0f2` it was 1,709 / 1,689 / 0);
  - passed `next build` at `65c2319` (v1.5) and at `61e11e4` (REVIEW-6). v1.6's code change is test-only plus the dropped `OG_DESC` hunk, so the build was not re-run.
  The method is in §3.0.
- **Live site:** read by GET on 2026-11-13. Also `overnight/QA/LIVE-QA-2026-11-13.md`.
- **Web sources:** read 2026-11-13 and listed in §11 as [S#]. Every competitor claim was re-fetched live on 2026-11-13 for v1.1.
- **GTM labels.** Bare **G1–G10 are guides** (§4.3). Labels from the GTM plan (`docs/seo/` copies after SEO-00; `gtm/BRIEF.md`, `gtm/MATRIX.md`) always carry a prefix:
  - **GTM-G1** chord engine (D1 on 11-18, then the acceptance gate); **GTM-G2** 10-user beta plus price block; **GTM-G3** stage-1 counsel (ToS, DMCA agent, takedowns); **GTM-G4** instrumentation (events, UTM, weekly metrics email); **GTM-G5** price decision and Stripe live.
  - **GTM-N2** no-sign-in demo on owned music; **GTM-N4** YouTube clips; **GTM-D4s** the sharing decision.
  - **GTM-A1** SEO content (25-page cap; ≥40 organic signups by month 8); **GTM-A2** community answers; **GTM-A5** email stack; **GTM-A8** teachers; **GTM-A12** worship groups; **GTM-A14** directories and profiles. (A1–A3 in the §2 niche table are this plan's own cluster IDs.)
- **Labels:** VERIFIED means read at the source. SECONDARY means a third party's report of the source. ESTIMATE means my judgement, with the method stated. No search volume is invented.

**File paths for agents.** The scratchpad root is `/tmp/claude-0/-home-claude/05ea4b66-41d3-5ccc-8f1c-de57d46b3a91/scratchpad`, written `$SP` below. Task **SEO-00** commits this plan, the patch, BRAND-TONE and the GTM research into the repo under `docs/seo/`, and creates `docs/seo/data/` for the CSVs that recurring tasks write, so no later task depends on this session's scratchpad. `content/` always means `apps/web/src/content/`.

---

## Changes in v1.1

| Review item | What changed | Where |
|---|---|---|
| M1 Moises Free facts (F1, F6) | Moises Free gives 2 stems (vocals, instrumental) **or 4 stems** (vocals, drums, bass, other); individual instruments need Premium or Pro; 5 uploads a month; files up to 5 minutes. Our edge is six against four, not six against two. "Longer tracks" became "longer tracks on paid plans". | §2 A3, §4.2, §11 [S25] |
| M2 robots summary (F2, F3) | Today only ChatGPT-User is blocked. Claude-SearchBot, Claude-User and Perplexity-User are allowed through `*`. D-SEO-1 now gates SEO-03 only. | §0, §3 SEO-03, §8.0 |
| M3 `pageMetadata()` merge (F8) | Complete `openGraph` and `twitter` objects, because Next merges metadata shallowly [S30]. Proven on the built `/privacy` page. | SEO-06 |
| M4 tests that run | Lib modules use relative `.ts` imports (verified with node and `next build`). `.tsx` modules go through the repo's `compile()` and `renderPage()` helpers. Every test in §3 was run. | §3 |
| M5 build legend, dynamic slugs | Static pages print "○ or ●, never ƒ" (● verified for `generateStaticParams`). The registry test compiles the dynamic route and calls its `generateStaticParams` (verified: it accepts a returned slug and rejects a missing one). | SEO-04, 10, 12 |
| M6 noindex facts (F4) | `/account` and `/success` were already noindex. SEO-02 now covers `login`, `history` and the `account` layout (which reaches `/account/delete` and `/account/reset-password`). `/trial` redirects to `/pricing`. | §3.0, SEO-02 |
| M7 acceptance tests | Every task from SEO-11 on has a test or a checkable result. | §8.2 |
| M8 brief paths | Absolute `$SP` paths, plus SEO-00, which commits the docs to `docs/seo/`. | header, SEO-00, §8.3 |
| M9 Person node | `founder`, `creator` and `Person` are emitted only once `/about` is published. Empty `sameAs` is omitted. Both are tested. | SEO-05 |
| M10 limits sentence | Five limits: Chrome desktop, 5 minutes, 24 hours, account to open the player, rights to the audio. Applied to the templates too. | §1.3, §6.3 |
| QA: sitemap 404 | Fixed in SEO-01. robots.txt gains the `Sitemap:` line in the same task (no wait on D-SEO-1). | SEO-01 |
| QA: `/pricing` noindex | **Decision: keep noindex until GTM-G5.** Reasons in §3.0. | §3.0, SEO-28 |
| QA: OG on home only | `/privacy` and `/terms` move to `pageMetadata()`, and every new page uses it. App routes stay noindex without OG. The home `og:description` now says "detected section" (QA P2-2). | SEO-06 |
| Should-fix items done | #1 winnability · #2 niche B without slow-down · #3 Extrack and Audio Jam · #4 sitemap line · #5 middleware · #6 unpublished pages · #7 "clean" · #8 titles · #9 all metas · #10 compare titles · #11 one `@graph` · #12 citations · #13 KPIs · #14 order · #15 G1 in full (Appendix A) · #16 demo phrase · #17 script count | throughout |

---

## 0. Executive summary

1. **Today the site cannot rank or be cited.**
   - `/sitemap.xml` and `/llms.txt` return 404.
   - There is no structured data on any page.
   - `/login`, `/history`, `/account/delete` and `/account/reset-password` can be indexed.
   - `www` redirects with a 307 (temporary).
   - Open Graph tags exist on the home page only.
   - `robots.ts` blocks **ChatGPT-User**. Claude-SearchBot, Claude-User and Perplexity-User are allowed only through the `*` rule, with no `/api/` or `/jobs/` disallow.
   - A WebSearch for "stem-loops" with "play along" finds nothing of ours [S23].
   - The Phase 0 patch fixes all of this except the robots policy (D-SEO-1) and the `www` redirect, which is a Vercel setting.
2. **Position for search as a play-along tool, not a separator.**
   - Separator head terms belong to free utilities: "vocal remover" 60,500 US searches a month, "stem splitter" 9,900 (Semrush via `gtm/RESEARCH.md`).
   - Our words are *play along*, *chord track*, *mute your part* and *section loop*.
3. **Moises's organic traffic is mostly its own name.** Brand terms are 72.94% of its US organic traffic (Semrush, October 2026 [S15]). Its non-brand pages are feature lists [S19]. A specific page for one job can beat them on long-tail queries.
4. **The site stays small and is written by people.** At most 25 content pages (GTM-A1). Agents draft, and Jon reviews every page. This keeps us clear of Google's scaled-content-abuse definition [S4]; GTM already stopped GTM-A1v for this reason.
5. **AI search needs ordinary SEO plus open crawler access.**
   - Google needs no llms.txt or special markup [S1][S2].
   - ChatGPT needs OAI-SearchBot [S9], Perplexity needs PerplexityBot [S11], and Claude needs Claude-SearchBot [S10].
   - llms.txt is built because it costs nothing and is derived from the page registry. We expect little from it: 97% of llms.txt files got no requests in May 2026 [S12].
6. **The demo is the best asset, once it exists.** A demo on Jon's own song "Lucky Ticket" that opens without signing in (GTM-N2) is citable, linkable and has no copyright risk. **`/demo` is 404 today.** Every page and template that mentions it waits for GTM-N2 (SEO-18).
7. **Compare pages are honest by construction.**
   - Yousician gives feedback while you play.
   - Chordify shows chords over lyrics on 7,500+ songs.
   - Moises slows songs down and runs on phones.
   - We say so on each page, dated and sourced.
8. **Measurement uses free tools.** Search Console, Bing Webmaster Tools (its AI Performance report covers Copilot citations [S13]), first-touch referrer capture (if D-SEO-8 says build), and a monthly 20-prompt × 5-engine panel.
9. **Eight decisions for Jon** (§8.0). D-SEO-1 (robots policy) gates SEO-03 only; the rest of Phase 0 can ship today.
10. **Expect slow results.** GTM puts SEO's material effect at about 33 weeks. The 90-day targets in §7 cover indexing, entity correctness and first citations.

### The three niches, and what "#1" means in each

"#1" is claimed only for the **specific query sets** below, not for head terms.

The "today" columns come from a WebSearch probe on 2026-11-13 [S23]. That is a search tool, not a Google rank report. Re-check positions in Search Console at day 30.

| # | Niche | Queries where #1 is plausible | Today's top results (probe) | Why a new domain with no links can displace them | Head terms we will NOT be #1 for |
|---|---|---|---|---|---|
| **A** | **Chords over the stems.** A chord track above six faders where you mute your part, in the browser. | "chord track with stems", "chords and stems in browser", "play along with chords and my part muted", "chordify with instruments removed" | Yamaha Extrack product page; Moises made-for pages; App Store listings [S23] | Extrack is mobile-only [S28]. Audio Jam is Apple-only [S29]. Chordify lists no stem feature [S26]. Moises pages sell a feature list [S19]. A desktop-browser page about this exact workflow, with a working demo, answers the query more directly than any of them. | "best guitar app", "chords for songs" (Chordify, Ultimate Guitar) |
| **B** | **Learn it by ear, section by section.** Solo the part, loop the detected section, check the chord estimate. | "learn a song by ear with stems", "solo an instrument to learn a song", "check chords by ear" | TrueFire, Musical U, Pickup Music, wikiHow articles; Transcribe! and Capo [S23] | None of them pairs the method with a tool you can try on the page. **Caveat:** we have no slow-down yet, and slow-down is the standard by-ear tool (Transcribe!, Capo, Moises [S18], Audio Jam [S29]). G1 says so and points to those tools. Niche B is fully contestable only after tempo ships. Until then it is a long-tail niche. | "how to learn a song by ear" (TrueFire, wikiHow, Musical U hold it) |
| **C** | **Bass practice from the song you're learning.** Solo to hear the line, mute to play it, read the chords above. | "practice bass with bass muted", "hear the bass line in a song", "work out a bass line by ear" | LALAL.AI guide, SoundBoost, EaseUS; BassBuzz and TalkBass threads [S23] | The separator pages are about removing bass, not practising it. The forum threads ask for exactly this tool. A smaller community (r/bassguitar about 163k; RESEARCH.md) is reachable by one person. | "bass backing tracks" (backing-track catalogues) |

**Not our niches yet**
- "Slow down a song": not built.
- Mobile practice: desktop Chrome only.
- "Vocal remover" and "stem splitter": off-position.
- "Chords for [song]": legal risk and scaled content.

---

## 1. Positioning for search

### 1.1 What we are, and are not
- **We are** a play-along and practice tool in the browser. Separation is how it works, not what it is.
- **We are not**
  - a stem separator, vocal remover or karaoke maker;
  - a sample-pack site;
  - a lesson app that grades you;
  - a tab or chord catalogue.

### 1.2 Entity definition

| Field | Value |
|---|---|
| Name | stem-loops: lowercase and hyphenated, always |
| Type | `WebApplication`, category `MultimediaApplication` |
| Category phrase | "play-along tool" (adjective "play-along"; the noun is "play along", BRAND-TONE §4) |
| What it does | Six stems (drums, bass, guitar, keys, vocals, other), each with a fader, mute and solo; a chord track estimated from the audio; looping of a detected section |
| Second product | Bar-length loops from each stem, as 24-bit WAV downloads |
| Limits (always stated) | Chrome on the desktop; the first 5 minutes of any song (a longer song is trimmed, not refused); files deleted after 24 hours; an account to open the player (not to start a job); the rights to the audio you add. Also: chords are an estimate; no tempo or pitch change yet; no lyrics. |
| Maker | Jon Cartwright, a musician in Canada (subject to D-SEO-2) |

### 1.3 The sentences every page and AI answer should repeat

> **stem-loops is a browser play-along tool: add a song and it opens in a player with six stems on faders, a chord track and section loops.**

> **It runs in Chrome on the desktop, uses the first 5 minutes of any song and deletes files after 24 hours. You need an account to open the player, and the rights to the audio you add.**

**In code:**
- `ENTITY_ONE_LINER` and `ENTITY_LIMITS` in `lib/seo/site.ts`.
- "5" comes from `MAX_TRACK_MIN` and is never a literal.

**Where they go:**
- the first paragraph of `/about`, `/how-it-works` and every `/compare` page;
- `WebApplication.description`;
- llms.txt;
- every third-party profile bio;
- the outreach templates (§6.3).

### 1.4 Disambiguation
"stem loops" also means sample-pack loops, and "stem-loop" is an RNA hairpin structure. Both will mix with brand search and AI answers.

- Always write the hyphen, and pair the name with "play-along" in titles.
- The glossary and llms.txt carry the line: "stem-loops is not a sample pack and not the RNA stem-loop structure." It is already in the patch's `llms.ts`.
- Claim the name on every profile (§6.1).
- **No Wikipedia draft:** we don't meet notability. Revisit Wikidata after independent coverage exists.

---

## 2. Niche and keyword map

**Demand evidence.** The only verified US volumes are separator and brand terms:
- vocal remover 60,500;
- stem splitter 9,900;
- stem separator 2,400;
- moises 33,100;
- moises ai 9,900;
- moises app 2,400.

Sources: RESEARCH.md and [S15], Semrush, October 2026.

**For the play-along clusters we have no verified volumes.** This shell cannot reach Google Autocomplete (HTTP 000).

**How we rank clusters instead**
1. By competitive evidence: whether incumbents built a dedicated page, and whether forum threads ask for the tool.
2. **SEO-09b:** Jon pulls Keyword Planner ranges for the seed queries below.
3. A Search Console rerank at day 30.

| Cluster | Seed queries | Intent | Owner today (primary first) | Our angle | Target page (creating task) | Evidence |
|---|---|---|---|---|---|---|
| **A1. Chords + stems** | chords and stems app; play along with chords; chord track for a song; show chords and mute guitar | Find a tool | Moises (chord detection + separation on web [S18]); Yamaha Extrack (mobile [S28]); Audio Jam (Apple [S29]); Chordify (chords, no stems listed [S26]) | Chord track over six faders in a desktop browser; chords are an honest estimate | `/chord-track` (SEO-17) | [S18][S26][S28][S29] |
| **A2. Chordify alternative** | chordify alternative; chordify with instruments removed | Compare | AlternativeTo lists ChordU, muted.io, Capo and others; no stem tool [S21] | The alternative for people who also want their part muted | `/compare/chordify` (SEO-16); AlternativeTo (SEO-22) | [S21] |
| **A3. Moises alternative** | moises alternative; moises vs chordify | Compare | Moises brand pages; listicles | Moises Free separates into 2 stems (vocals, instrumental) or 4 stems (vocals, drums, bass, other); individual instruments need Premium or Pro; 5 uploads a month, files up to 5 minutes (Moises Help, read 2026-11-13 [S25]). Ours, free: six stems, including guitar and keys; also 5 tracks a month, the same cap (`034:118`). | `/compare/moises` (SEO-16) | [S25] |
| **B1. Learn by ear** | learn a song by ear with stems; solo instrument to learn song | Learn | TrueFire, Musical U, Pickup Music, wikiHow [S23] | Method plus tool; states plainly that slow-down isn't available yet | G1 (SEO-21; full copy in Appendix A) | [S23] |
| **B2. Section looping** | loop part of a song to practice; repeat the chorus | Find a tool or learn | Moises Song Parts; Transcribe!; Audio Jam A/B loop [S29] | A detected section repeats, with six stems and chords | `/section-loop` (SEO-20) | [S23][S29] |
| **B3. After lesson apps** | yousician alternative; learn songs not in yousician | Compare | guitarchalk, americansongwriter, AlternativeTo [S23] | Yousician teaches from "2000+" songs and listens as you play [S20]. We play the song you bring and don't grade you. | `/compare/yousician` (SEO-16); G8 (SEO-23) | [S20] |
| **C1. Bass practice** | practice bass with bass removed; bass practice from song | Find a tool | LALAL.AI, SoundBoost, EaseUS; BassBuzz and TalkBass [S23] | Solo to hear, mute to play, chords above | `/practice/bass` (SEO-19) | [S23] |
| **C2. Bass by ear** | how to learn bass lines by ear; hear the bass line in a song | Learn | Forums, lesson sites | Soloed bass stem plus section loop | G2 (SEO-21) | [S23] |
| **D1. Guitar (contested)** | remove guitar from song; mute guitar in song | Find a tool | Moises `/made-for/guitar-backing-tracks/` [S19]; SoundBoost; Extrack [S23] | Chords above the band, in the browser | `/practice/guitar` (SEO-19) | Heavy competition; supports niche A |
| **D2. Drums** | drumless tracks; practice drums to songs | Find a tool or learn | Moises made-for; Drumeo's tutorial on Moises; SoundBoost; Mutedrums [S23] | Mute the drums, loop the section | `/practice/drums` (SEO-19); G5 (SEO-23) | [S23] |
| **D3. Keys** | remove piano from song; play piano along with song | Find a tool | SoundBoost; Moises [S23] | Mute the keys, chords above | `/practice/keys` (SEO-19) | [S23] |
| **E1. Definitions** | what is stem separation; what is bleed in stems; what is a chord track | Know | Vendor wikis, LALAL.AI | Short, neutral, sourced definitions | `/glossary` (SEO-15); G4 (SEO-21) | [S23] |
| **E2. Chord accuracy** | how accurate is chord detection; chordify wrong chords | Know or compare | Reviews and Reddit complaints (RESEARCH.md) | Plain about estimates; later, a measured accuracy page (§9) | G3 (SEO-21) | RESEARCH.md |
| **E3. Rights** | is it legal to separate stems | Know | Vendor help pages | Plain facts, not advice; counsel-reviewed | G9 (SEO-23b) | RESEARCH.md §5 |
| **F. Own recordings** | learn my part from a rehearsal recording | Learn | Forums | Legally clean; nobody targets it | G10 (SEO-23) | ESTIMATE: low competition, low volume |
| **Excluded** | vocal remover; stem splitter; acapella maker; youtube to stems; slow down song; chords for "[song]" | — | vocalremover.org, Fadr, LALAL.AI, Chordify, UG | Off-position, legal risk, or not built | none | GTM: no "paste a YouTube link" in SEO |

---

## 3. Technical SEO implementation

### 3.0 State today, and how the Phase 0 code was proven

**Current state** (`aa03af0` and live, 2026-11-13)

| Item | State | Evidence |
|---|---|---|
| `metadataBase`, title template | Present | `app/layout.tsx:6-8` |
| Home meta description | 174 characters (target ≤155) | live `<head>` |
| JSON-LD | None | live home: 0 `application/ld+json` |
| Open Graph and Twitter | **Home only.** `/pricing`, `/terms`, `/privacy` and `/login` have none (QA P2-5). In the built HTML the home canonical and `og:url` are both `https://stem-loops.com` (no slash; REVIEW-6, checked in `next build` output); the sitemap and JSON-LD use `https://stem-loops.com/`. It is the same URL; leave it. | live; QA |
| robots.txt | Allows `*`. OAI-SearchBot and PerplexityBot are allowed but kept off `/api/` and `/jobs/`. Ten agents are blocked site-wide: GPTBot, **ChatGPT-User**, ClaudeBot, anthropic-ai, CCBot, Google-Extended, Bytespider, Amazonbot, Applebot-Extended, meta-externalagent. Claude-SearchBot, Claude-User and Perplexity-User fall under `*`. No `Sitemap:` line. | `app/robots.ts`; live |
| sitemap.xml, llms.txt | 404 | live; QA |
| `www` to apex | 307 | curl |
| noindex | Already noindex: `/pricing`, `/jobs/[id]`, `/account` (`account/page.tsx:9`), `/success` (`success/page.tsx:5`) and the 404. **Indexable:** `/login`, `/history`, `/account/delete`, `/account/reset-password`. `/trial` is a 307 to `/pricing`. | repo; live; QA |
| Middleware | Runs on every path except `_next/static`, `_next/image`, `robots.txt`, `sitemap.xml` and images. Static pages still cost one middleware invocation per hit. | `middleware.ts:240-243` |
| Analytics | None | `git grep` |
| Test harness | `.mjs` tests run under `node --experimental-strip-types`. Node can't resolve `@/` or load `.tsx`. `.ts` modules with relative `.ts` imports load directly (as in `test/robots.test.mjs` and `src/chord/__tests__`). `.tsx` modules load through `compile()` (`test/helpers/render-chrome.mjs`) or `renderPage()` (`test/helpers/render-landing-page.mjs`), which transpile and rewrite `@/`. | `apps/web/package.json` `test`; helpers |
| Pinned tests | `signed-in-nav.test.mjs:331` asserts 3 marketing pages. `landing-copy.test.mjs` bans prices, plan names, "credits", social proof and literal minute figures on the landing. | repo |

**`/pricing`: keep noindex for now (QA asked).** Reasons:
1. Prices are about to change. GTM's recommended option D (Pro C$6.99, Studio C$14.99) waits on the beta price test (GTM-G2, GTM-G5). An indexed C$4.99 page would seed search snippets and AI answers with prices that will be wrong.
2. The page has an open truth issue. QA P1: paid plans appear to lose link import, and the landing never says so.
3. The landing's "no payment at launch" pin.

**Index it in SEO-28** when all three are true:
- Stripe is live with the GTM-G5 prices;
- QA P1 is resolved;
- the page uses `pageMetadata()` (canonical, OG).

**How Phase 0 was proven**
1. `git archive` of `origin/v3/main` to `$SP/seo-verify`.
2. `pnpm install --frozen-lockfile --ignore-scripts`.
3. Applied the edits.
4. Ran `pnpm test`: **1,668 tests, 1,648 pass, 0 fail**.
5. Ran `next build`. It succeeded. The legend showed `○ /sitemap.xml`, `○ /llms.txt`, `○ /privacy`, `○ /terms` and `○ /`. A probe route with `generateStaticParams` printed **●**, then was removed.
6. Read the built `.next/server/app/privacy.html`: canonical, nine `og:*` tags and four `twitter:*` tags present.
7. Diffed against a fresh archive to produce `$SP/overnight/SEO/phase0-prototype.patch`.
8. `git apply --check -p0` was clean against `aa03af0`. Later versions regenerated the patch against `65c2319`:
   - v1.2 applied it to a fresh archive, installed dependencies, and re-ran `pnpm test` and `next build` (succeeded; the built home description is the registry entry).
   - v1.5's patch (at `65c2319`) stopped applying when #265 landed the same `OG_DESC` edit (REVIEW-6 M1).
   - v1.7 is the current patch: v1.6's patch applied cleanly at `6846062`, one truth-rule test was added, and the diff was retaken; `git apply --check -p0` is clean on a second, clean worktree.
   - v1.6 regenerated it at `764e0f2` in a throwaway worktree: the v1.5 patch applied with `--reject`, the one rejected hunk resolved by hand without its `OG_DESC` line, three test pins added, and `git diff --no-prefix` taken. `git apply --check -p0` is clean on a second, clean worktree at `764e0f2`. `pnpm test` gives 1,709 tests: 1,689 pass, 0 fail, 20 skipped.

### SEO-00: commit the docs (do first)
**Owner:** agent. **Effort:** 10 min.
- [ ] Copy into the repo:
  - `$SP/overnight/SEO/SEO-AIO-PLAN.md` → `docs/seo/SEO-AIO-PLAN.md`
  - `$SP/overnight/COPY/BRAND-TONE.md` → `docs/seo/BRAND-TONE.md`
  - `$SP/overnight/SEO/phase0-prototype.patch` → `docs/seo/phase0-prototype.patch`
  - `$SP/overnight/SEO/SEO-AIO-PLAN-v1.0.md` → `docs/seo/SEO-AIO-PLAN-v1.0.md` (this plan refers to its guide outlines and panel prompts)
  - `$SP/gtm/RESEARCH.md` → `docs/seo/RESEARCH.md` (SEO-16 and §2 cite it)
  - an empty `docs/seo/data/.gitkeep` (SEO-09b, SEO-24 and SEO-27 write their CSVs here)
- [ ] Open one PR, "docs(seo): plan v1.7.1, brand tone and research" (landed with Phase 0 in one PR, `seo/phase-0`).

**Acceptance.** The five files and `docs/seo/data/` exist on the branch. Later briefs cite `docs/seo/…`; nothing after SEO-00 reads or writes `$SP`.

### SEO-04, 01, 02, 06, 05, 07: Phase 0, as one patch

All six are in `phase0-prototype.patch`. The checklists below describe what the patch contains, so a reviewer can check it. **An agent applies the patch rather than retyping it** (brief SEO-P0, §8.3).

#### SEO-04: site constants and page registry
**Owner:** agent. **Depends on:** none.

**Files**
- `lib/seo/site.ts`:
  - `SITE_URL`, `SITE_NAME`, `OG_IMAGE`;
  - `MAX_TRACK_MIN`, derived from `../play/types.ts`;
  - `ENTITY_ONE_LINER`, and `ENTITY_LIMITS` (five limits, §1.3);
  - `SAME_AS: string[] = []`.
- `lib/seo/pages.ts`:
  - `PublicPage` type: `path`, `title`, `absoluteTitle?`, `description` (≤155), `section`, `lastModified`, `llms`, `published`;
  - `PUBLIC_PAGES`, seeded with `/`, `/privacy` and `/terms`. The `/` description is a template literal built from `MAX_TRACK_MIN` (`import { MAX_TRACK_MIN } from './site.ts'`); there is no literal minute figure;
  - `publishedPages()` and `pageFor()`.
- **Imports are relative with the `.ts` extension** (`'../play/types.ts'`). This lets node's type stripping load them from tests. `next build` accepts them, because `allowImportingTsExtensions` is on (verified).

**Test:** `test/seo-pages.test.mjs`
- paths are unique and slug-shaped;
- titles are unique;
- descriptions are ≤155 characters;
- no banned words: `!`, click, extract, accurate, perfect, studio-quality, instantly, unlimited, YouTube;
- **every published path resolves to a page.** A static `page.tsx` matches its URL, with route groups dropped. Otherwise the test finds the dynamic segment under the parent path, compiles it with `compile()`, calls its `generateStaticParams()`, and requires the slug to be in the result. Verified: it accepts a returned slug and fails a missing one;
- `pageMetadata(p)` returns one OG image, `siteName`, `summary_large_image` and a canonical equal to `p.path`, and unpublished pages get `robots.index === false`.

#### SEO-01: sitemap.xml, plus the `Sitemap:` line
**Owner:** agent. **Depends on:** SEO-04.
- `app/sitemap.ts` maps `publishedPages()` to `{ url, lastModified }`, with no `changeFrequency` or `priority` [S22].
- `app/robots.ts` adds `sitemap: 'https://stem-loops.com/sitemap.xml'` to the returned object. **Nothing else in robots.ts changes here**; the existing `robots.test.mjs` stays green.
- **Test:** `test/sitemap.test.mjs`:
  - URLs are absolute and unique;
  - the count equals the published registry count;
  - none starts with `/login`, `/history`, `/account`, `/trial`, `/success`, `/pricing`, `/jobs/` or `/api/`;
  - `robots().sitemap` equals the sitemap URL.

**Acceptance (live)**
- `curl -s https://stem-loops.com/sitemap.xml` returns 200 with three `<loc>` entries.
- `curl -s https://stem-loops.com/robots.txt | grep Sitemap` prints the line.

#### SEO-02: noindex app routes
**Owner:** agent.
- Add `robots: { index: false, follow: false }` to `metadata` in:
  - `app/login/layout.tsx` (a new `metadata` export; the page's title still merges in);
  - `app/history/layout.tsx` (merged with `title: 'Job history'`);
  - `app/account/layout.tsx` (a new export, which covers `/account/delete` and `/account/reset-password`).
- Not `trial` (a redirect) or `success` (already noindex).
- Not robots `Disallow`: Google must be able to see the noindex.
- **Test:** `test/noindex-app-routes.test.mjs`.
  - The three layouts are **executed** through `compile()` with `@/components/chrome/SignedInChrome` stubbed (it is on the helper's allowlist), and the test asserts `metadata.robots.index === false`.
  - The four pages that were already noindex (`account/page.tsx`, `success/page.tsx`, `pricing/page.tsx`, `jobs/[id]/page.tsx`) import server-only modules (`next/headers`, the database), so `compile()` cannot load them (verified). A source check holds them instead.

**Acceptance (live).**
- `curl -s https://stem-loops.com/login | grep -o '<meta name="robots"[^>]*>'` prints a tag containing `noindex`.
- The same holds for `/history`.
- Check `/account/delete` and `/account/reset-password` while signed in (view-source), or with the GSC URL Inspection tool.

#### SEO-06: metadata
**Owner:** agent. **Depends on:** SEO-04.

`lib/seo/meta.ts`, `pageMetadata(p)`:
```ts
title: p.absoluteTitle ? { absolute: p.title } : p.title,
description: p.description,
alternates: { canonical: p.path },
openGraph: { siteName: SITE_NAME, locale: 'en_CA', images: [{ url: OG_IMAGE, width: 1200, height: 630 }],
  title: p.title, description: p.description, url: p.path, type: p.section === 'guide' ? 'article' : 'website' },
twitter: { card: 'summary_large_image', title: p.title, description: p.description, images: [OG_IMAGE] },
...(p.published ? {} : { robots: { index: false, follow: false } }),
```
- The objects are complete because Next merges metadata **shallowly**. A page that sets `openGraph` replaces every parent `openGraph` field [S30].
- No root-layout OG defaults are added. App routes are noindex and don't need cards.

**Page changes**
- `/privacy` and `/terms`: `export const metadata = pageMetadata(pageFor('/privacy')!)` (and `'/terms'`). Verified in the built HTML: canonical, `og:title`, `og:image`, `og:site_name`, `og:locale`, `twitter:card`.
- **Home** (`app/(landing)/page.tsx`):
  - The description becomes `pageFor('/')!.description` (with `pageFor` imported from `@/lib/seo/pages`), so there is one source: the registry entry, `` `Six stems with faders, mute and solo, a chord track and section loops. Play along in Chrome on the desktop. Uses the first ${MAX_TRACK_MIN} minutes of any song.` `` (145 characters).
  - `openGraph.locale: 'en_CA'` is added.
  - The home keeps its own OG block (title "Paste a song. Play along." and its alt text).
- **Canonical policy:** self-referencing on every public page. Query strings are never canonical. No trailing slash except the root.

**Tests:** `seo-pages.test.mjs` (above). `landing-copy`, `legal-privacy-copy` and `legal-terms-copy` stay green (verified).

#### SEO-05: JSON-LD
**Owner:** agent. **Depends on:** SEO-04. **The Person node waits for D-SEO-2 and `/about`.**

**What it can and can't do**
- Google doesn't require structured data for AI features [S1].
- `SoftwareApplication` and `WebApplication` rich results **require** `aggregateRating` or `review` [S5]. We have neither and will never invent them. So: no rich result. The markup is for entity clarity only.
- **FAQPage:** Google stopped showing FAQ rich results on 2026-05-07, and the markup is harmless [S6]. Whether other engines use it is **unknown**; no source here says so.
- **HowTo:** rich results were cut back in 2023 [S7]. Don't use HowTo.

**Files**
- `components/seo/JsonLd.tsx` renders `<script type="application/ld+json">` with every `<` escaped as `\u003c`. The CSP doesn't apply, because the script is not executed.
- `lib/seo/jsonld.ts`, `homeGraph()`:
  - one `@graph` holding `Organization`, `WebSite` and `WebApplication` (description `ENTITY_ONE_LINER`; `featureList` including `` `Uses the first ${MAX_TRACK_MIN} minutes of any song` ``; `offers` price `"0"` CAD, category `free`);
  - **`Person`, `founder` and `creator` only when `pageFor('/about')?.published`**;
  - **`sameAs` only when non-empty**.
- Rendered once in the home page. **If FAQ markup is added later, it goes inside the same `@graph`**, so the page keeps exactly one block. It mirrors visible questions only, and **never** "Does it work with YouTube links?".

Output on the built home page today, verified:
```json
{"@context":"https://schema.org","@graph":[
 {"@type":"Organization","@id":"https://stem-loops.com/#org","name":"stem-loops","url":"https://stem-loops.com/",
  "logo":{"@type":"ImageObject","url":"https://stem-loops.com/apple-touch-icon.png"}},
 {"@type":"WebSite","@id":"https://stem-loops.com/#website","url":"https://stem-loops.com/","name":"stem-loops","inLanguage":"en","publisher":{"@id":"https://stem-loops.com/#org"}},
 {"@type":"WebApplication","@id":"https://stem-loops.com/#app","name":"stem-loops","url":"https://stem-loops.com/",
  "description":"stem-loops is a browser play-along tool: add a song and it opens in a player with six stems on faders, a chord track and section loops.",
  "applicationCategory":"MultimediaApplication","applicationSubCategory":"Music practice",
  "operatingSystem":"Windows, macOS, ChromeOS, Linux (desktop)","browserRequirements":"Requires Google Chrome on a desktop or laptop computer.",
  "inLanguage":"en","isAccessibleForFree":true,
  "featureList":["Six stems: drums, bass, guitar, keys, vocals and other","A fader, mute and solo on every stem","A chord track estimated from the audio","Looping of a detected section","Bar-length loops from each stem as 24-bit WAV files","Uses the first 5 minutes of any song","Files deleted after 24 hours"],
  "offers":{"@type":"Offer","price":"0","priceCurrency":"CAD","category":"free"},
  "image":"https://stem-loops.com/og-image-v4.png","publisher":{"@id":"https://stem-loops.com/#org"}}]}
```

**Guides, later** (`articleGraph`, built in SEO-12): `Article` with `author` set to the Person `@id` only when `/about` is published (otherwise `author` is the Organization), plus `BreadcrumbList` and the optional FAQ, all in one `@graph`. Article JSON as in v1.0 §3, with that author rule.

**Compare pages:** `WebPage` and `BreadcrumbList` only. Never `Review`, `Rating` or `Product` for competitors.

**Test:** `test/jsonld.test.mjs` renders the home page with `renderPage('app/(landing)/page.tsx')` and checks:
- exactly one `application/ld+json`, which parses;
- `WebApplication.description === ENTITY_ONE_LINER`;
- the `featureList` holds `Uses the first ${MAX_TRACK_MIN} minutes of any song`;
- no `aggregateRating`, `review` or `ratingValue`;
- no "youtube";
- no `"sameAs":[]`;
- no `Person` or `about#jon` while `/about` is unpublished;
- the home page module's `metadata.description` (loaded with `compile()`) equals `pageFor('/').description`, which contains `${MAX_TRACK_MIN} minutes`.

**Acceptance.** The Schema Markup Validator shows no errors for `/`. "No rich result" in the Rich Results Test is expected.

#### SEO-07: llms.txt
**Owner:** agent. **Depends on:** SEO-04.
- `lib/seo/llms.ts` exports `llmsText()`:
  - `# stem-loops`;
  - `> ENTITY_ONE_LINER`;
  - `ENTITY_LIMITS`, followed by the stems, the chord estimate, "not yet" for tempo and pitch, no lyrics, and the WAV loops;
  - the disambiguation line;
  - `## Pages`, one line per published page with `llms: true`.
- `app/llms.txt/route.ts` exports only `dynamic = 'force-static'` and `GET`. A route file may export only route fields, which is why the builder lives in `lib/`.
- `middleware.ts` adds `llms\\.txt` to the matcher exclusion, beside `robots\\.txt` and `sitemap\\.xml`. `csp-headers.test.mjs` stays green (verified).
- **Test:** `test/llms-txt.test.mjs` calls `GET()` and checks:
  - the content type is `text/plain`;
  - the body starts with `# stem-loops`;
  - it contains `ENTITY_ONE_LINER` and `ENTITY_LIMITS`;
  - the count of `- [` lines equals the count of published `llms` pages.
- **Expectations:** Google ignores llms.txt [S1]. Ahrefs: 97% of files got no requests in May 2026; when they were read, GPTBot and Claude Code were the main AI readers [S12].

**Acceptance (live).** `curl -sI https://stem-loops.com/llms.txt` shows 200 and `content-type: text/plain`.

### SEO-03: robots.txt for AI search and user fetchers (after D-SEO-1)
**Owner:** Jon decides, then an agent implements. **Effort:** 30 min.

**What changes for access**
- Only one thing: **ChatGPT-User is unblocked.**
- Claude-SearchBot, Claude-User and Perplexity-User are already allowed through `*`. Naming them adds `/api/` and `/jobs/` disallows, matching SL15's treatment of the other search bots.

**What each bot is**
- Claude-SearchBot indexes for Claude's search. Claude-User fetches when a person asks Claude. ClaudeBot collects training data. (Anthropic [S10].)
- OpenAI says robots.txt "may not apply" to ChatGPT-User [S9].
- Perplexity says Perplexity-User "generally ignores robots.txt" [S11].
- Google-Extended does not control AI Overviews or AI Mode [S8][S2], so keeping it blocked costs nothing in Google Search.

**Change**
```ts
export const SEARCH_BOT_USER_AGENTS = ['OAI-SearchBot', 'PerplexityBot', 'Claude-SearchBot'];
export const USER_FETCH_AGENTS = ['ChatGPT-User', 'Claude-User', 'Perplexity-User'];
export const BLOCKED_AI_USER_AGENTS = ['GPTBot', 'ClaudeBot', 'anthropic-ai', 'CCBot', 'Google-Extended',
  'Bytespider', 'Amazonbot', 'Applebot-Extended', 'meta-externalagent'];
// rules: '*' unchanged; SEARCH and USER_FETCH each { allow: '/', disallow: ['/api/', '/jobs/'] }; BLOCKED { disallow: '/' }
```
- Update the header comment with D-SEO-1's date.

**Test (`test/robots.test.mjs`)**
- Add `Claude-SearchBot` to `SEARCH`.
- Add a `USER_FETCH` loop with the same assertions as `SEARCH`.
- Remove `ChatGPT-User` from `BLOCKED`.
- Keep the wildcard test as it is.

**Acceptance (live).** robots.txt lists `Sitemap:`, three search bots and three user fetchers (each with two disallows), and nine blocked agents.

**Cost guard**
- Every public content page must build as **○ or ●, never ƒ**.
- Each crawler hit on a static page still runs the middleware once (Supabase session refresh plus CSP).
- Jon keeps the Vercel spend alert on. This is the KIDS FUN lesson in the `robots.ts` header.

### SEO-08: permanent www redirect
**Owner:** Jon. **Effort:** 5 min.
- Vercel → Domains → `www.stem-loops.com` → redirect to `stem-loops.com` with **308**.

**Acceptance.** `curl -sI https://www.stem-loops.com/ | head -1` shows `308`.

### SEO-09: Search Console, Bing Webmaster Tools, IndexNow
**Owner:** Jon, with agent prep. **Effort:** 30 min, plus 20 min for 09b.
- [ ] **Google Search Console:** Domain property (DNS TXT); submit `/sitemap.xml`; inspect `/`.
- [ ] **Bing Webmaster Tools:** import from GSC; submit the sitemap; turn on the AI Performance report [S13].
- [ ] **IndexNow (optional, agent):** key file in `public/`; `scripts/indexnow.mjs` posts changed registry URLs. Bing uses IndexNow and Google doesn't. Any ChatGPT benefit is unconfirmed [S14].
- [ ] **SEO-09b:** Keyword Planner ranges for the §2 seed queries (US, CA, UK, AU) → `docs/seo/data/keywords-YYYY-MM-DD.csv` (committed in a docs PR).

**Acceptance**
- Both consoles show the property verified and the sitemap "Success".
- The CSV exists, with one row per seed query.

### SEO-10: performance budgets
**Owner:** agent. **Effort:** 1 h. **Depends on:** SEO-12.

Google's "good" thresholds at the 75th percentile: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 [S24]. CrUX field data won't exist for months at our traffic, so we hold lab and build budgets.

| Page type | Budget |
|---|---|
| Content pages | Build legend **○ or ●, never ƒ**. Route "Size" ≤ 5 kB and "First Load JS" ≤ 170 kB in `next build` output (the shared baseline at `aa03af0` is 162 kB; `/privacy` is 353 B and 168 kB). Lighthouse mobile: LCP ≤ 2.0 s, TBT ≤ 150 ms, CLS ≤ 0.05. |
| Home | Baseline: HTML 70 KB, **19 `<script` tags (11 external)**, First Load JS 177 kB. No regression above 10%. |

**Checklist**
- [ ] Content pages are server components. The only allowed client import is a future `DemoLink`.
- [ ] `test/content-pages-static.test.mjs` scans the content route files and fails if one:
  - exports `dynamic = 'force-dynamic'`; or
  - imports a module whose first statement is `'use client'`, outside the allowlist.
- [ ] Images: `next/image` with width and height; alt text says "Illustration:" for anything that is not a screenshot of real output.

**Acceptance**
- The PR pastes the `next build` rows for every content route.
- The PR pastes Lighthouse numbers for `/` and one guide.

### Internationalisation: no, for now
English only, no hreflang. Reasons:
- Canadian English copy rules.
- Chord naming differs by language.
- Machine translation risks the scaled-content flag [S4].
- The ICP is English-speaking (RESEARCH.md).

Revisit at day 90 if one non-English market gives ≥20% of impressions. Then hand-write one page set.

### Indexability rules

| Route | Index? | Sitemap? | robots Disallow? |
|---|---|---|---|
| `/`, `/privacy`, `/terms`, registry pages with `published: true` | yes | yes | no |
| Registry pages with `published: false` | 404 in production; noindex on preview deployments (SEO-12) | no | no |
| `/pricing` | no, until SEO-28 | no | no |
| `/login`, `/history`, `/account/*`, `/success` | no (meta) | no | no |
| `/trial` | redirect to `/pricing` | no | no |
| `/jobs/*`, `/api/*` | no | no | yes, for the named AI bots (existing) |

---

## 4. Content plan

### 4.0 Rules for every page (paste into each brief)
1. **Voice:** BRAND-TONE v1.3.1 (`docs/seo/BRAND-TONE.md` after SEO-00).
   - Canadian English ("practise" is the verb, "practice" the noun). Sentence case. No `!`. At most one em dash per paragraph.
   - Numbers: one to nine spelled out; digits with units and a non-breaking space.
   - Banned: accurate, perfect, clean, studio-quality, powerful, amazing, instantly, unlimited, extract, convert, click, drop, hover (brand guide §3).
   - "Estimate" goes with "chords" on first mention.
2. **Truth:** the five limits, once on every content page that describes the product (guides included), from `ENTITY_LIMITS`. "Not yet" for tempo and pitch. "No" for lyrics. No downbeat promise. Measured timings only.
3. **Platforms:** never headlined. No "YouTube" in a title, H1, H2, meta, URL or schema.
4. **Songs:** no commercial song or artist names anywhere. The example is "Lucky Ticket" by Jon Cartwright, or a labelled illustration.
5. **E-E-A-T:**
   - A byline (Jon if D-SEO-2 is yes, otherwise "stem-loops");
   - a "Last checked" date;
   - a "How this was made" line: "Drafted with an AI assistant from our own product notes; checked and edited by Jon Cartwright." [S3];
   - every competitor claim carries a source and a check date.
6. **Answer first:** the first paragraph answers the target query in two or three sentences that can be quoted alone.
7. **Internal links:**
   - `/` (the tool);
   - the niche pillar;
   - one or two related pages;
   - `/how-it-works`;
   - `/demo` **only after SEO-18 ships**. Until then, link to the home page's player illustration (`/#play`).
8. **Calls to action:** "Paste a song" (landing label). Once `/demo` exists, "Try the demo".
   - No prices, plan names or credits before GTM-G5, except competitor facts on compare pages.
   - Our free limits are stated with the lowercase adjective: "free: 5 tracks a month", "six stems free". Never "Free plan", "Pro" or "Studio" for our product (`landing-copy.test.mjs:320` bans `Free plan` on the landing).
   - The fixed phrase for the demo is **"the demo opens without signing in"**. This is not "no account needed", which the brand guide bans. It needs a BRAND-TONE §6 entry; see D-SEO-7.
9. **Length:** what the answer needs [S1]. Guides 900–1,600 words; product pages 400–800.
10. **Build:** typed TS content modules in `apps/web/src/content/`, rendered by one template (SEO-12).

### 4.1 Site map: 25 content pages, with the creating task

| # | Path | Route file (created by) | Content and registry entry (created by) | Niche | Phase |
|---|---|---|---|---|---|
| 1 | `/demo` | `app/(landing)/demo/page.tsx` (SEO-18) | SEO-18 | all | 2, **blocked on GTM-N2** |
| 2 | `/chord-track` | `app/(landing)/chord-track/page.tsx` (SEO-12) | SEO-17 | A | 1 |
| 3 | `/section-loop` | `app/(landing)/section-loop/page.tsx` (SEO-12) | SEO-20 | B | 2 |
| 4–7 | `/practice/{bass,guitar,drums,keys}` | `app/(landing)/practice/[instrument]/page.tsx` (SEO-12) | SEO-19 | C/D | 2 |
| 8 | `/how-it-works` | `app/(landing)/how-it-works/page.tsx` (SEO-12) | SEO-14 | entity | 1 |
| 9 | `/about` | `app/(landing)/about/page.tsx` (SEO-12) | SEO-13 | entity | 1 |
| 10 | `/glossary` | `app/(landing)/glossary/page.tsx` (SEO-12) | SEO-15 | E | 1 |
| 11 | `/compare` | `app/(landing)/compare/page.tsx` (SEO-12) | SEO-16 | A/B | 1 |
| 12–14 | `/compare/{moises,chordify,yousician}` | `app/(landing)/compare/[slug]/page.tsx` (SEO-12) | SEO-16 | A/B | 1 |
| 15 | `/guides` | `app/(landing)/guides/page.tsx` (SEO-12) | SEO-21 | — | 2 |
| 16–25 | `/guides/<slug>` ×10 | `app/(landing)/guides/[slug]/page.tsx` (SEO-12) | SEO-21 (G1–G4), SEO-23 (G5–G8, G10), SEO-23b (G9) | A/B/C/E/F | 2–3 |

**Backlog:** `/practice/vocals` and `/teachers` (the latter only if GTM-A8 shows traction).

**Footer (SEO-12):** a second `<nav aria-label="Learn">` in `SiteFooter`, listing **published** registry pages only. Never a pricing link; the landing allows exactly one.

### 4.2 Page specs: titles and metas for all 25

Titles marked † use `{ absolute }` so "stem-loops" isn't repeated. Every other title gets " · stem-loops". All titles are ≤60 characters and all metas ≤155 (counted). "Practise" in titles waits on D-SEO-3.

Metas with a minute figure are built from `${MAX_TRACK_MIN}` in `pages.ts`, never a literal; `seo-pages.test.mjs` enforces this.

| Path | `<title>` | H1 (≤6 words) | Meta description |
|---|---|---|---|
| `/demo` | Play along to the demo song | Play along to Lucky Ticket | Lucky Ticket by Jon Cartwright in the player: six stems on faders and a chord track. The demo opens without signing in. |
| `/chord-track` | Chord track over six stems | Chords over the stems | A chord track over six stems. Mute your part, read the chords, loop the section. The chords are an estimate: check them by ear. |
| `/section-loop` | Loop a section of a song | Loop the chorus until it sticks | Pick a detected section, such as a verse or a chorus, and it repeats until you have it. With six stems and a chord track. |
| `/practice/bass` | Practise bass with the bass muted | Mute the bass. Play it yourself. | Solo the bass to hear the line, then mute it and play it yourself, with the chord roots above. Six stems, in Chrome on the desktop. |
| `/practice/guitar` | Practise guitar with the guitar muted | Mute the guitar. Play it yourself. | Turn the guitar down and play the part yourself, with a chord track above six stems. Uses the first ${MAX_TRACK_MIN} minutes of any song, in Chrome on the desktop. |
| `/practice/drums` | Practise drums with the drums muted | Mute the drums. Keep the band. | Mute the drums and keep the rest of the band. Loop the section you are working on. Six stems, in Chrome on the desktop. |
| `/practice/keys` | Practise keys with the keys muted | Mute the keys. Play the part. | Mute the keys and play the part over the band, with the chords above. Six stems with faders, in Chrome on the desktop. |
| `/how-it-works` | How stem-loops works, and its limits † | How stem-loops works | From song to player in four stages, with measured timings, what happens to your files, and what the tool does not do yet. |
| `/about` | About stem-loops and who makes it † | Who makes stem-loops | Who builds stem-loops, why, and why every limit is stated on the page. Made by Jon Cartwright, a musician in Canada. |
| `/glossary` | Play-along and stem terms, defined | Play-along terms, defined | Short definitions of stems, bleed, chord tracks, section loops, BPM and other terms musicians meet when they practise with stems. |
| `/compare` | stem-loops and the alternatives † | stem-loops and the alternatives | How stem-loops compares with Moises, Chordify, Yousician and other practice tools: what each does, and where each fits. |
| `/compare/moises` | stem-loops and Moises compared † | stem-loops and Moises | What stem-loops and Moises each do, on which devices, with which free limits, and where Moises is the better choice. Checked November 2026. |
| `/compare/chordify` | stem-loops and Chordify compared † | stem-loops and Chordify | Chordify shows chords for songs. stem-loops shows chords over six stems you can mute. What each does, and where each fits. |
| `/compare/yousician` | stem-loops and Yousician compared † | stem-loops and Yousician | Yousician teaches from its own song library and listens as you play. stem-loops plays the song you bring. Where each fits. |
| `/guides` | Guides to practising with stems | Guides | Methods for learning songs by ear, working out bass lines, looping sections and checking chord estimates, with a demo to try. |
| G1 `/guides/learn-a-song-by-ear` | How to learn a song by ear | Learn a song by ear | A five-step method: mark the sections, solo the part, loop one section, check the chord estimate by ear, then play it with the band. |
| G2 `/guides/bass-line-by-ear` | How to work out a bass line by ear | Work out a bass line | Why bass lines are hard to hear, and a method to work one out: solo the bass, find the roots, fill in the passing notes, loop the bar. |
| G3 `/guides/chord-detection-accuracy` | Why chord detection gets chords wrong | Why chord detection slips | Automatic chords are estimates made from mixed audio. Where they slip, five ways to check a chord by ear, and what we do about it. |
| G4 `/guides/what-is-stem-separation` | What stem separation is, and bleed | What stem separation is | Stem separation splits a mixed song into parts such as drums, bass and vocals. What bleed is, why it happens, and why stems help practice. |
| G5 `/guides/drumless-practice` | How to practise with a drumless track | Practise with a drumless track | Mute the drums, keep the band, loop the section. A method for drum practice with drumless tracks, and the limits of the tool. |
| G6 `/guides/loop-a-section` | How to loop part of a song | Loop part of a song | Why looping one section beats replaying the whole song, how long a loop should be, and when to move on. With a demo to try. |
| G7 `/guides/play-along-routine` | A 20-minute play-along routine | A 20-minute play-along routine | A timed routine for practising with real songs: listen soloed, loop the hard part, then play the whole song with your part muted. |
| G8 `/guides/from-lesson-apps-to-songs` | From lesson apps to real songs | From lesson apps to songs | What lesson apps such as Yousician do well, where a fixed library stops, and how to learn a song that is not in the app. |
| G9 `/guides/stems-and-copyright` | Splitting songs and copyright | Splitting songs and copyright | Splitting a song does not change who owns it. What that means for private practice, sharing and releasing. Not legal advice. |
| G10 `/guides/learn-from-rehearsal-recording` | Learn your part from a rehearsal | Learn from a rehearsal recording | Record the rehearsal, add it, and each member mutes their own part. Your band's recording keeps the rights question simple. |

"with a demo to try" in `/guides`, G6 and Appendix A becomes "with an example to look at" until SEO-18 ships.

#### Outlines for product pages
Unchanged from v1.0 except as noted.

**`/chord-track`**
1. Answer first.
2. What the chord track shows.
3. How good are the chords? (the landing FAQ wording; link G3).
4. Mute your part, keep the chords (links to the practice pages).
5. Loop the section (`/section-loop`).
6. Where it runs, and the limits (`ENTITY_LIMITS`).
7. Compared with chords-only tools (`/compare/chordify`).
8. FAQ ×4:
   - "Can I edit a wrong chord?" Answer from the code: `api/chord-edits` exists; confirm what a user can do and cite `file:line`.
   - "Does it show lyrics?" No.
   - "Can I change the key?" Not yet.
   - "Which instruments does it work for?"

**`/section-loop`**
1. Answer first.
2. How sections are found (detected from the audio).
3. Looping with your part muted.
4. What it does not do:
   - **no slow-down yet** (Transcribe!, Capo and Moises do this today);
   - no free selection unless the code shows it;
   - no downbeat guarantee.
5. A routine (G7).
6. FAQ ×3.

**`/practice/bass`**
1. Answer first.
2. Hear the line first (solo; kick-drum bleed).
3. Then play it (mute).
4. Use the chords for roots (and their limits: inversions, passing notes).
5. Loop the hard bar.
6. Limits.
7. FAQ ×4:
   - **"How much bleed is in the bass stem?"** Some, more in dense mixes.
   - "Can I slow it down?" Not yet.
   - "Can I download the bass stem?" State the truth per plan from the code at publish time.
   - "Does it work on a phone?" No.

**`/practice/{guitar,drums,keys}`**
- Same template, each with a unique answer paragraph, FAQ and one instrument limit.
- Guitar: lead and rhythm are not split; Moises Pro does this [S19].
- Keys: piano and synth share one stem.
- No two pages share more than one paragraph.

**`/how-it-works`**
1. Entity and limits sentences.
2. From song to player (Demucs htdemucs_6s on Replicate, as the landing says).
3. How long it takes (3:34 example).
4. What happens to your files (`/privacy`).
5. What it does not do yet (the landing rows).
6. Your rights to the audio.
7. Changes: a dated changelog.

**`/about`:** Jon in first person; only facts Jon supplies (D-SEO-2); `AboutPage` plus `Person` with `sameAs` set to Jon's chosen profiles.

**`/glossary`**
- 18–25 entries with anchors `id="term-<slug>"`, as listed in v1.0 §4.2, plus the disambiguation entry.
- Schema: `DefinedTermSet`.

#### Compare pages: template and live-verified facts

**Template**
1. Title (†, table above) and H1 "stem-loops and [X]". The word "honest" appears nowhere; the page shows it.
2. Answer first: "Use [X] if … Use stem-loops if … Many musicians use both."
3. "Checked on [date]. We make stem-loops. Corrections: [email]; we update within a week."
4. A fact table, each competitor cell with a source link.
5. Where [X] is the better choice (≥3 points).
6. Where stem-loops is the better choice (≤3, each checkable on the landing or `/demo`).
7. Using both.
8. FAQ ×3.

**Starting facts, all re-fetched 2026-11-13.** Re-verify on publish day. Prices are left out (D-SEO-4). Every competitor limit on the page sits beside ours from the stem-loops column; a page that quotes a rival's cap and hides our equal one is not honest.

| | stem-loops (from code at `6846062`) | Moises | Chordify | Yousician |
|---|---|---|---|---|
| What it is | A desktop-browser play-along tool: six stems on faders, a chord track and section loops (`lib/seo/site.ts` `ENTITY_ONE_LINER`, after Phase 0) | Separation, chord detection, AI-detected sections, looping, speed and key changer on web/desktop and mobile [S18] | Chords for a "36,000,000 song catalog"; chords over lyrics "for 7,500+ songs"; slow-down, transpose, loop and capo listed as Premium; iPhone and iPad app, plus web [S26]; lyrics (via LyricFind) and live chord detection added in 2023 [S27] | Lessons and songs for guitar, bass, ukulele, piano and singing; "provides real-time feedback by listening to you play" [S20] |
| What you play along to | Songs you add (`app/api/uploads/`) | Songs you upload | Songs in its catalogue. Own-file upload is reported by a user review only; don't state it. | "2000+" songs and "9000+" lessons from its library; no own-song upload on its About page [S20] |
| Stems | Six: drums, bass, guitar, keys, vocals, other (`apps/web/src/lib/play/types.ts:25-32`) | Free: "2 stems: Vocals and Instrumental" or "4 stems: Vocals, Drums, Bass and Other"; individual instruments need Premium or Pro [S25] | None listed [S26] | Not a stem tool |
| Free limits | **5 tracks a calendar month** (`apps/worker/migrations/034_v3_pricing_model_truth.sql:118`, enforced by `checkMonthlyQuota()`, `lib/billing/rate-limit.ts:122`); the first 5 minutes of any song, longer songs trimmed (`lib/play/types.ts`, `MAX_TRACK_SEC = 300`; #270); Chrome on the desktop; files deleted after 24 hours (`ENTITY_LIMITS`); full-length stem download is not included free (`037_v3_studio_stem_export.sql:57-59`) | "limited to 5 uploads per month"; files up to 5 minutes [S25] | Some features Premium-only [S26] | Don't state without a fresh source |
| Where it is better than us | — | Slow-down and key change; phone and desktop apps; lead and rhythm guitar split (Pro) [S19]; longer tracks on paid plans; choose individual instruments (paid) | Lyrics with chords on 7,500+ songs; a very large catalogue; mobile apps; slow-down, transpose and capo (Premium) | Feedback on your playing; structured lessons; mobile; five instruments |
| Where we are better (only if true on publish day) | — | Six stems free, including guitar and keys (Moises Free stops at four). The monthly cap is the same: 5 a month each; say so. | Mute or solo any of six stems under the chords | Any song you bring, in its own recording |

**`/compare` hub, secondary set**
- **Yamaha Extrack:** iOS and Android; separates parts, shows chords in real time, changes tempo and key, repeats sections; basic features free [S28].
- **Audio Jam:** iPhone, iPad and Mac listing; separates vocals, drums and guitar; chord detection; A/B loop; slow to 50%; Pro up to 100 splits a month and songs up to 20 minutes [S29].
- Songsterr, Ultimate Guitar, LALAL.AI, Fadr, Capo and Transcribe!: one line each from RESEARCH.md, dated.

Extrack and Audio Jam both do chords plus stems plus slow-down **on phones**. Say so plainly. Our niche A claim is the desktop browser.

### 4.3 Guide briefs
Unchanged from v1.0 §4.3 except:
- titles and metas as in §4.2;
- `/demo` links wait for SEO-18;
- **G1 is written in full in Appendix A** as the pattern for the rest;
- G1 and G6 state the missing slow-down and name the tools that have it;
- the G2 and G5 FAQs avoid "clean";
- v1.0's G10 step 6 ('Limits: 5 minutes, 24 hours') becomes the full `ENTITY_LIMITS` text. v1.0's G3 FAQ becomes 'Which chord app gets the most chords right?'. v1.0's G5 step 2 becomes 'keep a metronome running if you need one (we have none; say so)'.

**Schema per guide:** `Article` plus `BreadcrumbList` plus the optional `FAQPage`, in one `@graph`.

### 4.4 SEO-12: content template (build once)
**Owner:** agent. **Effort:** 4 h. **Depends on:** Phase 0 merged.

**Checklist**
- [ ] `apps/web/src/content/types.ts`: `ContentDoc { path; h1; lead; sections: { h2; body: Block[] }[]; faq?: { q; a }[]; links: string[]; checked: string; sources?: { claim; url; checked }[] }`.
  - `Block` is `p | ul | ol | table | callout`.
  - Content modules import `MAX_TRACK_MIN` and `ENTITY_LIMITS`; no literal minute figures, except the two exemptions in the content-copy test below.
- [ ] `apps/web/src/components/content/ContentPage.tsx` (server component) renders:
  - `SiteHeader`;
  - the H1, lead, sections and FAQ (`<details>`);
  - the byline and "Last checked";
  - related links;
  - `SiteFooter`;
  - one `JsonLd`.
- [ ] Route files: every "Route file (created by SEO-12)" in §4.1.
  - Each looks up its doc and registry entry.
  - Dynamic routes use `generateStaticParams` over the content module's slugs, plus `export const dynamicParams = false`.
  - **If the registry entry is `published: false` and `process.env.VERCEL_ENV === 'production'`, call `notFound()`.** On preview deployments it renders with noindex (via `pageMetadata`).
- [ ] Ship with one sample doc: `/glossary` with three terms, `published: false`.
- [ ] Update `signed-in-nav.test.mjs:331`: the count of marketing pages equals the number of `page.tsx` files under `(landing)`, and each renders `SiteHeader`. **Flag this for Jon in the PR; it changes a pinned count.**
- [ ] `test/content-copy.test.mjs`:
  - For every doc, render its route with `renderPage()` for static routes, or `compile()` plus `React.createElement(mod.default, { params })` for dynamic ones.
  - Assert:
    - banned words absent, in both normalisations: `textSpaced` (every tag becomes a space) and `textTight` (every tag removed), as `landing-copy.test.mjs` defines them; either matching fails;
    - no `!`, except inside the product name `Transcribe!`;
    - no YouTube in title, H1, H2 or meta;
    - no `$` followed by a digit, `/mo`, "credits", or `Free plan`/`Pro`/`Studio` as our plan names. Rule: a `\bFree plan\b` (case-insensitive) or `\b(Pro|Studio)\b` match fails unless it sits inside a `{ claim, url, checked }` competitor cell or directly follows a competitor name from the compare registry (so "Moises Pro" on `/practice/guitar` passes);
    - in each content module's source, every minute figure comes from `${MAX_TRACK_MIN}` or `ENTITY_LIMITS` (pattern: `landing-copy.test.mjs:375-393`). The rendered page will show "5 minutes" through `ENTITY_LIMITS`, so this is a source check, not a rendered-text check. **Exempt:** (a) figures inside a `sources`-backed competitor cell (`{ claim, url, checked }`); (b) the measured runtime "about 1–3 minutes" (copy the landing test's carve-out); (c) in G7 (`/guides/play-along-routine`) only, routine timings, written as `N min` (for example "5 min of soloed listening") and listed in an allowlist in the test so any other figure still fails (REVIEW-8 S2). Never feed a competitor figure from `MAX_TRACK_MIN`;
    - no social-proof patterns (copy the landing regex);
    - H1 ≤ 6 words;
    - every compare claim has `url` and `checked`;
    - no quoted song title other than "Lucky Ticket". Rule: every span in straight or curly double quotes made of 1–6 Title-Case words is a candidate; it fails unless it is "Lucky Ticket" or on the test file's allowlist of UI labels and product names (for example "Paste a song").
- [ ] `test/unpublished-404.test.mjs`: compile the glossary route with `VERCEL_ENV=production` and assert the default export throws Next's not-found error. The repo's `next/navigation` stub pattern in `signed-in-nav.test.mjs` shows how to stub `notFound`.
- [ ] Footer "Learn" nav from `publishedPages()`.

**Acceptance**
- All tests are green.
- The `next build` legend shows every new route as **○ or ●, never ƒ**.
- The sample renders on a preview deployment with header, footer, canonical, JSON-LD and noindex, and returns 404 in a production build (`VERCEL_ENV=production next build`; a plain local `next build` does not set it).

---

## 5. AI-search plan: becoming the cited answer

### 5.1 How each engine finds sources

| Engine | Source of pages | What we do | Source |
|---|---|---|---|
| Google AI Overviews and AI Mode | Google's index; the page must be indexed and snippet-eligible | Phase 0; no `nosnippet` | [S1][S2] |
| ChatGPT search | OAI-SearchBot; plus unnamed "other search providers"; ChatGPT-User for user-requested fetches | OAI-SearchBot is allowed today; unblock ChatGPT-User (D-SEO-1); be in Bing as a hedge | [S9][S14] |
| Perplexity | PerplexityBot index; Perplexity-User for live fetches | Both allowed today; name Perplexity-User explicitly (D-SEO-1) | [S11] |
| Claude | Claude-SearchBot index; Claude-User fetches | Both allowed today through `*`; name them (D-SEO-1); ClaudeBot stays blocked | [S10] |
| Copilot | The Bing index | BWT, sitemap, IndexNow | [S14] |

### 5.2 What gets cited today
Proxy: WebSearch on 2026-11-13 [S23]. A live panel starts with SEO-27.

| Query type | Sources that surfaced | Benchmark notes |
|---|---|---|
| chords plus mute instruments | **Yamaha Extrack page**, Moises made-for pages, App Store listings | Extrack's page directly answers niche A, on mobile. Moises wins on volume. Chordify and Yousician were absent. |
| mute guitar and play along | Extrack, Moises made-for and tutorial, SoundBoost, FaChords | Moises; SoundBoost's instrument pages |
| remove bass to practise | LALAL.AI, EaseUS, SoundBoost, BassBuzz, TalkBass | Separators and forums; no practice-first page |
| drumless track | Mutedrums, SoundBoost, Drumeo's tutorial on Moises, Moises | Moises gains third-party coverage |
| learn a song by ear | TrueFire, Musical U, Pickup Music, wikiHow | No tool vendor |
| chordify alternative | AlternativeTo, Moises, reviews | Chordify cited through AlternativeTo (no stem tool listed [S21]) |
| yousician alternative | guitarspace, americansongwriter, guitarchalk, AlternativeTo | Yousician cited through review sites |

### 5.3 The plan
1. **Answer-first paragraphs** that can be quoted alone.
2. **Exact-question FAQs**, visible and marked up.
3. **Fact-led comparison pages** for the three primary benchmarks. *Hypothesis:* balanced pages are quoted for "X vs Y" prompts. SEO-27 measures it.
4. **A glossary** for definitional prompts.
5. **Entity consistency:** the two §1.3 sentences everywhere, plus the disambiguation line.
6. **Third-party corroboration:** AlternativeTo, directories (GTM-A14), Jon's forum answers, YouTube demos.
7. **Freshness:** "Last checked" dates and the `/how-it-works` changelog. When tempo ships, update every "not yet" the same day.
8. **Fix wrong answers at the cited source** (SEO-27).
9. **No tricks:** no hidden text, no instructions to AI systems (RESEARCH.md found a competitor doing this), no cloaking.

---

## 6. Off-page and community

### 6.1 Profiles (SEO-22, with GTM-A14)
- **Bio:** both §1.3 sentences.
- **Handle:** `stem-loops`, or `stemloops` where hyphens aren't allowed.
- **Profiles:**
  - AlternativeTo (as an alternative to Chordify, Moises, Yousician, Capo and Transcribe!);
  - Product Hunt (product page now, launch per GTM in March 2027);
  - SaaSHub, There's An AI For That, Futurepedia, Toolify;
  - YouTube `@stem-loops`;
  - claim only: X/Bluesky and a GitHub organization;
  - Jon's real Reddit account.
- Each live URL is added to `SAME_AS`, **except the YouTube channel**: it is not added to `SAME_AS`, because `jsonld.test.mjs` fails on any "youtube" in the JSON-LD and §10.1 bans YouTube in schema. Link the channel from a page instead (REVIEW-8 S1).

### 6.2 Communities
As in v1.0 §6.2: r/guitarlessons, r/Guitar, r/bassguitar and r/Bass, r/WeAreTheMusicMakers (weekly threads only), BassBuzz, TalkBass, worship groups (GTM-A12), teachers (GTM-A8).

**Rules (GTM-A2)**
- Jon only, 0.5 h a week, 9:1 helpful to self-mention.
- Modmail first.
- UTM on every link.
- Stop after two months under 5 UTM signups.

### 6.3 Outreach templates (all five limits, M10)

**Forum reply** (only where someone asks for a tool):
> Solo the part first so you can hear it on its own, then loop one section and play over it with the part muted. I built a browser tool for this, stem-loops: six stems with faders and a chord track. It runs in Chrome on the desktop, uses the first 5 minutes of any song and deletes files after 24 hours. You need an account to open the player, and the rights to the audio you add. The chords are an estimate, so check them by ear. https://stem-loops.com/?utm_source=reddit&utm_medium=community&utm_campaign=a2

**Modmail:**
> Hi. I make stem-loops, a browser play-along tool (six stems on faders and a chord track). It runs in Chrome on the desktop, uses the first 5 minutes of any song, deletes files after 24 hours, and needs an account to open the player and the rights to the audio. Before I post anything, is there a thread or day where a short write-up of a practice tool is welcome here? If not, I'll stick to comments. Thanks.

**Listicle author:**
> Subject: A web play-along tool for your guitar apps list
>
> Hi [name],
>
> Your [article] compares practice apps. stem-loops may fit: add a song and it opens in a browser player with six stems on faders and a chord track above them. The limits, so you can judge: Chrome on the desktop only, the first 5 minutes of any song, files deleted after 24 hours, an account to open the player, and users need the rights to the audio. The chords are an estimate, and there is no tempo change yet. [Until SEO-18: "The home page shows the player." After SEO-18: "There's a demo on my own song; the demo opens without signing in: https://stem-loops.com/demo"]
>
> Jon Cartwright

**Teacher:**
> Subject: Play-along tracks from the songs your students bring
>
> Hi [name],
>
> I make stem-loops. A student adds a song, and it opens with six stems they can mute or solo and a chord track above. It runs in Chrome on a desktop or laptop and uses the first 5 minutes of any song. Students need an account to open the player and the rights to the audio they add. Files are deleted after 24 hours. If it's useful, a link from your resources page would help other teachers find it. [Demo line as above, after SEO-18.]
>
> Jon

**Product Hunt first comment** (per GTM):
> I play guitar and wanted one screen with the chords above and my part muted. That's what this is: six stems on faders, a chord track, and section looping, in the browser. What it doesn't do yet: tempo and pitch change. It runs in Chrome on the desktop only, uses the first 5 minutes of any song and deletes files after 24 hours. You need an account to open the player, and the rights to the audio you add. [Demo line after SEO-18.]

**YouTube clips (GTM-N4):** 30–60 s screen recordings on Lucky Ticket. The description carries both §1.3 sentences.

### 6.4 Links we won't build
- No paid links, link swaps or irrelevant guest posts.
- No reviews in exchange for credits.
- No AI-written posts on other sites.

---

## 7. Measurement

### 7.1 Setup
- **SEO-09:** GSC and BWT, including the AI Performance report [S13]. GSC counts AI Overviews and AI Mode clicks inside "Web" [S2].
- **SEO-11: first-touch capture. Needs Jon decision (D-SEO-8); not agent-ready.** The idea: a first-party cookie `sl_ft` (30 days, `SameSite=Lax`), set by `middleware.ts` when absent and the `Referer` host is external, holding `{host, utm_source, utm_medium, utm_campaign}`, copied to the user's profile at signup. Why it is not briefed yet:
  - **Consent.** A non-essential first-touch cookie for EU and UK visitors may need consent under ePrivacy/PECR (raised in REVIEW-2 item 9, still open). That is Jon's call, with counsel if he wants it, not an agent's. The options are in D-SEO-8.
  - **Overlap with GTM-G4.** GTM-G4 already owns events and UTM capture. First touch may belong inside it rather than as a separate SEO task.
  - **The write path is not "the signup route".** Facts at `764e0f2`:
    - the profile table is `public.users` (`id`, `email`, `created_at`, `display_name`, `marketing_opt_in`; migration `013_v3_commercial.sql`), RLS self-read only, written by `stemloops_app`;
    - its row is seeded by the `on_auth_user_created` trigger on `auth.users` (`public.handle_new_user()`, migration 013), not by `app/api/auth/signup/route.ts`, which only calls `supabase.auth.signUp`;
    - OAuth signups go through `components/LoginForm.tsx` → `app/auth/callback/route.ts` and never touch the signup route;
    - `apps/worker/src/worker/models.py` (the path AGENTS.md means by "models.py") has job models only; there is no user model to extend, so AGENTS.md's "edit models.py → `make types-generate` → commit both" needs a decision on whether a `User` model is added there first.
  - **Gates once decided.** A new migration under `apps/worker/migrations/` with its `down/` file (M-3: stub any `auth.*` reference); `make types-generate` if `models.py` changes; M-9 review on a different model family (migration); **M-11 security review ≥ 90** (auth path and a new cookie); **Jon merges the migration**. Effort is nearer 6 h than 3 h with those rounds.
  - **AI hosts (host-only; the cookie stores a host, so a pattern with a path can never match):** `^(chatgpt\.com|chat\.openai\.com|(www\.)?perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|(www\.)?you\.com|(www\.)?phind\.com)$`. Bing chat now lives at `copilot.microsoft.com`; plain `bing.com` is organic search, not AI. Also count `utm_source=chatgpt.com`, but verify that it appears in our data before relying on it.
  - Page-level views come from Vercel Web Analytics (D-SEO-5), which sets no cookie and does not depend on this decision.
  - The privacy notice is updated in the same PR.
  - **Until D-SEO-8 is answered,** there is no signup-level first-touch number; §7.2 says what replaces it.
- **SEO-27: monthly panel.** 20 fixed prompts × 5 engines = 100 rows a month. Prompts as in v1.0 §7.1.

### 7.2 KPIs (day 0 = Phase 0 live)
All targets are **ESTIMATES**:
- scaled from GTM-A1's kill metric (≥40 organic signups in month 8) and the 33-week time to effect;
- recalibrated at day 30.

| KPI | Source | Day 30 | Day 60 | Day 90 |
|---|---|---|---|---|
| Sitemap URLs indexed / submitted | GSC | 100% of published | 100% | ≥ 90% of published (about 18 content pages by day 90 under the §8.1 phases, so about 21 sitemap URLs with `/`, `/privacy` and `/terms`; `/demo` waits on GTM-N2 and G9 on counsel) |
| Indexable app routes | GSC + curl | 0 | 0 | 0 |
| `"stem-loops" play along` | GSC, Bing | #1 | #1 | #1 |
| Plain `stem-loops` | GSC, Bing | tracked (collides with RNA and sample packs, §1.4) | tracked | top 3 |
| Non-brand impressions a month | GSC | ≥ 500 | ≥ 2,000 | ≥ 5,000 |
| Non-brand clicks a month | GSC | ≥ 10 | ≥ 50 | ≥ 150 |
| Pages with a non-brand query in the top 20 | GSC | ≥ 2 | ≥ 6 | ≥ 10 |
| Niche A, B, C best query average position | GSC | tracked | ≤ 30 | ≤ 15 |
| "what is stem-loops" correct | SEO-27 | ≥ 2 of 5 engines | ≥ 3 of 5 | ≥ 4 of 5 |
| Mentioned on niche prompts 3–15 (of 65) | SEO-27 | ≥ 1 | ≥ 4 | ≥ 8 |
| Bing AI Performance citations | BWT | tracked | tracked | tracked (no benchmark; the first readings set the baseline) |
| Referring domains | GSC | ≥ 5 | ≥ 10 | ≥ 20 |
| Signups with an AI or organic first touch | (a)/(b): `sl_ft` on `public.users`; (c): GTM-G4's signup event with referrer. **Dropped under (d)**: GSC and BWT count clicks, not signups. | tracked | ≥ 3 | ≥ 10 |
| Content pages within the SEO-10 budgets | build + Lighthouse | all | all | all |

**Who reads GTM-A1's kill metric** (≥ 40 organic signups in month 8): Jon, from GTM-G4's weekly metrics email, which needs a referrer on the signup event (option (c)). Under (d) the kill metric has no source and must be restated as a clicks metric.

**Kill and rethink rule.** Under 1,000 non-brand impressions at day 90 with all published pages indexed means stop new content and review the targeting. Don't add pages.

---

## 8. Implementation plan

### 8.0 Decisions for Jon

| ID | Question | Recommendation | Gates |
|---|---|---|---|
| **D-SEO-1** | Unblock ChatGPT-User, and name Claude-SearchBot, Claude-User and Perplexity-User with `/api/` and `/jobs/` disallowed? Training bots stay blocked. **Trade-off:** GPTBot is the main AI reader of llms.txt files (SEO-07, [S12]), and answers given without search come from training crawls, so blocking them costs that; with static pages and `/api/`, `/jobs/` disallowed, the cost argument for blocking is weaker. (REVIEW-6 reports that Anthropic's crawler page also names Claude-Agent; check it at SEO-03 time.) | Yes, but Jon should weigh the trade-off | SEO-03 |
| **D-SEO-2** | Bylines and `/about` in your name, a `Person` node, and which profiles go in `sameAs`? | Yes | SEO-13; Person node; guide bylines |
| **D-SEO-3** | US "Practice" as the verb in `<title>` and meta only? Body copy stays Canadian. | Yes, as a BRAND-TONE exception | SEO-19, 21, 23 titles |
| **D-SEO-4** | Competitor prices on compare pages? | No for v1 | SEO-16 |
| **D-SEO-5** | Turn on Vercel Web Analytics (cookieless page views and referrers)? Independent of D-SEO-8. | Yes | SEO-09 (page-level views) |
| **D-SEO-6** | Keep `/pricing` noindex until GTM-G5? | Yes (§3.0) | SEO-28 |
| **D-SEO-7** | Add "the demo opens without signing in" to BRAND-TONE §6 as a pinned exception? | Yes. When `/demo` ships, `ENTITY_LIMITS`' account sentence becomes "You need an account to open the player with your own songs" in the SEO-18 PR, so the two never contradict (N-5). | SEO-18, templates |
| **D-SEO-8** | First-touch capture (SEO-11): (a) build it with a consent banner for EU/UK visitors, (b) build it but set `sl_ft` only where no consent is needed (geo by Vercel's `x-vercel-ip-country`), (c) fold it into GTM-G4, or (d) skip it and rely on UTM links, GSC and BWT. Also: may a `User` model be added to `models.py`? | (c) if GTM-G4 is building UTM capture anyway; otherwise (d) until signups justify it | SEO-11 |

### 8.1 Ranked tasks

**Order follows dependencies first and composite second.** For example, SEO-04 comes before SEO-01, which scores higher.

Composite = (T + C + V + E) ÷ 20 × 100, the GTM rubric. The scores are my judgement.

| Order | ID | Task | Phase | Owner | Effort | Depends on | T | C | V | E | Composite |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | SEO-00 | Commit docs to `docs/seo/` | 0 | agent | 10 min | — | 5 | 5 | 2 | 5 | 85 |
| 2 | SEO-08 | 308 www redirect | 0 | Jon | 5 min | — | 5 | 5 | 2 | 5 | 85 |
| 3 | SEO-P0 | Apply the Phase 0 patch (04, 01, 02, 06, 05, 07) | 0 | agent | 1 h | 00 | 5 | 5 | 4 | 5 | **95** |
| 4 | SEO-09 | GSC, BWT, Keyword Planner | 0 | Jon | 50 min | P0 live | 5 | 5 | 5 | 4 | **95** |
| 5 | SEO-03 | robots: AI search and user bots | 0 | Jon, then agent | 30 min | D-SEO-1 | 5 | 5 | 3 | 4 | 85 |
| 6 | SEO-11 | First-touch referrer capture (**needs Jon decision**) | 1 | Jon decides, then agent; Jon merges the migration | about 6 h with M-9 and M-11 | **D-SEO-8**, GTM-G4 | 4 | 5 | 4 | 2 | 75 |
| 7 | SEO-12 | Content template, routes, tests, footer | 1 | agent | 4 h | P0 | 4 | 5 | 4 | 4 | 85 |
| 8 | SEO-16 | Compare ×3 + hub | 1 | agent; Jon reviews 1 h | 6 h | 12, D-SEO-4 | 3 | 5 | 5 | 4 | 85 |
| 9 | SEO-17 | `/chord-track` | 1 | agent; Jon 20 min | 2 h | 12 | 3 | 5 | 5 | 4 | 85 |
| 10 | SEO-13/14/15 | `/about`, `/how-it-works`, `/glossary` | 1 | agent; Jon 30 min | 4 h | 12, D-SEO-2 | 3 | 5 | 4 | 4 | 80 |
| 11 | SEO-22 | Profiles and directories (GTM-A14) | 1–2 | Jon | 2 h | 13 | 4 | 5 | 4 | 3 | 80 |
| 12 | SEO-18 | `/demo` | 2 | agent | per GTM-N2 | **GTM-N2** | 3 | 5 | 5 | 3 | 80 |
| 13 | SEO-19 | `/practice/*` ×4 | 2 | agent; Jon 40 min | 5 h | 12, D-SEO-3 | 3 | 5 | 4 | 4 | 80 |
| 14 | SEO-20 | `/section-loop` | 2 | agent | 1.5 h | 12 | 3 | 5 | 4 | 4 | 80 |
| 15 | SEO-21 | `/guides` + G1–G4 | 2 | agent; Jon 1.5 h | 8 h | 12 | 2 | 5 | 4 | 4 | 75 |
| 16 | SEO-10 | Performance budgets | 1–2 | agent | 1 h | 12 | 3 | 5 | 2 | 5 | 75 |
| 17 | SEO-27 | Monthly AI panel; quarterly fact check | 2 → | agent | 1 h a month | 09 | 3 | 5 | 3 | 5 | 80 |
| 18 | SEO-23 | G5–G8, G10 | 3 | agent; Jon 2 h | 10 h | 21 | 2 | 5 | 3 | 4 | 70 |
| 19 | SEO-24 | Community answers (GTM-A2) | 3 → | Jon | 0.5 h a week | 21 | 2 | 4 | 3 | 3 | 60 |
| 20 | SEO-26 | YouTube clips (GTM-N4) | 3 | agent | per GTM-N4 | 18 | 2 | 5 | 3 | 3 | 65 |
| 21 | SEO-23b | G9 copyright | 3 | agent + counsel | 2 h + counsel | GTM-G3 | 1 | 4 | 3 | 2 | 50 |
| 22 | SEO-28 | Index `/pricing` | after GTM-G5 | agent | 1 h | GTM-G5, QA P1 | 2 | 5 | 3 | 4 | 70 |
| 23 | SEO-25 | Product Hunt / Show HN | Mar 2027 | Jon | 3 h | 18 | 2 | 5 | 3 | 3 | 65 |
| 24 | SEO-29 | Published chord-accuracy page | after GTM-G1 | agent + Jon | 4 h | GTM-G1 engine | 2 | 5 | 4 | 3 | 70 |

**Phases:** 0 = weeks 0–1 · 1 = weeks 1–3 · 2 = weeks 3–8 · 3 = weeks 8–16.

**Jon's load:** about 1.5 h in week 0, about 1 h a week to week 8, then 0.5 h a week.

### 8.2 Acceptance for every task from SEO-11 on (M7)

| Task | Acceptance |
|---|---|
| SEO-11 | **Not specified here: needs D-SEO-8** (§7.1 lists the facts and gates). If Jon picks (a) or (b), the acceptance is written with the brief and must include: a middleware test in the style of `csp-headers.test.mjs` (an external AI referer with no `sl_ft` sets it with the bare host; an internal referer, or a host with a path, sets nothing); tests for **both** signup paths (email and OAuth callback) showing the host reaches `public.users`; the migration and its down file; the privacy notice with `legal-privacy-copy.test.mjs` green; M-9 and M-11 (≥ 90) reports in the PR; Jon merges. |
| SEO-12 | As in §4.4 (build legend ○ or ●, never ƒ; the unpublished-404 test; the content-copy test; the nav count updated and flagged). |
| SEO-13, 14, 15, 16, 17, 19, 20, 21, 23 | **(1)** A registry entry exists with `published: false`. **(2)** The rendered route (`renderPage()` for static routes, or `compile()` plus `params` for dynamic ones) contains the H1 from §4.2, an answer-first paragraph, the `ENTITY_LIMITS` text (every page; `/glossary` carries it in the stem-loops entry) and a visible "Last checked" date. **(3)** `content-copy.test.mjs` is green. **(4)** The PR has a table of every factual claim → source URL with check date, or `file:line` at the current `origin/v3/main`. **(5)** Jon sets `published: true` in a separate one-line PR. After deploy, the URL is in `/sitemap.xml` and `/llms.txt`. |
| SEO-16 extra | Every competitor cell has `url` and `checked` set within the last 7 days. "Where [X] is better" has ≥3 items. There is no price. |
| SEO-18 | **Not specified here: blocked on GTM-N2** (a no-sign-in demo on owned music, every rights holder consenting). Until GTM-N2 ships, `/demo` is absent from every link list and template (`/demo` is 404 live). When GTM-N2 ships: the route returns 200 signed out; the registry entry is published; the page uses only Lucky Ticket; it is listed in the sitemap. |
| SEO-22 | Each profile URL returns 200, and its bio contains `ENTITY_ONE_LINER`. `SAME_AS` is updated in a PR (never with the YouTube channel), and `jsonld.test.mjs` is green (now asserting a non-empty `sameAs`). |
| SEO-23b | Same as the content row, plus counsel's sign-off quoted in the PR. Not published without it. |
| SEO-24 | A weekly row in `docs/seo/data/community-log.csv` (thread URL, reply URL, UTM link), committed monthly in a docs PR. UTM signups counted from the UTM links (and through SEO-11 if D-SEO-8 says build). |
| SEO-25 | The launch URL is live. The first comment matches §6.3. UTM signups recorded. |
| SEO-26 | Three clips are published. Each description carries both §1.3 sentences. Each is **linked** from its page, not embedded: `middleware.ts` sets the CSP `frame-src` to hCaptcha only, so an embed needs a CSP edit (an M-11 security review) and a line against the SEO-10 budget first (REVIEW-8 S4). |
| SEO-27 | `docs/seo/data/ai-panel-YYYY-MM.csv` has **100 rows** (20 prompts × 5 engines), with the columns date, engine, prompt #, mentioned, cited URLs, correct, errors and competitors named. The BWT AI Performance CSVs are saved beside it. There is a 10-line summary with one fix per wrong statement. |
| SEO-28 | Precondition: GTM-G5 and Stripe are live, and QA P1 is resolved. Then: `/pricing` uses `pageMetadata()`, noindex is removed, the page is added to the registry and sitemap, and paid `offers` are added to the JSON-LD. `noindex-app-routes.test.mjs` drops pricing from its source check. `pricing-*` tests are green. The live page shows a canonical and OG tags. |
| SEO-29 | The page states the test set (owned or licensed audio only), the metric, the score and the date, and links the scorer method. Every figure traces to a scorer output file named in the PR. |

### 8.3 Agent briefs (copy-paste)

**SEO-P0 (Phase 0)**
```
Repo: /home/claude/stem-loops. git fetch origin v3/main; branch seo/phase0 from origin/v3/main.
Read AGENTS.md and docs/seo/SEO-AIO-PLAN.md §3 (or, before SEO-00 lands,
/tmp/claude-0/-home-claude/05ea4b66-41d3-5ccc-8f1c-de57d46b3a91/scratchpad/overnight/SEO/SEO-AIO-PLAN.md §3).
Apply the patch from the repo root:
  git apply -p0 docs/seo/phase0-prototype.patch
  (or the scratchpad copy: .../overnight/SEO/phase0-prototype.patch)
The patch's base is 6846062; v3/main moves as PRs merge. If git apply --check fails, apply with
  git apply -p0 --reject docs/seo/phase0-prototype.patch
resolve only the rejected hunks (*.rej), delete the .rej files, and list each resolved hunk in the PR body.
Do not retype files that applied.
Review gates (AGENTS.md): M-9 applies (the middleware.ts matcher edit fails silently if wrong, trigger 4, and the patch
adds pass/fail tests, trigger 1). M-11 applies too: middleware.ts is the session-refresh and security-header file
(trigger 2); the security reviewer confirms that dropping /llms.txt from the matcher removes only session refresh
and CSP from a static text route. Jon merges after both.
Run: pnpm install; pnpm --filter web test; pnpm --filter web build.
Done when: tests green (expect 0 failures), build legend shows /sitemap.xml, /llms.txt, /, /privacy, /terms as ○,
and the PR body pastes the build rows and the five acceptance curls from §3 to run after deploy.
Do not change robots.ts beyond the sitemap line (the rest waits for D-SEO-1). Do not add Person/sameAs.
```

**SEO-03 (after D-SEO-1)**
```
Repo as above. Read docs/seo/SEO-AIO-PLAN.md §3 SEO-03 and the header of apps/web/src/app/robots.ts.
D-SEO-1 = <Jon's answer + date>. Implement the lists exactly, update test/robots.test.mjs as described
(wildcard test unchanged), update the header comment. Done when tests pass and the PR shows the rendered robots.txt.
```

**SEO-12 (template)**
```
Repo as above; Phase 0 merged. Read docs/seo/SEO-AIO-PLAN.md §4.0, §4.1, §4.4, docs/seo/BRAND-TONE.md,
apps/web/src/components/landing/SiteChrome.tsx, apps/web/test/helpers/render-chrome.mjs,
apps/web/test/helpers/render-landing-page.mjs, apps/web/test/signed-in-nav.test.mjs.
Build everything in the §4.4 checklist. Content lives in apps/web/src/content/. Tests import .ts with relative
'.ts' paths and .tsx via compile()/renderPage(), as Phase 0's tests do.
Done when §8.2's SEO-12 row passes.
```

**SEO-16 (compare pages)**
```
Repo as above; SEO-12 merged. Read §4.0, §4.2 "Compare pages", §10, and
docs/seo/RESEARCH.md (secondary set; committed by SEO-00).
Write apps/web/src/content/compare/{index,moises,chordify,yousician}.ts and their registry entries (published:false).
Re-fetch every competitor fact today from the competitor's own site, help centre or App Store listing; set url and checked.
Drop any fact you cannot re-verify. No prices. No logos or screenshots.
State our own limits from code (cite file:line at origin/v3/main), beside every competitor limit; use "free", never "Free plan".
Done when §8.2's content row and SEO-16 extra pass.
```

**SEO-17/19/20 (product pages)**
```
Repo as above; SEO-12 merged. Read §4.0 and §4.2 for the page. Before writing any capability, find it in code at
origin/v3/main and cite file:line in the PR; where the spec and the code disagree, follow the code and say so.
Lucky Ticket is the only example. No /demo links until SEO-18. published:false.
Done when §8.2's content row passes.
```

**SEO-21/23 (guides)**
```
Repo as above; SEO-12 merged. Read §4.0, §4.2 (title/meta/H1), §4.3 and Appendix A (G1 is the finished pattern).
For G1, port Appendix A into apps/web/src/content/guides/learn-a-song-by-ear.ts verbatim except link targets, and replace the limits sentence ("It runs in Chrome on the desktop … the rights to the audio you add.") with ENTITY_LIMITS.
For others, follow docs/seo/SEO-AIO-PLAN-v1.0.md §4.3 outlines with the changes in §4.3 of docs/seo/SEO-AIO-PLAN.md. No commercial song names.
G9 waits for counsel. published:false.
Done when §8.2's content row passes.
```

**SEO-27 (panel)**
```
Run the 20 prompts (docs/seo/SEO-AIO-PLAN-v1.0.md §7.1 list) in ChatGPT (search on), Perplexity, Google AI Mode, Claude (web search on), Copilot,
fresh sessions. Write 100 rows to docs/seo/data/ai-panel-YYYY-MM.csv, save the BWT AI Performance CSVs beside it,
write the 10-line summary, and open one docs PR. Quarterly: re-verify every /compare claim and update checked dates.
```

---

## 9. Better ideas Jon may have missed

1. **Publish our chord accuracy, with the method (SEO-29).** No competitor publishes one, and reviews complain that chords are wrong (RESEARCH.md). An honest number, even a modest one, would be the most citable page in the category.
2. **Own-recording use cases (G10).** Bands, rehearsals, teachers' arrangements: legally clean, and nobody targets them.
3. **The demo as the link magnet.** Once GTM-N2 ships, it leads every outreach template.
4. **Fix the name collision early** (§1.4).
5. **Treat "not yet" as content.** Shipping tempo is a launch moment for every "not yet" page, and it flips the Moises, Extrack and Audio Jam rows.
6. **Mobile visitors from search.** ESTIMATE, not measured: a large share of music-learning searches likely happen on phones, and we support desktop Chrome only. Check the GSC device split at day 30. If mobile is over 50%, add an "email me this link for my computer" affordance (GTM-A5 email stack).
7. **Teacher sheet**, if GTM-A8 shows traction.
8. **Ask beta users (GTM-G2)** what they searched for before finding us.
9. **Don't fight Moises on page count.** Go deep on three niches.

---

## 10. Risks and what not to do

### 10.1 Legal

| Risk | Rule |
|---|---|
| Copyrighted song names | Never in titles, URLs, H1s, examples or screenshots. No "chords for [song]" pages. Users' jobs are never public content. |
| DMCA | Depends on GTM-G3. No sharing claims before GTM-D4s is decided. |
| YouTube | Input type only. Never in any title, H1, H2, meta, URL, schema, ad or outreach. The YouTube FAQ stays out of FAQ schema. |
| Competitor trademarks | Nominative use only. No logos or UI screenshots. Every claim sourced and dated. A correction contact on every page. |
| G9 | Not legal advice; counsel sign-off required. |
| Privacy | If D-SEO-8 says build, SEO-11 updates the privacy notice in the same PR. |
| Unpublished drafts | 404 in production (SEO-12), so unverified competitor claims are never public. |

### 10.2 Honesty rules
- Five limits on every product page.
- Measured timings only.
- No downbeat promise.
- No fake ratings, reviews, user counts or testimonials (the landing test enforces this).
- Illustrations are labelled.
- AI-assistance disclosure [S3].
- "the demo opens without signing in" is the only "no sign-in" phrase (D-SEO-7).

### 10.3 What not to do
- No mass-generated pages; the cap is 25 [S4].
- No separator head terms as primary pages.
- No `aggregateRating` or `review` schema.
- No HowTo schema.
- No FAQ markup for questions that aren't visible.
- No hidden text, cloaking or instructions to AI systems.
- No robots `Disallow` in place of noindex.
- No ƒ content pages.
- No paid links or sock puppets.
- No machine translation.
- No prices on content pages before GTM-G5.
- No stale "not yet".

---

## 11. Sources

All web sources were read 2026-11-13. S25–S30 are new in v1.1.

| # | Source | URL | Notes |
|---|---|---|---|
| S1 | Google, "Optimizing your website for generative AI features" | https://developers.google.com/search/docs/fundamentals/ai-optimization-guide | updated 2026-07-10 |
| S2 | Google, "AI features and your website" | https://developers.google.com/search/docs/appearance/ai-features | updated 2025-12-10 |
| S3 | Google, "Creating helpful, reliable, people-first content" | https://developers.google.com/search/docs/fundamentals/creating-helpful-content | updated 2026-10-05 |
| S4 | Google, "Spam policies" | https://developers.google.com/search/docs/essentials/spam-policies | updated 2026-08-28 |
| S5 | Google, "Software App structured data" | https://developers.google.com/search/docs/appearance/structured-data/software-app | updated 2026-09-08 |
| S6 | Search Engine Journal, "Google drops FAQ rich results" | https://www.searchenginejournal.com/google-drops-faq-rich-results/574429/ | 2026-05-10. Says the markup is harmless; says nothing about other engines. |
| S7 | Google, "Changes to HowTo and FAQ rich results" (2023) | https://developers.google.com/search/blog/2023/08/howto-faq-changes | search result only; not fetched |
| S8 | Search Engine Journal, opting out of Google's AI features | https://www.searchenginejournal.com/what-opting-out-of-googles-ai-search-features-means-now/ | 2026-08-01 |
| S9 | OpenAI, "Overview of OpenAI Crawlers" | https://developers.openai.com/api/docs/bots.md | |
| S10 | **Anthropic**, "Does Anthropic crawl data from the web, and how can site owners block the crawler?" | https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler | Primary. ClaudeBot (training), Claude-User (user queries), Claude-SearchBot (search quality). Replaces the SE Roundtable citation. |
| S11 | Perplexity, "Perplexity crawlers" | https://docs.perplexity.ai/docs/resources/perplexity-crawlers.md | |
| S12 | Ahrefs, llms.txt study | https://ahrefs.com/blog/llmstxt-study/ | 2026-06-15 |
| S13 | Search Influence, Bing AI Performance report | https://www.searchinfluence.com/blog/bing-ai-performance-report-copilot-citations/ | 2026-02-12 |
| S14 | eSEOspace, Bing, IndexNow and ChatGPT | https://eseospace.com/blog/bing-webmaster-tools-indexnow-ai-search/ | 2026-10-13. SECONDARY. |
| S15 | Semrush, moises.ai overview | https://www.semrush.com/website/moises.ai/overview/ | US, October 2026 |
| S16 | Semrush, chordify.net | https://www.semrush.com/website/chordify.net/overview/ | September 2026; no keyword detail |
| S17 | Semrush, yousician.com | https://www.semrush.com/website/yousician.com/overview/ | September 2026; no keyword detail |
| S18 | Moises Help, platforms and devices | https://help.moises.ai/hc/en-us/articles/12156312650012-Is-Moises-different-across-platforms-and-devices | re-fetched 2026-11-13 |
| S19 | Moises, guitar backing tracks page | https://moises.ai/made-for/guitar-backing-tracks/ | |
| S20 | Yousician, About | https://yousician.com/about | re-fetched 2026-11-13. "20M+" MAU is combined with GuitarTuna. |
| S21 | AlternativeTo, Chordify alternatives | https://alternativeto.net/software/chordify/ | |
| S22 | Next.js 14, sitemap.xml | https://nextjs.org/docs/14/app/api-reference/file-conventions/metadata/sitemap | |
| S23 | WebSearch probes | queries in §5.2 | A search proxy, not a rank report |
| S24 | web.dev, "Web Vitals" | https://web.dev/articles/vitals | |
| S25 | Moises Help, "Which instruments can be separated on the Free plan" | https://help.moises.ai/hc/en-us/articles/29530482524316-Which-instruments-can-be-separated-on-the-Free-plan | 2 or 4 stems; 5 uploads a month; 5 minutes; individual instruments Premium or Pro. The page shows "Updated" with no date. |
| S26 | Chordify, App Store listing | https://apps.apple.com/us/app/chordify-songs-chords-tuner/id1073624757 | Version 9.7.0. "36,000,000 song catalog"; chords over lyrics "7,500+ songs"; slow-down, transpose, loop and capo Premium; no stems mentioned. |
| S27 | MusicRadar, Chordify lyrics and live chord detection | https://musicradar.com/news/chordify-lyrics-live-chord-detection | 2023-07-04 |
| S28 | Yamaha, Extrack | https://usa.yamaha.com/products/apps/extrack/ | iOS and Android; separation, real-time chords, tempo and key, section repeat; basic features free |
| S29 | Audio Jam, App Store listing | https://apps.apple.com/us/app/-/id6745493736 | Separation (vocals, drums, guitar); chord detection; A/B loop; 50% slow-down; Pro: 100 splits a month, 20 minutes |
| S30 | Next.js 14, "Metadata": Merging and overwriting fields | https://nextjs.org/docs/14/app/building-your-application/optimizing/metadata | "shallowly merged"; a child's `openGraph` replaces the parent's |

**Internal sources**
- `$SP/gtm/RESEARCH.md` (in the repo as `docs/seo/RESEARCH.md` after SEO-00), `$SP/gtm/BRIEF.md`, `$SP/gtm/MATRIX.md`
- `$SP/overnight/BRAND/JON-BRAND-GUIDE-v2-SUMMARY.md`
- `$SP/overnight/COPY/BRAND-TONE.md` v1.3.1
- `$SP/overnight/QA/LIVE-QA-2026-11-13.md`
- `$SP/overnight/SEO/REVIEW-1.md`
- `$SP/overnight/SEO/phase0-prototype.patch`
- Repo at `6846062` (v1.7; earlier versions `aa03af0`, `65c2319`, `764e0f2`)

**Not done**
- No live ChatGPT, Perplexity, Claude or Copilot answers were sampled (no signed-in sessions here); SEO-27 starts the real panel.
- Google Autocomplete and Keyword Planner were unreachable (SEO-09b).
- Chordify's and Yousician's prices were not re-verified (D-SEO-4).

---

## Appendix A. G1 in full: "How to learn a song by ear"

*Path `/guides/learn-a-song-by-ear`. Title "How to learn a song by ear · stem-loops". H1 "Learn a song by ear". Byline per D-SEO-2. Last checked 2026-11-13. About 900 words. Every product statement matches the landing page at `aa03af0`. Words are checked against BRAND-TONE: no banned words, Canadian spelling, no "YouTube".*

---

**Learn a song by ear**

To learn a song by ear, take it apart. Mark its sections, listen to your part on its own, and repeat one section until you can play it. Then check the chords against what you hear, and play the part with the rest of the band underneath you. This guide walks through those five steps, with a stem player and a chord track as the tools.

**What you need**
- The song, as an audio or video file you have the rights to use.
- Your instrument, and headphones. Laptop speakers lose most of the bass.
- A way to hear one part at a time. Here that is stem-loops, a browser play-along tool. Add a song and it opens in a player with six stems on faders, a chord track and section loops. It runs in Chrome on the desktop, uses the first 5 minutes of any song and deletes files after 24 hours. You need an account to open the player, and the rights to the audio you add.

One thing it does not do yet is play a song slower. If a passage is too fast to hear, a tool that slows audio without changing its pitch will help: Transcribe!, Capo and Moises all do this today.

**1. Listen through and mark the sections**

Play the whole song once without your instrument. Note where the verse, chorus and bridge start, and how many times each comes back. Most songs reuse a small number of sections, so learning three or four sections often covers the whole song.

stem-loops detects sections from the audio. Use them as a starting map, not a rule: the boundaries it finds may not match where you would put them.

**2. Solo your part**

Every stem has a fader, a mute and a solo. Solo the stem for your instrument (drums, bass, guitar, keys or vocals) and listen to the section you marked. Parts that disappear in a full mix, such as a bass line under a loud guitar or a keyboard pad, become easy to follow.

Expect some bleed. In dense passages you will hear traces of other instruments in a stem. If something sounds out of place, solo the neighbouring stem to see where it belongs. Six stems means guitar and keys have their own channels, but parts that share a range can still overlap. A piano and a synth both land in keys, for example.

**3. Loop one section**

Pick one detected section and let it repeat. Work on that and nothing else until you can play along with it. Short, repeated passes teach more than replaying the whole song.

A practical order:
1. Listen to the soloed loop three or four times without playing.
2. Find the first note or chord. Play only that, in time, each time it comes round.
3. Add the next few notes, then the next.
4. When a pass goes through without a stop, move to the next section.

The loop follows the detected section. It does not always start exactly on the first beat of a bar, so count yourself in.

**4. Check the chords by ear**

The chord track runs above the mixer, in time with the song. Treat it as a first draft. The chords are an estimate made from the audio, not a transcription someone checked. They are good enough to play along to on most songs, and they are wrong often enough that your ears should win. Dense voicings, altered chords, inversions and quiet passages are where they slip.

Four ways to check a chord:
- **Play the root with the bass.** Solo the bass stem and play the chord's root note along with it. If they clash, the chord name or its bass note is off.
- **Listen for major or minor.** Play both over the loop. One will sound settled.
- **Check the bass note.** If the bass plays a note other than the root, you may be hearing an inversion, written like G/B.
- **Trust repetition.** If a section repeats, the chords usually do too. A one-off difference in the chord track is more likely an error than a change.

**5. Mute your part and play it**

Now reverse step 2. Mute your stem, bring the others up, and play your part as the missing instrument. This is where the song comes together. You hear whether your timing sits with the drums and whether your notes fit the band.

If a bar still trips you up, go back to the loop for that section, solo again, then return to playing with your part muted.

**Common traps**
- **Octave errors.** A bass line heard through bleed in another stem can seem an octave off. Check against the soloed bass.
- **Hearing harmony as melody.** Backing vocals and keys can sound like a lead line. Solo each to be sure what you are copying.
- **Learning the mistakes.** If something feels wrong after a few passes, re-listen soloed before you drill it in.

**Questions**

*How long does it take to learn a song by ear?*
There is no single answer. It depends on the song, your instrument and how much of the song repeats. Working one section at a time makes progress visible, even when the whole song takes days.

*Do I need absolute pitch?*
No. Relative pitch, hearing how far one note is from another, is what you use. It improves with this kind of practice.

*Should I trust automatic chords?*
As a starting point. Check them by ear with the steps above, especially in dense or quiet passages.

*Can I slow the song down in stem-loops?*
Not yet. Playing a track slower without dropping its pitch is the next thing being built. Until then, the tools named at the top of this guide do it.

---
*How this was made: drafted with an AI assistant from our own product notes; checked and edited by Jon Cartwright.*
