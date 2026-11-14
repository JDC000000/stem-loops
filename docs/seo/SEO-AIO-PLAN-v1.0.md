# stem-loops: SEO and AI-search plan

**v1.0, 2026-11-13.** Written for Jon's brief of 10:31 PT, 2026-11-13. Updated at 10:35 for Jon's ruling: **Moises, Chordify and Yousician are the primary benchmark.** Songsterr, Ultimate Guitar, LALAL.AI, Fadr, Capo and Transcribe! are secondary.

**Basis**
- Code: `origin/v3/main` at `e739a9e`. Paths below are relative to `apps/web/src/` unless they start with `apps/`.
- Live site: read by GET on 2026-11-13.
- Web research: read on 2026-11-13. Every source is listed in §11 as [S#].
- Internal: `gtm/BRIEF.md`, `gtm/RESEARCH.md`, `gtm/MATRIX.md`, `BRAND/JON-BRAND-GUIDE-v2-SUMMARY.md`, `COPY/BRAND-TONE.md` v1.3.1.

**Status labels.** VERIFIED means read at the source. SECONDARY means read in a third-party report of the source. ESTIMATE means my judgement, with the method stated. No search volume in this document is invented. The volumes that appear come from Semrush via `gtm/RESEARCH.md` or [S15].

---

## 0. Executive summary

1. **Today the site cannot rank or be cited.**
   - `/sitemap.xml` and `/llms.txt` return 404.
   - The home page is the only indexable page with real content, and it has no structured data.
   - `/login` and `/history` can be indexed.
   - `www` redirects with a 307 (temporary).
   - `robots.ts` blocks Anthropic's search crawler and the user-initiated fetchers (ChatGPT-User, Claude-User).
   - A web search for "stem-loops" with "play along" returns nothing of ours [S23].
   - These are all one-to-two-hour code tasks (Phase 0).
2. **Position for search as a play-along tool, not a stem separator.** Separator head terms belong to free utilities: "vocal remover" 60,500 US searches a month, "stem splitter" 9,900 (Semrush via RESEARCH.md). They also bring off-target users. Our category words are *play along*, *chord track*, *mute your part* and *section loop*.
3. **Moises's organic traffic is mostly its own name.** In US October 2026 data [S15], brand terms ("moises", "moises ai", "moise", "moises app", "moisess") make up about 73% of its organic traffic. Its non-brand practice pages, such as `/made-for/guitar-backing-tracks/` [S19], are general feature lists. A specific, honest page for one job can outrank them.
4. **The site stays small and written by people.** It has 25 content pages at most, which is the GTM A1 cap. Agents draft, and Jon reviews and signs every page. Google's spam policy names "using generative AI tools … to generate many pages without adding value" as scaled content abuse [S4], and GTM already stopped "10 agent pages a week" (A1v) for this reason.
5. **AI search needs ordinary SEO plus open crawler access.**
   - Google says no llms.txt or special markup is needed for AI Overviews or AI Mode; a page needs only to be indexed and eligible for a snippet [S1][S2].
   - ChatGPT search needs OAI-SearchBot [S9], Perplexity needs PerplexityBot [S11], and Claude needs Claude-SearchBot [S10].
   - We build llms.txt anyway: it costs 45 minutes. We expect nothing from it: 97% of llms.txt files got no requests in Ahrefs' May 2026 study [S12].
6. **The single best asset is a no-account demo on Jon's own song, "Lucky Ticket" (GTM N2).** Every page embeds or links to it. It is the one thing a reader, a journalist or an AI answer can check for itself, and it carries no copyright risk.
7. **Comparison pages say where each competitor is the better choice.**
   - Yousician gives feedback as you play; we don't.
   - Chordify shows lyrics; we don't, and won't.
   - Moises slows songs down and runs on phones; we don't yet.
   - Each page is dated and sourced.
8. **Measurement uses free tools.** Search Console, Bing Webmaster Tools (its AI Performance report shows Copilot citations [S13]), referrer tracking for AI hosts, and a monthly 20-prompt panel across five AI engines.
9. **Six decisions for Jon** are in §8.0. The first, D-SEO-1 (open robots.txt to the AI search and user-fetch bots), blocks the AI plan.
10. **Expect slow results.** GTM puts SEO's material effect at about 33 weeks from today. The 90-day targets in §7 are about indexing, entity correctness and first citations, not revenue.

### The three niches where we can be #1

| # | Niche | Why we can be #1 | Primary benchmark today |
|---|---|---|---|
| **A** | **Chords over the stems.** A chord track running above a mixer where you mute your own part, in one browser view. | Chordify owns "chords for any song" (61% organic, about 6.5M visits a month; RESEARCH.md) but we found no stem or mute feature in its product (RESEARCH.md; re-verify before publishing). Moises has both [S18], but its pages sell a feature list, not this workflow [S19]. Yousician plays only its own 2,000+ song library [S20]. In our search probes, no result combined "chords" and "mute instrument" in one page [S23]. It is our most distinctive screen, and the home page already demonstrates it. | Chordify (chords); Moises (stems + chords) |
| **B** | **Learn it by ear, section by section.** Solo the part, loop the detected section, check the chord estimate by ear. | Today's results are generic advice articles (TrueFire, Musical U, Pickup Music) and desktop tools (Transcribe!, Capo) [S23]. None of the three primary competitors owns the by-ear method; Yousician teaches from notation-style lessons [S20]. Our honesty about chord *estimates* fits this method: "check it by ear" is the product's own line. This is also the natural next step for Yousician learners who want songs outside its library. | Yousician (learners); Transcribe!, Capo (secondary) |
| **C** | **Bass practice from the song you're learning.** Solo the bass to hear the line, mute it to play it, read the chord names above. | Bass lines are the hardest part to hear in a mix, so isolating the bass is the strongest moment of surprise (RESEARCH.md, ASSUMED). Results for bass practice queries are split between separator utilities (LALAL.AI, SoundBoost, EaseUS) and forum threads (BassBuzz, TalkBass) [S23]. Moises has instrument pages but no bass-specific method page that we found [S19][S23]. The community is smaller and reachable (r/bassguitar about 163k; RESEARCH.md). | Moises; SoundBoost, LALAL.AI (secondary) |

**Not a niche for us yet:**
- **"Slow down a song".** Tempo and pitch are "Not yet" on our own page.
- **Mobile practice.** We support Chrome on the desktop only.
- **"Vocal remover" and "stem splitter".** These are separator terms with free incumbents.
- **"Chords for [song name]" catalogues.** These carry legal risk, count as scaled content, and Chordify and Ultimate Guitar own them.

---

## 1. Positioning for search

### 1.1 What we are, and are not
- **We are** a play-along and practice tool that runs in the browser. Separation is how it works, not what it is.
- **We are not**
  - a stem separator, vocal remover or karaoke maker;
  - a sample-pack site (this is the "stem loops" collision; see 1.4);
  - a lesson app that grades you;
  - a tab or chord catalogue.

### 1.2 Entity definition

| Field | Value |
|---|---|
| Name | stem-loops: lowercase, hyphenated, always. Never "Stem Loops" or "StemLoops" in copy. In alt text, "stem-loops". |
| Type | Web application (schema.org `WebApplication`), category `MultimediaApplication`. |
| Category phrase | "play-along tool" (adjective "play-along"; the noun is "play along", per BRAND-TONE §4). |
| What it does | Opens a song in a player with six stems (drums, bass, vocals, guitar, keys, other), each with a fader, mute and solo; a chord track estimated from the audio; looping of a detected section. |
| Second product | Bar-length loops from each stem, as 24-bit WAV downloads. |
| Limits (always stated) | Chrome on the desktop; tracks up to 5 minutes; files deleted after 24 hours; an account to open the player (not to start a job); users must have the rights to the audio; chords are an estimate; no tempo or pitch change yet; no lyrics. |
| Maker | Jon Cartwright, a musician, in Canada. Jon decides how much of this to state; see D-SEO-2. |
| Home | https://stem-loops.com/ |

### 1.3 The sentence every page and every AI answer should repeat

> **stem-loops is a browser play-along tool: add a song and it opens in a player with six stems on faders, a chord track and section loops.**

(26 words. "add" covers both upload and link, per BRAND-TONE §4, so no platform is named.)

The limits sentence that always follows it on trust pages (About, How it works, Compare):

> It runs in Chrome on the desktop, takes tracks up to 5 minutes and deletes files after 24 hours.

In code, "5" comes from `MAX_TRACK_MIN`, never a literal (as `landing-copy.test.mjs` requires).

**Where it goes**
- The first paragraph of /about, /how-it-works, /glossary (under "stem-loops") and every /compare page.
- `WebApplication.description` in JSON-LD.
- The first lines of llms.txt.
- The bio on every third-party profile (§6).
- The Product Hunt tagline, cut to fit.

Use the same wording each time. Consistent phrasing is what lets an answer engine merge mentions into one entity.

### 1.4 Disambiguation (important)
"stem loops" is a generic phrase:
- sample-pack loops sold as "stem loops";
- the RNA "stem-loop" (hairpin) in biology.

Brand searches and AI answers will mix us up with both. So:
- Always write the hyphen, and pair the name with "play-along" in titles: "stem-loops: play along with any song, stem by stem" (the current home title is correct).
- The /glossary entry for "stem-loops" carries one line: "Not a sample pack, and not the RNA structure: stem-loops is a play-along tool."
- Claim the name on every profile (§6.1) so the knowledge sources agree.
- **Don't** start a Wikipedia article: we don't meet notability, and a rejected draft is worse than none. Revisit Wikidata after independent coverage exists (§9).

---

## 2. Niche and keyword map

**Demand evidence.** Verified US volumes exist only for separator and brand terms:
- vocal remover 60,500;
- stem splitter 9,900;
- stem separator 2,400;
- guitar tabs 74,000;
- songsterr 135k;
- moises 33,100;
- moises ai 9,900;
- moises app 2,400.

Sources: RESEARCH.md and [S15], Semrush, October 2026.

For the play-along clusters we have **no verified volumes**. The shell could not reach Google Autocomplete from here.

**How the plan handles that**
1. Rank clusters by *competitive evidence*. The question is whether incumbents built a dedicated page (Moises's made-for pages and SoundBoost's instrument pages [S19][S23] show that they think demand exists) and whether forum threads exist.
2. **SEO-09b:** Jon pulls Google Keyword Planner ranges for the seed list below. This is free with an Ads account and takes 20 minutes.
3. Rerank on day 30 using Search Console impressions.

| Cluster | Example queries (seed list for Keyword Planner) | Intent | Owner today (primary benchmark first) | Our angle | Target page | Evidence |
|---|---|---|---|---|---|---|
| **A1. Chords + stems** | chords and stems app; play along with chords; chord track for a song; show chords and mute guitar | Find a tool | Moises (chord detection plus separation [S18]); Chordify (chords, no stems) | Chord track over six faders in one view; the chords are an honest estimate | `/chord-track` | Moises lists Chord Detection and AI Audio Separation on web [S18]; Chordify has no stems (RESEARCH.md); no combined page in our probes [S23] |
| **A2. Chordify alternative** | chordify alternative; chordify with instruments removed; chordify vs moises | Compare | AlternativeTo lists ChordU, muted.io, Capo and others; no stem tool is listed [S21] | The alternative for people who also want their part muted | `/compare/chordify`; AlternativeTo listing | [S21] |
| **A3. Moises alternative** | moises alternative; moises vs chordify; app like moises in browser | Compare | Moises' own brand pages; listicles | Six stems on the Free plan, chords and stems in one view, no install. State honestly where Moises is better. | `/compare/moises` | Moises Free separation is two stems only (RESEARCH.md, VERIFIED 2026-11-12; re-check) |
| **B1. Learn by ear** | how to learn a song by ear; learn songs by ear guitar; work out a song by ear | Learn (how-to) | TrueFire, Musical U, Pickup Music articles; wikiHow [S23] | A method with a tool attached and a demo you can try | Guide G1 | [S23] |
| **B2. Section looping** | loop part of a song to practice; loop a section of a song; repeat the chorus to practice | Find a tool or learn | Moises Song Parts feature page; Transcribe! | A detected section repeats, with six stems and chords | `/section-loop` | moises.ai/features/song-parts exists [S23] |
| **B3. After lesson apps** | yousician alternative; learn real songs not in yousician; yousician vs moises | Compare | Review sites (guitarchalk, americansongwriter), AlternativeTo [S23] | Yousician teaches from its 2,000+ song library and listens to you play [S20]. We play the song you bring and don't grade you. | `/compare/yousician`; Guide G8 | [S20][S23] |
| **C1. Bass practice** | practice bass with bass removed; remove bass from song to practice; bass backing track from song | Find a tool | LALAL.AI guide, SoundBoost, EaseUS, Moises; BassBuzz and TalkBass threads [S23] | Solo to hear the line, mute to play it, read the chord names above | `/practice/bass` | [S23] |
| **C2. Bass by ear** | how to learn bass lines by ear; hear the bass line in a song | Learn | Forums, lesson sites | A soloed bass stem plus a section loop | Guide G2 | [S23] |
| **D1. Guitar practice (contested)** | remove guitar from song; guitar backing track from any song; mute guitar in song | Find a tool | Moises `/made-for/guitar-backing-tracks/` [S19]; SoundBoost; Yamaha Extrack [S23] | Chords above the band. Not a backing-track file: a player. | `/practice/guitar` | Heavy competition; support niche A, don't lead with D1 |
| **D2. Drums** | drumless tracks; make a drumless track; practice drums to songs | Find a tool or learn | Moises `/made-for/drumless-tracks`; Drumeo article on Moises; SoundBoost; Mutedrums app [S23] | Mute the drums and loop the section | `/practice/drums`; Guide G5 | [S23] |
| **D3. Keys** | remove piano from song; play piano along with song | Find a tool | SoundBoost; Moises [S23] | Mute the keys, with chords above | `/practice/keys` | [S23] |
| **E1. Definitions** | what is stem separation; what is a stem in music; what is bleed in stems; what is a chord track | Know | Tool vendors' wikis (soundboost.ai/wiki), LALAL.AI | Short, sourced, neutral definitions; an AIO target | `/glossary`; Guide G4 | [S23] |
| **E2. Chord accuracy** | why are chordify chords wrong; how accurate is chord detection; moises chords wrong | Know or compare | Reviews and Reddit complaints (RESEARCH.md: "auto-chords often wrong" for Chordify and Moises) | We say plainly that ours are estimates, and later publish measured accuracy (§9) | Guide G3 | RESEARCH.md user-complaint pattern |
| **E3. Rights** | is it legal to separate stems; can I use stems from a song | Know | Vendors' help pages | Plain facts, not legal advice; reviewed by counsel (GTM G3) | Guide G9 | RESEARCH.md §5 |
| **F. Bands and own recordings** | learn songs for cover band; learn my part from a rehearsal recording | Learn | Forums | Own recordings are legally clean and nobody else targets them | Guide G10 | ESTIMATE: low competition, low volume |
| **Excluded** | vocal remover; stem splitter; acapella maker; youtube to stems; slow down song; chords for "[song]" | — | vocalremover.org, Fadr, LALAL.AI, Chordify, UG | Off-position, illegal-adjacent, or not built yet | none | RESEARCH.md; GTM rule "do not market 'paste a YouTube link' in SEO" |

---

## 3. Technical SEO implementation

Every task below is written as a brief an agent can run. Shared rules for every SEO-xx code task:
- Branch from `origin/v3/main`.
- Run `pnpm --filter web test` and `next build` before you push.
- One PR per task.
- Follow AGENTS.md and BRAND-TONE v1.3.1.

### 3.0 What exists today (verified 2026-11-13)

| Item | State | Evidence |
|---|---|---|
| `metadataBase`, title template | Present | `app/layout.tsx:6-8` |
| Home title, description, canonical, OG, Twitter | Present. The description is 174 characters, over the 155 target. | `app/(landing)/page.tsx:30-42`; live `<head>` |
| JSON-LD | **None** on any page | live home: 0 `application/ld+json` |
| `robots.txt` | Present. Allows `*`, allows OAI-SearchBot and PerplexityBot with `/api/` and `/jobs/` disallowed, and blocks 10 bots, **including ChatGPT-User and ClaudeBot**. Claude-SearchBot, Claude-User and Perplexity-User are not named, so they fall under `*`. | `app/robots.ts`; `test/robots.test.mjs` |
| `sitemap.xml` | **404** | curl 2026-11-13 |
| `llms.txt` | **404** | curl 2026-11-13 |
| `www` to apex | **307** (temporary) | curl: `https://www.stem-loops.com/` → 307 |
| http to https | 308 | curl |
| noindex | `/pricing` and `/jobs/[id]` are noindex. **`/login` and `/history` are indexable.** `/account*`, `/trial` and `/success` are probably indexable too; no robots meta was found in their code. | `pricing/page.tsx:9`, `jobs/[id]/page.tsx:27`; live `/login`, `/history` |
| Canonical on `/privacy` | Present; `/terms` is unchecked | `(landing)/privacy/page.tsx:8` |
| `next.config` | Both `next.config.js` (with Sentry) and `next.config.mjs` exist. Next 14 loads the `.js` one first. | `apps/web/` |
| Analytics | **None.** No referrer data at all. | `git grep` for posthog, plausible, gtag, vercel analytics: no hits |
| Test constraint | `signed-in-nav.test.mjs` asserts exactly **3** marketing pages under `(landing)`. Every new content page must update it. | `test/signed-in-nav.test.mjs:~331` |
| Test constraint | `landing-copy.test.mjs` bans prices, plan names, "credits", social proof and literal minute figures in the landing page *and the components it imports*. | `test/landing-copy.test.mjs:316-330,365-370,372-392` |

### SEO-04: Site constants and a page registry (do this first)
**Owner:** agent. **Effort:** 1 h. **Depends on:** nothing.

**Why.** One list of public pages feeds the sitemap, llms.txt, the footer links and the tests, so nothing can drift.

**Checklist**
- [ ] Create `lib/seo/site.ts`:
  ```ts
  import { MAX_TRACK_SEC } from '@/lib/play/types';
  export const SITE_URL = 'https://stem-loops.com';
  export const SITE_NAME = 'stem-loops';
  export const MAX_TRACK_MIN = Math.floor(MAX_TRACK_SEC / 60);
  export const ENTITY_ONE_LINER =
    'stem-loops is a browser play-along tool: add a song and it opens in a player with six stems on faders, a chord track and section loops.';
  export const ENTITY_LIMITS = `It runs in Chrome on the desktop, takes tracks up to ${MAX_TRACK_MIN} minutes and deletes files after 24 hours.`;
  // Filled when each profile exists (SEO-22). Never list a profile that does not exist.
  export const SAME_AS: string[] = [];
  ```
- [ ] Create `lib/seo/pages.ts`, exporting `PUBLIC_PAGES: PublicPage[]`:
  ```ts
  export type PublicPage = {
    path: string;            // '/', '/chord-track', '/guides/learn-a-song-by-ear'
    title: string;           // <title> before the " · stem-loops" template; ≤ 60 characters with the suffix
    description: string;     // ≤ 155 characters (BRAND-TONE §5)
    section: 'home' | 'product' | 'practice' | 'compare' | 'guide' | 'trust' | 'legal';
    lastModified: string;    // ISO date, edited by hand when the copy changes
    llms: boolean;           // listed in /llms.txt
    published: boolean;      // false = built but not linked, not in the sitemap, and noindex
  };
  ```
  Seed it with the three pages that exist: `/` (home), `/privacy`, `/terms`.
- [ ] Add `test/seo-pages.test.mjs`, which checks that:
  - descriptions are ≤155 characters;
  - titles are unique;
  - paths are unique and start with `/`;
  - every published path has a `page.tsx` on disk under `app/` (resolving route groups);
  - no description contains `!`, "click", "extract", "accurate", "perfect", "studio-quality", "instantly", "unlimited" or "YouTube".

**Acceptance**
- The test is green.
- Removing a `page.tsx` that the registry lists turns it red.

### SEO-01: sitemap.xml
**Owner:** agent. **Effort:** 30 min. **Depends on:** SEO-04.

**Checklist**
- [ ] Create `app/sitemap.ts`, following the Next 14 convention [S22]:
  ```ts
  import type { MetadataRoute } from 'next';
  import { PUBLIC_PAGES } from '@/lib/seo/pages';
  import { SITE_URL } from '@/lib/seo/site';
  export default function sitemap(): MetadataRoute.Sitemap {
    return PUBLIC_PAGES.filter((p) => p.published).map((p) => ({
      url: `${SITE_URL}${p.path === '/' ? '/' : p.path}`,
      lastModified: p.lastModified,
    }));
  }
  ```
  - Omit `changeFrequency` and `priority`: Google ignores them, and leaving them out keeps the file honest.
- [ ] Never list `/login`, `/history`, `/account*`, `/trial`, `/success`, `/pricing` (until SEO-28), `/jobs/*` or `/api/*`.
- [ ] Add `test/sitemap.test.mjs`, which checks that:
  - every URL is absolute `https://stem-loops.com…`;
  - there are no duplicates;
  - none of the excluded prefixes appears;
  - the count equals the number of published registry entries.

**Acceptance**
- `curl -s https://stem-loops.com/sitemap.xml` returns 200 with `<urlset` after deploy.
- It holds three URLs today.

### SEO-02: noindex every app route
**Owner:** agent. **Effort:** 45 min. **Depends on:** nothing.

**Checklist**
- [ ] Add `robots: { index: false, follow: false }` to the `metadata` export in each of:
  - `app/login/layout.tsx` (or `login/page.tsx`; keep its title);
  - `app/history/layout.tsx` (merge with the existing `title`);
  - `app/account/layout.tsx`;
  - `app/trial/layout.tsx`;
  - `app/success/layout.tsx`.
  - These are already set: `jobs/[id]/page.tsx` and `pricing/page.tsx` (leave pricing until SEO-28).
- [ ] **Don't** add these paths to robots.txt `Disallow`. Google must be able to crawl a page to see its noindex.
- [ ] Add `test/noindex-app-routes.test.mjs`, which imports each module's `metadata` and asserts `robots.index === false`.

**Acceptance**
- `curl -s https://stem-loops.com/login | grep -o '<meta name="robots"[^>]*>'` prints `noindex, nofollow`.
- The same holds for `/history`, `/account` (after its redirect), `/trial` and `/success`.

### SEO-03: robots.txt for AI search and user fetchers
**Owner:** Jon decides D-SEO-1, then an agent implements. **Effort:** 30 min. **Depends on:** D-SEO-1.

**Background**
- SL15 (Jon, 2026-10-31) allowed AI *search* bots and blocked *training* bots. The current list predates two changes.
- **Claude-SearchBot.** Anthropic now documents three bots [S10]:
  - ClaudeBot, for training;
  - Claude-User, which fetches when a person asks Claude;
  - Claude-SearchBot, which indexes for search.
  - Claude-SearchBot is a search bot under SL15's own rule, so allowing it is consistent with SL15.
- **User-initiated fetchers.** These are ChatGPT-User [S9], Claude-User [S10] and Perplexity-User [S11]. They fetch a page only when a person asks about it. They don't train models. OpenAI and Perplexity both say robots.txt "may not apply" or is "generally" ignored for them [S9][S11].
  - Blocking ChatGPT-User today buys almost nothing.
  - It does tell ChatGPT that a user's request for our page should fail.
- **Google-Extended** controls Gemini training and grounding in Gemini Apps and Vertex AI. It does **not** control AI Overviews or AI Mode [S8][S2], so keeping it blocked costs us nothing in Google Search.

**Recommendation (D-SEO-1)**
- Allow Claude-SearchBot.
- Allow ChatGPT-User, Claude-User and Perplexity-User on public pages, with `/api/` and `/jobs/` disallowed.
- Keep these blocked site-wide: GPTBot, ClaudeBot, anthropic-ai, CCBot, Google-Extended, Bytespider, Amazonbot, Applebot-Extended, meta-externalagent.

**Checklist** (only after Jon says yes)
- [ ] In `app/robots.ts`:
  ```ts
  export const SEARCH_BOT_USER_AGENTS = ['OAI-SearchBot', 'PerplexityBot', 'Claude-SearchBot'];
  // User-initiated fetchers: a person asked an assistant about a page. Not training, not bulk crawling.
  export const USER_FETCH_AGENTS = ['ChatGPT-User', 'Claude-User', 'Perplexity-User'];
  export const BLOCKED_AI_USER_AGENTS = ['GPTBot', 'ClaudeBot', 'anthropic-ai', 'CCBot', 'Google-Extended',
    'Bytespider', 'Amazonbot', 'Applebot-Extended', 'meta-externalagent'];
  export const SEARCH_BOT_DISALLOW = ['/api/', '/jobs/'];
  // rules: '*' unchanged; SEARCH + USER_FETCH each { allow: '/', disallow: SEARCH_BOT_DISALLOW }; BLOCKED { disallow: '/' }
  ```
  - Update the header comment with D-SEO-1's date and wording.
- [ ] Update `test/robots.test.mjs`:
  - add the `USER_FETCH` loop, with the same assertions as `SEARCH`;
  - add `Claude-SearchBot` to `SEARCH`;
  - remove `ChatGPT-User` from `BLOCKED`;
  - keep the wildcard test exactly as it is.
- [ ] Add `Sitemap: https://stem-loops.com/sitemap.xml` by returning `sitemap` from `robots()`. Next supports `{ rules, sitemap }`. Extend the test to assert it.

**Acceptance**
- Live `/robots.txt` lists `Sitemap:`, three search bots, three user fetchers and nine blocked bots.
- The test is green.

**Cost guard.** This is the KIDS FUN lesson in the `robots.ts` header. Every public content page is static (○ in `next build`). If a content page builds as ƒ, the PR fails review. Jon keeps the Vercel spend alert on.

### SEO-06: metadata fixes
**Owner:** agent. **Effort:** 1 h. **Depends on:** SEO-04.

**Checklist**
- [ ] **Home description** (`app/(landing)/page.tsx`). Replace it with a version of at most 155 characters, built from the binding:
  ```ts
  description: `Six stems with faders, mute and solo, a chord track and section loops. Play along in Chrome on the desktop. Tracks up to ${MAX_TRACK_MIN} minutes.`,
  ```
  - That is 131 characters. It keeps `MAX_TRACK_MIN`, as `landing-copy.test.mjs` requires. It closes the follow-up recorded in BRAND-TONE §6.
- [ ] **Root defaults** (`app/layout.tsx`). Add these, so pages that don't set their own still produce a sane card:
  ```ts
  openGraph: { siteName: 'stem-loops', type: 'website', locale: 'en_CA', images: [{ url: '/og-image-v4.png', width: 1200, height: 630 }] },
  twitter: { card: 'summary_large_image' },
  ```
  - Keep the root `description`. It is the fallback, and it already states the limits.
- [ ] **Helper** `lib/seo/meta.ts`:
  ```ts
  export function pageMetadata(p: PublicPage): Metadata {
    return {
      title: p.title,
      description: p.description,
      alternates: { canonical: p.path },
      openGraph: { title: p.title, description: p.description, url: p.path, type: p.section === 'guide' ? 'article' : 'website' },
      twitter: { title: p.title, description: p.description },
      ...(p.published ? {} : { robots: { index: false, follow: false } }),
    };
  }
  ```
  - Every new content page calls this. Nothing hand-writes metadata.
- [ ] Check `/terms`. If `alternates.canonical: '/terms'` is missing, add it. Legal meta tests pin these files, so run `legal-terms-copy.test.mjs`.
- [ ] **Canonical policy**
  - Self-referencing canonical on every public page.
  - Query strings (`?ref=`, `utm_*`) are never canonical.
  - No trailing slash except on the root.

**Acceptance**
- View-source on `/` shows the new description.
- `/privacy` and `/terms` show canonicals.
- The landing tests are green.

### SEO-05: JSON-LD structured data
**Owner:** agent. **Effort:** 1.5 h. **Depends on:** SEO-04. Jon approves the `Person` block (D-SEO-2).

**What schema can and can't do here**
- Google says structured data is **not** required for AI features [S1].
- `SoftwareApplication` and `WebApplication` rich results **require** `aggregateRating` or `review` [S5]. We have neither, and we will **never** invent them; production has zero registered users, and the landing test bans social proof. So the markup will not produce a rich result.
- We add it for entity clarity: name, type, maker, limits and price in one machine-readable place.
- **FAQPage.** FAQ rich results stopped appearing in Google on 2026-05-07 [S6]. The markup is harmless, and other engines may read it [S6]. We mark up only FAQs that are visible on the page.
- **HowTo.** HowTo rich results were cut back in 2023 [S7]. Don't use HowTo. Write steps as an ordered list.

**Checklist**
- [ ] `components/seo/JsonLd.tsx` (server component):
  ```tsx
  export function JsonLd({ data }: { data: object }) {
    // Escape '<' so a string can never close the script tag.
    const json = JSON.stringify(data).replace(/</g, '\\u003c');
    return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
  }
  ```
  - The CSP is unaffected: a JSON-LD script is not executed.
- [ ] `lib/seo/jsonld.ts`, exporting `homeGraph()`, `articleGraph(page, opts)`, `breadcrumbs(items)` and `glossaryGraph(terms)`. Keep it a lib module, not landing-page source, so the landing copy scanner doesn't read schema strings as copy. Still run `landing-copy.test.mjs`.
- [ ] **Home**: render `<JsonLd data={homeGraph()} />` once in `app/(landing)/page.tsx`:
  ```json
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "https://stem-loops.com/#org",
        "name": "stem-loops",
        "url": "https://stem-loops.com/",
        "logo": { "@type": "ImageObject", "url": "https://stem-loops.com/apple-touch-icon.png" },
        "founder": { "@id": "https://stem-loops.com/about#jon" },
        "sameAs": []
      },
      {
        "@type": "Person",
        "@id": "https://stem-loops.com/about#jon",
        "name": "Jon Cartwright",
        "url": "https://stem-loops.com/about",
        "jobTitle": "Musician and maker of stem-loops"
      },
      {
        "@type": "WebSite",
        "@id": "https://stem-loops.com/#website",
        "url": "https://stem-loops.com/",
        "name": "stem-loops",
        "inLanguage": "en",
        "publisher": { "@id": "https://stem-loops.com/#org" }
      },
      {
        "@type": "WebApplication",
        "@id": "https://stem-loops.com/#app",
        "name": "stem-loops",
        "url": "https://stem-loops.com/",
        "description": "stem-loops is a browser play-along tool: add a song and it opens in a player with six stems on faders, a chord track and section loops.",
        "applicationCategory": "MultimediaApplication",
        "applicationSubCategory": "Music practice",
        "operatingSystem": "Windows, macOS, ChromeOS, Linux (desktop)",
        "browserRequirements": "Requires Google Chrome on a desktop or laptop computer.",
        "inLanguage": "en",
        "isAccessibleForFree": true,
        "featureList": [
          "Six stems: drums, bass, vocals, guitar, keys and other",
          "A fader, mute and solo on every stem",
          "A chord track estimated from the audio",
          "Looping of a detected section",
          "Bar-length loops from each stem as 24-bit WAV files",
          "Tracks up to 5 minutes",
          "Files deleted after 24 hours"
        ],
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CAD", "category": "free" },
        "image": "https://stem-loops.com/og-image-v4.png",
        "publisher": { "@id": "https://stem-loops.com/#org" },
        "creator": { "@id": "https://stem-loops.com/about#jon" }
      }
    ]
  }
  ```
  - "Tracks up to 5 minutes" is built from `MAX_TRACK_MIN`.
  - `offers` carries the Free plan only. Paid offers are added in SEO-28, after Stripe goes live; the "no payment at launch" pin applies until then.
  - Drop the `Person` node and `founder`/`creator` if Jon says no to D-SEO-2.
  - `sameAs` stays empty until profiles exist.
- [ ] **Home FAQPage (optional).** Mirror the visible questions verbatim, **except** "Does it work with YouTube links?". Marking that one up would headline a platform in machine-readable form, against the brand truth rule.
- [ ] **Guides**: an `Article` node:
  ```json
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": "https://stem-loops.com/guides/learn-a-song-by-ear#article",
        "headline": "How to learn a song by ear, part by part",
        "description": "…registry description…",
        "author": { "@id": "https://stem-loops.com/about#jon" },
        "publisher": { "@id": "https://stem-loops.com/#org" },
        "datePublished": "2026-12-01",
        "dateModified": "2026-12-01",
        "mainEntityOfPage": "https://stem-loops.com/guides/learn-a-song-by-ear",
        "inLanguage": "en",
        "about": { "@id": "https://stem-loops.com/#app" }
      },
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://stem-loops.com/" },
          { "@type": "ListItem", "position": 2, "name": "Guides", "item": "https://stem-loops.com/guides" },
          { "@type": "ListItem", "position": 3, "name": "How to learn a song by ear, part by part" }
        ]
      }
    ]
  }
  ```
- [ ] **Glossary**: `DefinedTermSet` with one `DefinedTerm` per entry (`name`, `description`, `url` = `/glossary#term-slug`).
- [ ] **Compare pages**: `WebPage` plus `BreadcrumbList` only. **No** `Review`, `Rating`, `ItemList` with scores, or `Product` for competitors.
- [ ] **Tests** in `test/jsonld.test.mjs`:
  - the home HTML contains exactly one `application/ld+json`;
  - it parses;
  - `WebApplication.description === ENTITY_ONE_LINER`;
  - the "5 minutes" in `featureList` equals `MAX_TRACK_MIN`;
  - it has **no** `aggregateRating`, `review` or `ratingValue` keys anywhere;
  - the FAQ schema, if present, contains no "YouTube".

**Acceptance**
- The Rich Results Test and the Schema Markup Validator (validator.schema.org) show no errors for `/`. "No rich result detected" is expected and correct.

### SEO-07: llms.txt
**Owner:** agent. **Effort:** 45 min. **Depends on:** SEO-04.

**Expectations.** Google ignores llms.txt [S1]. Ahrefs found 97% of llms.txt files got no requests in May 2026; when they were fetched, GPTBot and Claude Code were the main AI requesters [S12]. We build it because it is cheap, it is derived (it cannot drift), and coding agents and assistants do read it.

**Checklist**
- [ ] Create `app/llms.txt/route.ts` with `export const dynamic = 'force-static'` and a `GET` that returns `text/plain; charset=utf-8`:
  ```
  # stem-loops

  > stem-loops is a browser play-along tool: add a song and it opens in a player with six stems on faders, a chord track and section loops.

  It runs in Chrome on the desktop, takes tracks up to 5 minutes and deletes files after 24 hours. The six stems are drums, bass, vocals, guitar, keys and other; each has a fader, mute and solo. The chord track is an estimate made from the audio, not a transcription. Tempo and pitch change are not available yet. There are no lyrics. An account is needed to open the player, not to start a job. Users must have the rights to the audio they add. Bar-length loops from each stem can be downloaded as 24-bit WAV files.

  stem-loops is not a sample pack and not the RNA stem-loop structure.

  ## Pages
  - [How stem-loops works](https://stem-loops.com/how-it-works): the pipeline, measured timings and the limits
  - [Chord track](https://stem-loops.com/chord-track): chords over six stems, and how good the estimate is
  …one line per published page with llms: true…

  ## Compare
  - [stem-loops and Moises](https://stem-loops.com/compare/moises): …
  ```
  - Build the body from `ENTITY_ONE_LINER`, `ENTITY_LIMITS` and `PUBLIC_PAGES.filter(p => p.published && p.llms)`.
  - Use no literal minute figure.
- [ ] Test: the route returns text that starts with `# stem-loops`, contains `ENTITY_ONE_LINER` and has one line per published llms page.

**Acceptance.** `curl -s https://stem-loops.com/llms.txt` returns 200, `content-type: text/plain`.

### SEO-08: permanent www redirect
**Owner:** Jon (Vercel dashboard). **Effort:** 5 min.
- [ ] Vercel → Project → Settings → Domains → `www.stem-loops.com` → redirect to `stem-loops.com` with **308 Permanent**. It is 307 today.

**Acceptance.** `curl -sI https://www.stem-loops.com/` shows `308`.

### SEO-09: Search Console, Bing Webmaster Tools, IndexNow
**Owner:** Jon (accounts and DNS), with an agent preparing. **Effort:** 30 min for Jon.
- [ ] **Google Search Console.** Add a **Domain property** for `stem-loops.com` (DNS TXT at the registrar or in Vercel DNS). Submit `https://stem-loops.com/sitemap.xml`. Inspect `/` and request indexing.
- [ ] **Bing Webmaster Tools.** Import from GSC. Submit the sitemap. Turn on the **AI Performance** report (public preview since February 2026: citations, cited pages, grounding queries for Copilot [S13]).
- [ ] **IndexNow (optional, agent, 30 min).**
  - Put a key file at `public/<key>.txt`.
  - Add a tiny post-deploy script, `scripts/indexnow.mjs`, that POSTs changed registry URLs to `api.indexnow.org`.
  - Bing uses IndexNow and Google does not [S14]. Whether it speeds up ChatGPT citations is **not confirmed** [S14].
- [ ] **SEO-09b, Keyword Planner.** Jon pulls monthly ranges for the seed queries in §2 (US, CA, UK, AU) and pastes them into `overnight/SEO/keywords-YYYY-MM-DD.csv`.

**Acceptance.** Both consoles show the property verified and the sitemap "Success".

### SEO-10: performance budgets
**Owner:** agent. **Effort:** 1 h. **Depends on:** SEO-12 for content pages.

**Targets** (Google's "good" thresholds at the 75th percentile [S24]):

| Metric | Budget |
|---|---|
| LCP | ≤ 2.5 s |
| INP | ≤ 200 ms |
| CLS | ≤ 0.1 |

At our traffic, field data (CrUX) won't exist for months, so we hold lab budgets.

| Page type | Lab budget (Lighthouse mobile, Moto G Power profile) |
|---|---|
| Content pages (guides, compare, glossary, practice, about) | LCP ≤ 2.0 s, TBT ≤ 150 ms, CLS ≤ 0.05; **first-party client JS for the route ≤ 50 KB gzipped** (no client islands except the demo player link); HTML ≤ 60 KB |
| Home | Record a baseline now: the HTML is 70 KB, with 11 script tags. Don't regress it by more than 10%. |

**Checklist**
- [ ] Content pages are **server components**. No `'use client'` imports, except an optional `DemoLink`.
- [ ] Content pages are **static** (○ in `next build` output).
- [ ] Add `test/content-pages-static.test.mjs`. It scans `app/(landing)/**/page.tsx` for new content routes and fails if one exports `dynamic = 'force-dynamic'` or imports a module that starts with `'use client'`, other than the allowlist.
- [ ] Images: use `next/image` with explicit `width` and `height`, AVIF or WebP, and alt text that says "Illustration:" for anything that isn't a screenshot of real output (brand truth rule).
- [ ] Fonts: reuse the self-hosted JetBrains Mono already in `(landing)/layout.tsx`. Add no new web fonts.
- [ ] Record the Lighthouse scores for `/` and one guide in the PR description.

**Acceptance.** Every content page builds as ○, and the Lighthouse numbers in the PR meet the table.

### Internationalisation: no, for now
**Decision: English only. No hreflang.** Revisit at day 90.

**Reasons**
- The copy rules are Canadian English and the product UI is English-only.
- Chord naming differs by language (German H for B, solfège in Romance languages), so a translated chord page is a product change, not a translation.
- Machine-translating 25 pages invites the scaled-content flag [S4] and doubles Jon's review load.
- The GTM ICP is English-speaking hobby guitarists (RESEARCH.md).

**Revisit trigger.** At day 90, if GSC shows ≥20% of impressions from one non-English market. Portuguese (Brazil) and Spanish are the likely first candidates; Moises is partly Brazilian (RESEARCH.md). Then do one hand-written page set, not a translation of the whole site.

Keep `<html lang="en">`. `en-CA` is fine too, but it gains nothing in search.

### Indexability rules (summary for agents)

| Route | Index? | In sitemap? | In robots Disallow? |
|---|---|---|---|
| `/`, `/privacy`, `/terms`, all registry pages with `published: true` | yes | yes | no |
| `/pricing` | **no** until SEO-28 (pinned "no payment at launch") | no | no |
| `/login`, `/history`, `/account/*`, `/trial`, `/success` | no (meta noindex) | no | no (Google must see the noindex) |
| `/jobs/*` | no (redirects signed-out visitors to `/login`; noindex on the page) | no | yes, for the named AI bots (existing) |
| `/api/*` | n/a | no | yes, for the named AI bots (existing) |
| `/sitemap.xml`, `/robots.txt`, `/llms.txt` | n/a | no | no |

---

## 4. Content plan

### 4.0 Rules for every page (copy these into each agent brief)
1. **Voice:** BRAND-TONE v1.3.1.
   - Canadian English: "practise" is the verb and "practice" the noun; "colour"; "-ize".
   - Sentence case. No exclamation marks.
   - At most one em dash per paragraph.
   - Spell out one to nine; use digits with units and a non-breaking space ("5 minutes", "24-bit WAV", "102 BPM").
   - Banned words: "accurate", "perfect", "clean", "studio-quality", "powerful", "amazing", "instantly", "unlimited", "extract", "convert", "click", "hover".
   - Say "estimate" with "chords" on first mention.
2. **Truth:**
   - Name the limits on every product page, once: Chrome desktop, 5 minutes (from `MAX_TRACK_MIN`), 24-hour deletion, account to play, rights to the audio.
   - Say "not yet" for tempo and pitch, and "no" for lyrics.
   - Never promise downbeat-aligned loops.
   - Use measured timings only: "a 3:34 example took about 1–3 minutes".
3. **Platforms:** never headline one. Inputs are described as "add a song: upload an audio or video file, or paste a link". **No "YouTube" in any title, H1, H2, meta, URL or schema.** This follows the brand rule and the GTM legal finding.
4. **Songs:**
   - **Never name a commercial song or artist** in a title, URL, H1, screenshot or example.
   - The worked example is always "Lucky Ticket" by Jon Cartwright (3:34, 102 BPM, G minor estimate), or a clearly labelled illustration.
5. **E-E-A-T:**
   - Every guide carries a byline (Jon, subject to D-SEO-2), a "Last checked" date, and a short "How this was made" line: "Drafted with an AI assistant from our own product notes; checked and edited by Jon Cartwright." Google recommends disclosure where readers would wonder [S3].
   - Every factual claim about a competitor carries a source link and a check date.
6. **Answer first.** Each page's first paragraph answers its target query in two or three sentences that can be quoted alone. Each H2 is a plain question or label, followed by a direct answer.
7. **Internal links:**
   - every page links to `/` (the tool), to `/demo` once it exists, to its niche pillar, and to one or two related pages;
   - one link to `/how-it-works`, where the limits live;
   - anchor text is descriptive ("chord track", "mute the bass"), never "click here".
8. **Calls to action:**
   - The primary action is "Paste a song" (the landing label) or "Try the demo". Buttons are 1–5 words.
   - **No prices, plan names or credits** on content pages until Stripe goes live (G5), to keep the landing's "no payment at launch" pin consistent.
   - Competitor prices may appear on compare pages only, with source and date.
9. **Length:** as long as the answer needs. Google says there is no ideal length [S1]. Guides are typically 900–1,600 words; use-case pages 400–800.
10. **Build:** content lives in typed TS modules (`content/*.ts`) rendered by one template (SEO-12). No MDX dependency and no CMS.

### 4.1 Site map: 25 content pages (the GTM A1 cap)

| # | Path | Type | Niche | Phase |
|---|---|---|---|---|
| 1 | `/demo` | Demo: Lucky Ticket in the player, no account | all | 2 (needs N2) |
| 2 | `/chord-track` | Pillar | A | 1 |
| 3 | `/section-loop` | Pillar | B | 2 |
| 4 | `/practice/bass` | Use case | C | 2 |
| 5 | `/practice/guitar` | Use case | A/D | 2 |
| 6 | `/practice/drums` | Use case | D | 2 |
| 7 | `/practice/keys` | Use case | D | 2 |
| 8 | `/how-it-works` | Trust | entity | 1 |
| 9 | `/about` | Trust | entity | 1 |
| 10 | `/glossary` | Definitions | E | 1 |
| 11 | `/compare` | Compare hub | A/B | 1 |
| 12 | `/compare/moises` | Compare | A | 1 |
| 13 | `/compare/chordify` | Compare | A | 1 |
| 14 | `/compare/yousician` | Compare | B | 1 |
| 15 | `/guides` | Guide index | — | 2 |
| 16–25 | `/guides/…` ×10 | Guides G1–G10 | A/B/C/E | 2–3 |

Backlog, not built:
- `/practice/vocals` (off-ICP; vocal-remover territory);
- `/teachers` (build only if A8 teacher seeding shows ≥5 signups per teacher);
- per-competitor pages for the secondary set.

**Footer change (SEO-12):** add a second `<nav aria-label="Learn">` to `SiteFooter` with How it works, Chord track, Practice (to `/practice/bass` until a hub exists), Compare, Guides, Glossary and About. **Don't** add a pricing link; the landing test allows exactly one.

### 4.2 Page specs

Titles are shown before the template appends " · stem-loops". H1s are ≤6 words (BRAND-TONE §5).

#### `/chord-track` (Niche A pillar)
- **Title:** "Chord track over six stems, for playing along"
- **Meta (127 characters):** "A chord track over six stems. Mute your part, read the chords, loop the section. The chords are an estimate: check them by ear."
- **H1:** "Chords over the stems"
- **Outline**
  1. Answer first: what you see. Chord names run in time across the top, and six stems on faders sit underneath. Mute your part and play it with the chords in view.
  2. H2 "What the chord track shows": names such as Gm and E♭, in time with the song.
  3. H2 "How good are the chords?" Use the landing FAQ wording: an estimate, where it slips, trust your ears. Link to Guide G3.
  4. H2 "Mute your part, keep the chords": the guitar, bass and keys workflows, each linking to its practice page.
  5. H2 "Loop the section you are learning": link to `/section-loop`.
  6. H2 "Where it runs, and the limits": one block.
  7. H2 "Compared with chords-only tools": two sentences. Chordify shows chords for a song; we show chords over six stems you can mute. Link to `/compare/chordify`.
  8. FAQ (4):
     - "Can I edit a wrong chord?" (Answer truthfully from the current product state; `api/chord-edits` exists, so check what users can do before writing.)
     - "Does it show lyrics?" No.
     - "Can I change the key?" Not yet.
     - "Which instruments does it work for?"
- **Links:** `/`, `/demo`, `/practice/guitar`, `/practice/bass`, `/section-loop`, `/compare/chordify`, `/glossary#chord-track`, G3.
- **Schema:** WebPage, BreadcrumbList, FAQPage (visible questions only).

#### `/section-loop` (Niche B pillar)
- **Title:** "Loop a section of a song to practise it"
- **Meta (121 characters):** "Pick a detected section, such as a verse or a chorus, and it repeats until you have it. With six stems and a chord track."
- **H1:** "Loop the chorus until it sticks"
- **Outline**
  1. Answer first.
  2. H2 "How sections are found": detected from the audio; may not match how you'd mark them.
  3. H2 "Looping with your part muted".
  4. H2 "What it does not do". It doesn't stretch time yet (no slow-down). Loops follow detected sections; there is no free selection unless one has shipped (check the code before writing). It doesn't guarantee a start on the downbeat.
  5. H2 "A practice routine": link to G7.
  6. FAQ (3).
- **Links:** `/chord-track`, G1, G6, G7.

#### `/practice/bass` (Niche C)
- **Title:** "Practise bass with the bass muted, chords above"
- **Meta (131 characters):** "Solo the bass to hear the line, then mute it and play it yourself, with the chord roots above. Six stems, in Chrome on the desktop."
- **H1:** "Mute the bass. Play it yourself."
- **Outline**
  1. Answer first.
  2. H2 "Hear the line first": solo the bass stem; low notes and bleed from the kick drum (be honest).
  3. H2 "Then play it": mute the bass and keep drums and keys.
  4. H2 "Use the chords for roots": what a chord name tells a bassist, and what it doesn't (inversions, passing notes).
  5. H2 "Loop the hard bar".
  6. H2 "Limits".
  7. FAQ (4):
     - "Will the bass stem be clean?" Not perfect; dense mixes bleed.
     - "Can I slow it down?" Not yet.
     - "Can I download the bass stem?" State the truth per plan at publish time, or say "not covered here".
     - "Does it work on a phone?" No.
- **Links:** G2, `/chord-track`, `/section-loop`, `/glossary#bleed`.

#### `/practice/guitar`, `/practice/drums`, `/practice/keys`
Same template as `/practice/bass`:

| Path | H1 | Instrument note |
|---|---|---|
| `/practice/guitar` | "Mute the guitar. Play it yourself." | The guitar stem may carry other mid-range parts. Lead and rhythm are **not** separated; say so, because Moises Pro does this [S19]. |
| `/practice/drums` | "Mute the drums. Keep the band." | Focus on drumless practice. No chords emphasis; link G5. |
| `/practice/keys` | "Mute the keys. Play the part." | Piano and synth parts share the keys stem; the chord track helps with voicings. |

Each page has a unique answer-first paragraph, a unique FAQ, and one instrument-specific limit. **No two pages may share more than one paragraph** (enforced by review, not by test).

#### `/how-it-works` (entity and trust)
- **Title:** "How stem-loops works, and its limits"
- **H1:** "How stem-loops works"
- **Outline**
  1. Entity sentence and limits sentence.
  2. H2 "From song to player": add, separate (Demucs htdemucs_6s on Replicate, as the landing states), chord estimate, player.
  3. H2 "How long it takes": the measured 3:34 example.
  4. H2 "What happens to your files": 24 hours; link `/privacy`.
  5. H2 "What it does not do yet": the landing spec rows verbatim.
  6. H2 "Your rights to the audio".
  7. H2 "Changes": a dated changelog of user-visible changes (see §9, idea 6).
- **Schema:** WebPage, BreadcrumbList.

#### `/about`
- **Title:** "About stem-loops and who makes it"
- **H1:** "Who makes stem-loops"
- **Content.** Jon in first person: a musician who built the tool he wanted for learning songs; Lucky Ticket; why the limits are stated; how to contact.
- Avoid invented credentials. Every fact comes from Jon (D-SEO-2).
- **Schema:** AboutPage, plus the `Person` node with `@id …/about#jon` and `sameAs` to Jon's real public profiles (his choice).

#### `/glossary`
- **Title:** "Play-along and stem terms, defined"
- **H1:** "Play-along terms, defined"
- **Entries:** 18–25 anchored definitions, each 1–3 sentences, first sentence standalone. Each anchor is `id="term-<slug>"`. Each entry links to the page that goes deeper.
  - stem
  - stem separation
  - bleed
  - six-stem split
  - fader
  - mute
  - solo
  - chord track
  - chord estimate (vs transcription)
  - section
  - section loop
  - bar
  - BPM
  - key estimate
  - play along
  - backing track
  - drumless track
  - minus-one track
  - 24-bit WAV
  - loop (as file)
  - "stem-loops" (the disambiguation line, §1.4)
- **Schema:** DefinedTermSet.

#### Compare pages (honest by construction)
Fixed template for `/compare/moises`, `/compare/chordify` and `/compare/yousician`:

1. **Title:** "stem-loops and [X]: an honest comparison". **H1:** "stem-loops and [X]".
2. **Answer first** in three sentences, in the form: "Use [X] if … Use stem-loops if … Many musicians use both."
3. **"Checked on" date** and a note: "We make stem-loops. Corrections welcome at [email]; we update this page within a week."
4. **Side-by-side table, with facts only.** Rows:
   - what it is;
   - platforms;
   - what you can play along to (any song you add, or a library);
   - stems;
   - chords;
   - section looping;
   - tempo and pitch;
   - lyrics;
   - feedback on your playing;
   - free tier;
   - track length limit;
   - file retention.
   Each competitor cell links to its source.
5. H2 "Where [X] is the better choice". At least three real points.
6. H2 "Where stem-loops is the better choice". At most three points, each verifiable on `/demo`.
7. H2 "Using both".
8. FAQ (3).

**Starting facts.** Re-verify every one on publish day.

| | Moises | Chordify | Yousician |
|---|---|---|---|
| What it is | Stems, chords, sections, speed and key changer, on web, desktop and mobile [S18] | Chords for songs, on web, iOS and Android (RESEARCH.md); lyrics with chords, live chord detection [S23: musicradar] | Lessons and songs for guitar, bass, ukulele, piano and singing; listens to you play and gives real-time feedback [S20] |
| Library or any song | Any song you upload | Any song (catalogue plus your own) | Its own library: "2000+" songs, "9000+" lessons [S20] |
| Free tier | 5 uploads a month; free separation is vocals and instrumental only (RESEARCH.md, VERIFIED 2026-11-12) | Limited practice (anecdotal; don't state without a fresh source) | Don't state without a fresh source |
| Where it is better than us (minimum list) | Slow down and change key; phones; lead and rhythm guitar split (Pro) [S19]; longer tracks | Lyrics; mobile apps; very large song catalogue; transpose | Feedback on your playing; structured lessons; mobile; five instruments |
| Where we are better (only if true on publish day) | Six stems on the Free plan; chords and stems in one browser view with no install | Mute or solo any of six stems under the chords | Any song you bring, not a library; the song's own recording |

`/compare` hub:
- **H1:** "stem-loops and the alternatives".
- **Content:**
  - one table covering the three primary competitors plus the secondary set in one line each (Songsterr: synced tabs with mute and solo of transcribed tracks; Ultimate Guitar: tab catalogue; LALAL.AI and Fadr: separators; Capo and Transcribe!: desktop and Apple tools for working out songs by ear);
  - links to the three primary pages.
- Secondary-set facts come from RESEARCH.md, dated.

**Comparison-page legal rules** (see §10):
- nominative use of names only; no logos;
- no screenshots of competitor UIs;
- no "best" or "better than" in titles;
- every claim sourced and dated;
- re-checked quarterly (SEO-27).

### 4.3 Guide briefs (10)

Shared for all guides:
- **Schema:** Article plus BreadcrumbList, plus FAQPage mirroring the visible FAQ.
- **Byline:** Jon (D-SEO-2).
- **Example:** Lucky Ticket.
- **Links:** the pillar for its niche and `/demo`.
- **Path:** `/guides/<slug>`.

**G1. How to learn a song by ear, part by part** (`learn-a-song-by-ear`). Niche B.
- **Target:** "how to learn a song by ear". **Secondary:** "learn songs by ear guitar"; "work out a song by ear".
- **Outline**
  1. Answer first: a five-step method.
  2. Listen through and mark the sections.
  3. Find the key centre (with the key estimate as a hint, not an answer).
  4. Solo the part.
  5. Loop one section.
  6. Check the chord estimate against what you hear.
  7. Mute the part and play it with the band.
  8. Common traps: bleed, octave errors, inversions.
- **FAQ**
  - "How long does it take to learn a song by ear?" No single number; it depends on the song and on you.
  - "Do I need perfect pitch?" No.
  - "Should I trust automatic chords?" As a starting point; check by ear.

**G2. How to work out a bass line by ear** (`bass-line-by-ear`). Niche C.
- **Target:** "how to learn bass lines by ear".
- **Outline**
  1. Why bass is hard to hear in a mix.
  2. Solo the bass stem.
  3. Find the roots from the chord names.
  4. Fill in passing notes.
  5. Loop the bar.
  6. Mute and play.
  7. Kick-drum bleed and low-end limits.
- **FAQ**
  - "Why can't I hear the bass on my laptop speakers?" Use headphones.
  - "Is the root always the chord name?" No: inversions and pedal notes.

**G3. Why chord detection gets chords wrong, and how to check by ear** (`chord-detection-accuracy`). Niche E. Benchmarks: Chordify, Moises.
- **Target:** "how accurate is chord detection". **Secondary:** "chordify wrong chords", "moises chords wrong".
- **Outline**
  1. Answer first: detection makes estimates from mixed audio. It struggles with dense voicings, altered chords, inversions and quiet passages.
  2. What "estimate, not transcription" means.
  3. Five ways to check a chord by ear.
  4. What we do about it: the estimate label, and later the published accuracy page (§9, idea 1).
  5. Every tool has this limit, ours included. No competitor-bashing.
- **FAQ:** "Which chord app is the most accurate?" Answer honestly: we have no independent benchmark across tools, and will publish our own numbers and method.

**G4. What stem separation is, and what bleed means** (`what-is-stem-separation`). Niche E.
- **Target:** "what is stem separation". **Secondary:** "what is a stem in music", "stem bleed".
- **Outline**
  1. Definition.
  2. How six-stem models split (Demucs, plainly).
  3. What bleed sounds like.
  4. Why stems help practice, not just remixing.
  5. Separation is not the same as the rights to the stems: link G9.
- **FAQ:** "Is stem separation lossless?" "Why is there guitar in my keys stem?"

**G5. How to practise drums with a drumless track** (`drumless-practice`). Niche D.
- **Target:** "drumless tracks practice".
- **Outline**
  1. Why drumless practice works.
  2. Mute the drums; keep a click if you need one (we have no metronome; say so).
  3. Loop the section.
  4. Listen back to the drum stem solo to check the part.
  5. Limits.
- **FAQ:** "Can I download a drumless track?" State the truth per plan at publish time.

**G6. How to loop a section of a song to practise it** (`loop-a-section`). Niche B.
- **Target:** "how to loop part of a song".
- **Outline**
  1. Why section loops beat replaying the whole song.
  2. Loop length (bars).
  3. Detected sections and their limits.
  4. Combine with mute.
  5. When to move on.

**G7. A 20-minute play-along routine** (`play-along-routine`). Niche B, Yousician audience.
- **Target:** "how to practice guitar with songs".
- **Outline:** a timed routine, starting with 5 min soloed listening and ending with full play-along. Adapt it per instrument.

**G8. From lesson apps to real songs** (`from-lesson-apps-to-songs`). Niche B. Benchmark: Yousician.
- **Target:** "yousician real songs", "what to do after yousician".
- **Outline**
  1. What lesson apps do well: feedback, structure [S20].
  2. Where they stop: a fixed library.
  3. How to learn a song that isn't in the app.
  4. Using both.
- **Rule:** no disparagement. Yousician's strengths are named first.

**G9. Splitting songs and copyright: what musicians should know** (`stems-and-copyright`). Niche E.
- **Target:** "is it legal to separate stems from a song".
- **Gate:** counsel review (GTM G3). **Not published before the review.**
- **Outline**
  1. Not legal advice.
  2. Splitting doesn't change who owns the song.
  3. Private practice vs sharing vs releasing.
  4. Canada's private-copying exception and its conditions (s.29.22, as in RESEARCH.md).
  5. What our terms say.
  6. Use your own recordings when you can: link G10.

**G10. Learn your part from a band rehearsal recording** (`learn-from-rehearsal-recording`). Niche F.
- **Target:** "learn my part from a rehearsal recording", "cover band learn songs".
- **Outline**
  1. Record the rehearsal.
  2. Add it.
  3. Each member mutes their own part.
  4. Loop the bridge you keep missing.
  5. Rights are simple when it's your band's recording.
  6. Limits: 5 minutes, 24 hours.

### 4.4 SEO-12: content page template (build once)
**Owner:** agent. **Effort:** 3 h. **Depends on:** SEO-04, SEO-05, SEO-06.

**Checklist**
- [ ] Types in `content/types.ts`: `ContentDoc { page: PublicPage; h1; lead; sections: {h2, body: Block[]}[]; faq?: {q, a}[]; links: string[]; byline?: boolean; madeWith?: string }`.
  - `Block` is `p | ul | ol | table | callout | demo`.
  - Bodies are plain strings with `{MAX_TRACK_MIN}` interpolation done in code, never literals.
- [ ] `components/content/ContentPage.tsx` (server component). It renders:
  - `SiteHeader`;
  - `<main>` with the H1, lead, sections, visible FAQ as `<details>` (the landing pattern), the byline and "Last checked" line, and related links;
  - `SiteFooter`;
  - the JSON-LD.
- [ ] Routes under `app/(landing)/`:
  - `chord-track/page.tsx`, `section-loop/page.tsx`, `about/page.tsx`, `how-it-works/page.tsx`, `glossary/page.tsx`, `demo/page.tsx`;
  - `practice/[instrument]/page.tsx` with `generateStaticParams` and `export const dynamicParams = false`;
  - `compare/page.tsx`, `compare/[slug]/page.tsx`, `guides/page.tsx`, `guides/[slug]/page.tsx` (each with `dynamicParams = false`).
  - Each page exports `metadata` via `pageMetadata()`, or `generateMetadata` for dynamic segments.
- [ ] Update `test/signed-in-nav.test.mjs`. The `marketing.length === 3` assertion becomes "equals the number of `page.tsx` files under `(landing)`, and each one renders `SiteHeader`". **Flag this in the PR for Jon:** it changes a pinned count.
- [ ] Add `test/content-copy.test.mjs`. For every `content/*.ts` doc it checks the rendered text for:
  - banned words (§4.0.1);
  - no `!`;
  - no "YouTube" in title, H1, H2 or meta;
  - no `$` followed by a digit, "/mo", "credits", "Pro" or "Studio" as plan names outside `/compare/*` competitor cells;
  - no literal minute figures (as in the landing test);
  - no social-proof patterns (copy the landing regex);
  - H1 ≤ 6 words;
  - meta ≤ 155 characters;
  - every compare-page competitor claim has a source URL and a `checked` date;
  - a song-name denylist hook: any quoted title other than "Lucky Ticket" fails unless it is allowlisted.
- [ ] Add the footer "Learn" nav (§4.1).
- [ ] Unpublished docs (`published: false`) render with noindex and are excluded from the sitemap, llms.txt and the footer. This lets Jon review on the live preview.

**Acceptance**
- `next build` shows every new route as ○.
- All tests are green.
- A sample doc renders with the header, footer, JSON-LD and canonical.

---

## 5. AI-search plan: becoming the cited answer

### 5.1 How each engine finds sources

| Engine | How it finds pages | What we must do | Source |
|---|---|---|---|
| Google AI Overviews and AI Mode | Google's index. The page must be indexed and snippet-eligible. No special markup. | Be indexed (SEO-01, -06, -09). Don't use `nosnippet`. | [S1][S2] |
| ChatGPT search | OAI-SearchBot, plus "other search providers" (unnamed). ChatGPT-User fetches pages that users ask about. | Allow OAI-SearchBot (done). Allow ChatGPT-User (D-SEO-1). Be in Bing as a hedge. | [S9][S14] |
| Perplexity | PerplexityBot index; Perplexity-User for live fetches | PerplexityBot is allowed (done); allow Perplexity-User (D-SEO-1) | [S11] |
| Claude | Claude-SearchBot index; Claude-User for live fetches | Allow both (D-SEO-1). ClaudeBot (training) stays blocked. | [S10] |
| Microsoft Copilot | The Bing index ("same core crawling, indexing, and ranking foundation", as quoted in [S14]) | Bing Webmaster Tools, sitemap, IndexNow (SEO-09) | [S14] |

### 5.2 What gets cited today in our space
Proxy method: the WebSearch tool, run on 2026-11-13 with question-style queries [S23]. A live panel per engine starts with SEO-27. This is a proxy, not a measurement of any single AI engine.

| Query type | Sources that surfaced | Benchmark notes |
|---|---|---|
| "best app that shows chords and lets you mute instruments" | Yamaha Extrack, Moises made-for pages (several), App Store listings (Songsterr, iReal Pro, Musician's Toolbox) | **Moises** wins through many instrument and creator landing pages. **Chordify and Yousician were absent.** No web tool page was found. |
| "app to mute guitar from a song and play along" | Yamaha Extrack, Moises made-for and blog tutorial, SoundBoost, FaChords blog | Moises again; SoundBoost's programmatic instrument pages |
| "remove bass from song to practice" | LALAL.AI guide, EaseUS, SoundBoost, beatstorapon, BassBuzz and TalkBass threads | Separators and forums; no practice-first page |
| "drumless track from any song" | Mutedrums App Store, SoundBoost, Drumeo's tutorial **about Moises**, Moises made-for page | Moises gains third-party coverage (Drumeo) |
| "learn a song by ear …" | TrueFire, Musical U, Pickup Music, wikiHow, Wikibooks | No tool vendor; an open field for a method-plus-tool guide |
| "chordify alternative …" | AlternativeTo (Chordify page), Moises made-for, review sites | **Chordify** is cited through AlternativeTo, which lists no stem tool [S21] |
| "yousician alternative …" | guitarspace, americansongwriter, guitarchalk, AlternativeTo, songscription | **Yousician** is cited through review sites and alternatives lists |
| "reddit best app practice stems chords" | songscription (competitor-authored comparisons), violetrecording review, App Store, tooldirectory | Competitor blogs write comparisons and get cited |

**What this tells us**
1. The cited sources are **specific landing pages**, **third-party lists** (AlternativeTo, review sites, tool directories) and **forums**.
2. Moises is present everywhere through volume and third-party tutorials.
3. Chordify and Yousician show up through alternatives lists.
4. A web play-along tool appears nowhere yet.

### 5.3 The plan
1. **Answer-first paragraphs** on every page (§4.0.6). Each must be quotable alone: subject, verb and the fact, with no "as mentioned above".
2. **Exact-question FAQ blocks** that mirror how people ask ("Can I mute the guitar in a song and play along?"). They are visible on the page and marked up (§SEO-05).
3. **Honest comparison pages** (§4.2) for the three primary benchmarks. "X vs Y" questions are among the most common AI prompts in tool categories. A page that says where the competitor is better is more quotable for a balanced answer. (This is a hypothesis; SEO-27 measures it.)
4. **Glossary** for definitional prompts ("what is a chord track", "what is stem bleed").
5. **Entity consistency.** The same one-sentence description (§1.3) on the site, in JSON-LD, in llms.txt and on every profile. The disambiguation line (§1.4) handles "stem loops".
6. **Third-party corroboration**, because answers lean on lists and forums (§5.2):
   - AlternativeTo listings as an alternative to Chordify, Moises and Yousician (SEO-22);
   - tool directories (GTM A14);
   - Reddit and forum answers written by Jon (§6);
   - YouTube demos (§6).
7. **Freshness.** Visible "Last checked" dates and a changelog on `/how-it-works`. When tempo ships, every page saying "not yet" is updated the same day, so AI answers don't keep repeating stale limits.
8. **Fix wrong answers.** If the monthly panel (SEO-27) finds a wrong statement about us, trace the cited page and correct our own page or the third-party listing that it comes from.
9. **No tricks.**
   - No hidden text.
   - No "instructions to AI" in pages. RESEARCH.md found a competitor (stemsplit.io) doing this and discarded its numbers.
   - No user-agent cloaking.

---

## 6. Off-page and community

### 6.1 Profiles to claim (SEO-22, with GTM A14)
- **Owner:** agent drafts; Jon creates the accounts. **Effort:** 2 h for Jon, spread over two weeks.
- **Rules:**
  - every profile uses the §1.3 sentence and the limits sentence;
  - the handle is `stem-loops` or `stemloops` where hyphens aren't allowed;
  - each profile URL is added to `SAME_AS` in `lib/seo/site.ts` once it is live.

**Profiles**
- AlternativeTo: list stem-loops and add it as an alternative to Chordify, Moises, Yousician, Capo and Transcribe!.
- Product Hunt (product page now, launch later per GTM: March 2027).
- SaaSHub.
- There's An AI For That.
- Futurepedia.
- Toolify.
- YouTube channel `@stem-loops`.
- Reddit account, u/ Jon's real account. Not a brand account; see the rules below.
- X/Bluesky handle (claim only).
- GitHub organization (claim only).
- Crunchbase (optional).

### 6.2 Communities

| Community | Size (RESEARCH.md) | Norms | How we take part |
|---|---|---|---|
| r/guitarlessons | 476k | Promotion rules unclear; enforced by removals | Jon answers "how do I learn this by ear" questions with the method (G1). He links only when asked, with "I built this". |
| r/Guitar | 3.44M | As above | Comments only. No posts until modmail approves. |
| r/bassguitar, r/Bass | ~163k / not verified | As above | Niche C. Answer "how do I hear the bass line" threads. |
| r/WeAreTheMusicMakers | 3.8M | Promotion only in weekly threads, otherwise a ban | Weekly feedback threads only, and for the loops product |
| BassBuzz forum, TalkBass | — | Both already have threads asking for tools [S23] | Reply in tool threads with full disclosure |
| Worship-musician groups | — | GTM A12 | After A12's discovery calls |
| Music teachers (studio owners, school band directors) | US: 2,210 music-class businesses (RESEARCH.md) | Email, one to one | GTM A8 teacher seeding. Ask for a link from their "resources" page. |

**Rules** (GTM A2, kept)
- Jon only, from his real account, 0.5 h a week.
- 9:1 helpful to self-mention.
- Modmail before any post.
- UTM on every link: `?utm_source=reddit&utm_medium=community&utm_campaign=a2`.
- Stop after two months under 5 UTM signups.

### 6.3 Outreach templates (brand tone: plain, short, no hype)

**Reddit or forum reply** (only where someone asks for a tool):
> Solo the part first so you can hear it on its own, then loop one section and play over it with the part muted. I built a browser tool for exactly this, stem-loops: six stems with faders and a chord track. It's Chrome on the desktop only, tracks up to 5 minutes, and the chords are an estimate, so check them by ear. https://stem-loops.com/?utm_source=reddit&utm_medium=community&utm_campaign=a2

**Modmail before a post:**
> Hi. I make stem-loops, a browser play-along tool (six stems on faders and a chord track). Before I post anything, is there a thread or day where a short write-up of a practice tool is welcome here? If not, I'll stick to comments. Thanks.

**Listicle author (for "best AI guitar apps" style articles):**
> Subject: A web play-along tool for your guitar apps list
>
> Hi [name],
>
> Your [article title] compares practice apps. stem-loops may fit: add a song and it opens in a browser player with six stems on faders and a chord track above them. Limits, so you can judge: Chrome on the desktop only, tracks up to 5 minutes, chords are an estimate, no tempo change yet. There's a demo on my own song that needs no account: https://stem-loops.com/demo
>
> Jon Cartwright

**Music teacher:**
> Subject: Play-along tracks from the songs your students bring
>
> Hi [name],
>
> I make stem-loops. A student adds a song, and it opens with six stems they can mute or solo and a chord track above. They can turn their own part down and play with the band. It runs in Chrome on a desktop or laptop. If it's useful, a link from your resources page would help other teachers find it. The demo needs no account: https://stem-loops.com/demo
>
> Jon

**Product Hunt first comment** (launch per GTM):
> I play guitar and wanted one screen with the chords above and my part muted. That's what this is: six stems on faders, a chord track, and section looping, in the browser. What it doesn't do yet: tempo and pitch change, phones, tracks over 5 minutes. The demo uses my own song, so you can try it without an account.

**YouTube demo clips** (GTM N4: screen recordings, not Jon on camera, since A11 is stopped):
- 30–60 seconds each, all on Lucky Ticket:
  - "Mute the bass, keep the chords";
  - "Loop the chorus";
  - "What bleed sounds like".
- Description: §1.3 sentence plus the limits plus a link to the matching page.
- Embed each on its page.

### 6.4 Links we will not build
- No paid links.
- No link exchanges.
- No guest posts on irrelevant sites.
- No PBNs.
- No "review in exchange for credits".
- No AI-written posts on other people's sites.

---

## 7. Measurement

### 7.1 Setup
- **SEO-09:** GSC Domain property and Bing Webmaster Tools, including Bing's AI Performance report (Copilot citations, cited pages, grounding queries [S13]).
- **Google AI traffic.** GSC counts AI Overviews and AI Mode clicks inside the "Web" search type; they are not separated [S2].
- **SEO-11: referrer tracking.** Owner: Jon decides D-SEO-5, then an agent implements. Effort: 2 h. Depends on GTM G4.
  - **Option 1:** Vercel Web Analytics. It is cookieless, served same-origin, and shows referrers. It needs a privacy-notice update (the legal tests pin that page).
  - **Option 2:** first-touch capture. Store `document.referrer` host plus `utm_*` in a first-party cookie on the first landing page view, and write it to the user row at signup. This ties AI referrals to **signups**, which is the KPI. Coordinate with G4 so there is one event schema.
  - **AI referrer hosts to classify** (regex): `chatgpt\.com|chat\.openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com|bing\.com/chat|you\.com|phind\.com`.
  - Also count `utm_source=chatgpt.com`. ChatGPT links commonly carry it; verify in our own data before relying on it.
  - Google AI Mode traffic arrives as `google.com` and can't be separated.
- **SEO-27: monthly AI answer panel.** Owner: agent. 1 h a month.
  - Run 20 fixed prompts in ChatGPT (search on), Perplexity, Google AI Mode, Claude (web search on) and Copilot.
  - Log in `overnight/SEO/ai-panel-YYYY-MM.csv`: prompt, engine, mentioned (y/n), cited URL, correct (y/n), competitors named.
  - **Prompts** (keep fixed):
    1. "what is stem-loops"
    2. "stem-loops review"
    3. "app that shows chords and mutes the guitar"
    4. "play along with a song with my instrument muted"
    5. "Chordify alternative with stems"
    6. "Moises alternative in the browser"
    7. "Yousician alternative for real songs"
    8. "how to learn a bass line by ear"
    9. "practise bass with the bass removed"
    10. "how accurate is chord detection"
    11. "what is stem bleed"
    12. "loop a section of a song to practise"
    13. "drumless track to practise drums"
    14. "learn my part from a rehearsal recording"
    15. "chord track for a song"
    16. "Moises vs Chordify"
    17. "best play-along app for guitarists"
    18. "is it legal to split stems from a song"
    19. "web app to mute instruments in a song"
    20. "stem-loops vs Moises"

### 7.2 KPIs and targets
Day 0 is the day Phase 0 ships.

The targets are **ESTIMATES**:
- they follow from GTM's Base model (A1 kill metric: ≥40 organic signups in month 8) and the GTM 33-week time to material effect;
- they are scaled down for the first 90 days;
- recalibrate at day 30 with real GSC data.

| KPI | Source | Day 30 | Day 60 | Day 90 |
|---|---|---|---|---|
| Sitemap URLs indexed / submitted | GSC Pages | 100% of Phase 0–1 pages | 100% | ≥ 22 of 25 |
| Indexable app routes | GSC + curl | 0 | 0 | 0 |
| Brand query "stem-loops" | GSC, Bing | #1 in Google and Bing | #1 | #1 |
| Non-brand impressions a month | GSC | ≥ 500 | ≥ 2,000 | ≥ 5,000 |
| Non-brand clicks a month | GSC | ≥ 10 | ≥ 50 | ≥ 150 |
| Pages with ≥1 non-brand query in the top 20 | GSC | ≥ 2 | ≥ 6 | ≥ 10 |
| Niche A, B, C pillar average position (best query) | GSC | tracked | ≤ 30 | ≤ 15 |
| AI panel: "what is stem-loops" correct | SEO-27 | ≥ 2 of 5 engines | ≥ 3 of 5 | ≥ 4 of 5 |
| AI panel: mentioned on niche prompts (3–15) | SEO-27 | ≥ 1 | ≥ 4 | ≥ 8 (of 13 × 5) |
| Bing AI Performance citations a month | BWT | tracked | ≥ 10 | ≥ 50 |
| Referring domains | GSC Links | ≥ 5 (profiles) | ≥ 10 | ≥ 20 |
| AI-referred sessions a month | SEO-11 | tracked | ≥ 10 | ≥ 40 |
| Organic + AI signups a month | SEO-11 + G4 | tracked | ≥ 3 | ≥ 10 |
| Lab Core Web Vitals on content pages | Lighthouse | pass | pass | pass |

**Kill and rethink rule.** If non-brand impressions are under 1,000 at day 90 with all 25 pages indexed, stop new content. Run a targeting review: the queries are wrong, not the volume of pages. Don't respond by adding pages.

---

## 8. Implementation plan

### 8.0 Decisions for Jon (each one is a single answer)

| ID | Question | Recommendation | Blocks |
|---|---|---|---|
| **D-SEO-1** | Open robots.txt to Claude-SearchBot and to the three user-initiated fetchers (ChatGPT-User, Claude-User, Perplexity-User), on public pages only? Training bots stay blocked. | Yes (§SEO-03) | SEO-03, AI plan |
| **D-SEO-2** | Byline and `/about` in your name, with a `Person` node in the schema? Which public profiles go in `sameAs`? | Yes. E-E-A-T's "Who" [S3]. You are already credited on the landing for Lucky Ticket. | SEO-05 Person node, SEO-13, guides |
| **D-SEO-3** | May title tags and meta use US "practice" as a verb ("Practice bass with…"), since most searchers are American? Body copy keeps Canadian "practise". | Yes for `<title>` and meta only. BRAND-TONE §5 says Canadian throughout, so this needs your exception. | Practice pages, G5, G6, G7 |
| **D-SEO-4** | May compare pages state competitor prices, with source and date? | No for v1. State free tiers and features; link to their pricing pages. Prices change too often for a quarterly check. | Compare pages |
| **D-SEO-5** | Analytics: Vercel Web Analytics, first-touch referrer capture, or both? Either way the privacy notice changes. | Both. Analytics for pages, first-touch for signups. | SEO-11 |
| **D-SEO-6** | Keep `/pricing` noindex until Stripe is live? | Yes (status quo). Index it in SEO-28 after G5. | SEO-28 |

### 8.1 Ranked task list

Scoring follows the GTM rubric: T = time to impact, C = cost, V = value, E = ease, each 1–5 with 5 best. Composite = (T + C + V + E) ÷ 20 × 100. The scores are my judgement; value is relative within SEO.

| Order | ID | Task | Phase | Owner | Effort | Depends on | T | C | V | E | Composite |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | SEO-08 | 308 www redirect | 0 | Jon | 5 min | — | 5 | 5 | 2 | 5 | **85** |
| 2 | SEO-04 | Site constants and page registry | 0 | agent | 1 h | — | 5 | 5 | 3 | 5 | **90** |
| 3 | SEO-01 | sitemap.xml | 0 | agent | 30 min | 04 | 5 | 5 | 4 | 5 | **95** |
| 4 | SEO-02 | noindex app routes | 0 | agent | 45 min | — | 5 | 5 | 3 | 5 | **90** |
| 5 | SEO-09 | GSC + Bing + Keyword Planner | 0 | Jon | 50 min | 01 | 5 | 5 | 5 | 4 | **95** |
| 6 | SEO-03 | robots.txt for AI search and user bots | 0 | Jon decides, agent builds | 30 min | D-SEO-1 | 5 | 5 | 4 | 4 | **90** |
| 7 | SEO-06 | Metadata fixes | 0 | agent | 1 h | 04 | 5 | 5 | 3 | 5 | **90** |
| 8 | SEO-05 | JSON-LD | 0 | agent | 1.5 h | 04, D-SEO-2 | 4 | 5 | 3 | 5 | **85** |
| 9 | SEO-07 | llms.txt | 0 | agent | 45 min | 04 | 5 | 5 | 1 | 5 | **80** |
| 10 | SEO-11 | Referrer and AI-referral tracking | 0–1 | Jon decides, agent builds | 2 h | D-SEO-5, G4 | 4 | 5 | 4 | 3 | **80** |
| 11 | SEO-12 | Content template, tests, footer nav | 1 | agent | 3 h | 04, 05, 06 | 4 | 5 | 4 | 4 | **85** |
| 12 | SEO-16 | Compare: Moises, Chordify, Yousician + hub | 1 | agent drafts, Jon reviews (1 h) | 6 h agent | 12, D-SEO-4 | 3 | 5 | 5 | 4 | **85** |
| 13 | SEO-17 | `/chord-track` pillar (niche A) | 1 | agent drafts, Jon reviews (20 min) | 2 h | 12 | 3 | 5 | 5 | 4 | **85** |
| 14 | SEO-13/14/15 | `/about`, `/how-it-works`, `/glossary` | 1 | agent drafts, Jon supplies facts (30 min) | 4 h | 12, D-SEO-2 | 3 | 5 | 4 | 4 | **80** |
| 15 | SEO-22 | Profiles and directories, AlternativeTo (with A14) | 1–2 | Jon, from agent drafts | 2 h Jon | 13 | 4 | 5 | 4 | 3 | **80** |
| 16 | SEO-18 | `/demo` on Lucky Ticket | 2 | agent | per GTM N2 | N2 | 3 | 5 | 5 | 3 | **80** |
| 17 | SEO-19 | `/practice/bass`, `/guitar`, `/drums`, `/keys` | 2 | agent drafts, Jon reviews (40 min) | 5 h | 12, D-SEO-3 | 3 | 5 | 4 | 4 | **80** |
| 18 | SEO-20 | `/section-loop` (niche B) | 2 | agent | 1.5 h | 12 | 3 | 5 | 4 | 4 | **80** |
| 19 | SEO-21 | Guides batch 1: G1, G2, G3, G4, plus `/guides` index | 2 | agent drafts, Jon edits (1.5 h) | 8 h | 12 | 2 | 5 | 4 | 4 | **75** |
| 20 | SEO-10 | Performance budget checks | 1–2 | agent | 1 h | 12 | 3 | 5 | 2 | 5 | **75** |
| 21 | SEO-27 | Monthly AI panel + quarterly fact check | 2 → | agent | 1 h a month | 09 | 3 | 5 | 3 | 5 | **80** |
| 22 | SEO-23 | Guides batch 2: G5, G6, G7, G8, G10 | 3 | agent drafts, Jon edits (2 h) | 10 h | 21 | 2 | 5 | 3 | 4 | **70** |
| 23 | SEO-24 | Community answers (GTM A2) | 3 → | Jon | 0.5 h a week | 21 | 2 | 4 | 3 | 3 | **60** |
| 24 | SEO-26 | YouTube demo clips (GTM N4) | 3 | agent | per N4 | 18 | 2 | 5 | 3 | 3 | **65** |
| 25 | SEO-23b | G9 copyright guide | 3 | agent drafts, counsel reviews | 2 h + counsel | GTM G3 | 1 | 4 | 3 | 2 | **50** |
| 26 | SEO-28 | Index `/pricing`, paid offers in JSON-LD | after G5 | agent | 1 h | G5 (Stripe live) | 2 | 5 | 3 | 4 | **70** |
| 27 | SEO-25 | Product Hunt / Show HN | per GTM (Mar 2027) | Jon | 3 h | 18 | 2 | 5 | 3 | 3 | **65** |
| 28 | SEO-29 | Published chord-accuracy page (§9) | after G1 | agent + Jon | 4 h | G1 engine, scorer | 2 | 5 | 4 | 3 | **70** |

**Phase calendar** (weeks from Jon's go-ahead)

| Weeks | Phase | Tasks | Notes |
|---|---|---|---|
| 0–1 | Phase 0 | SEO-01 to SEO-09, SEO-11 | About 7 agent hours and 1.5 Jon hours |
| 1–3 | Phase 1 | SEO-12 to SEO-17, start SEO-22 | |
| 3–8 | Phase 2 | SEO-18 to SEO-21, SEO-27 starts | Matches GTM A1's "week 3" start |
| 8–16 | Phase 3 | SEO-23 to SEO-26 | |

**Jon's total load:** about 1.5 h in week 0, then about 1 h a week through week 8 (reviews), then 0.5 h a week (A2). This fits GTM's 3.0 h a week envelope.

### 8.2 Agent briefs (copy-paste)

Each brief below is complete on its own. Paste the block into a new agent session.

---
**Brief SEO-P0 (Phase 0, one PR per task, in this order: 04 → 01 → 02 → 06 → 05 → 07)**
```
Repo: /home/claude/stem-loops, branch from origin/v3/main (git fetch origin v3/main first).
Read AGENTS.md, then overnight/SEO/SEO-AIO-PLAN.md §3 (tasks SEO-04, 01, 02, 06, 05, 07) and overnight/COPY/BRAND-TONE.md.
Do each task as its own PR, in the order 04, 01, 02, 06, 05, 07. Use the code in §3 as the spec; follow every checklist item and add every listed test.
Constraints:
- Never put a literal minute figure in copy; derive from MAX_TRACK_SEC via MAX_TRACK_MIN.
- Do not touch robots.ts (SEO-03 waits for Jon's D-SEO-1).
- Do not add prices, plan names or "credits" to any landing-group file.
- No aggregateRating/review in JSON-LD, ever.
- Omit the Person node in JSON-LD unless the PR description says D-SEO-2 = yes.
Done when: pnpm --filter web test and next build pass; each PR description pastes the acceptance curl commands from §3 with expected output; next build output shows new routes as static.
```

---
**Brief SEO-03 (after Jon answers D-SEO-1)**
```
Repo as above. Read overnight/SEO/SEO-AIO-PLAN.md §3 SEO-03 and the header comment of apps/web/src/app/robots.ts.
Jon's decision D-SEO-1 = <paste answer and date>.
Implement exactly the lists in SEO-03 (or the subset Jon approved), add the Sitemap line, update test/robots.test.mjs (keep the wildcard test unchanged), and update the robots.ts header comment with the decision and date.
Done when: tests pass; PR shows the full rendered robots.txt.
```

---
**Brief SEO-12 (content template)**
```
Repo as above. Read §4.0, §4.1, §4.4 of overnight/SEO/SEO-AIO-PLAN.md, BRAND-TONE.md, components/landing/SiteChrome.tsx and test/signed-in-nav.test.mjs, test/landing-copy.test.mjs.
Build content/types.ts, components/content/ContentPage.tsx, the route files listed in §4.4 (with dynamicParams=false), test/content-copy.test.mjs and test/content-pages-static.test.mjs, and the footer "Learn" nav.
Add ONE sample doc (/glossary with 3 terms) with published:false so it renders noindex and stays out of the sitemap.
Update signed-in-nav.test.mjs's marketing-page count as described; call it out at the top of the PR for Jon.
Done when: tests + build pass, every new route is ○ static, the sample renders with header, footer, canonical, JSON-LD and noindex.
```

---
**Brief SEO-16 (compare pages)**
```
Repo as above; SEO-12 must be merged. Read §4.0, §4.2 "Compare pages", §10 of the plan, and gtm/RESEARCH.md §competitors.
Write content/compare/{moises,chordify,yousician,index}.ts following the fixed template.
Re-verify every competitor fact today with WebFetch from the competitor's own site or help centre; put the URL and today's date on each claim. If a fact can't be verified, leave it out — do not fall back to RESEARCH.md silently.
"Where X is better" must have ≥3 real points; "where stem-loops is better" ≤3, each checkable on /demo or the landing.
No competitor prices (D-SEO-4 = no unless the brief says otherwise). No logos or screenshots. No "best"/"better than" in titles.
Set published:false; Jon flips to true after review.
Done when: content-copy tests pass; PR includes a table of every claim → source URL → checked date.
```

---
**Brief SEO-17/19/20 (pillar and practice pages)**
```
Repo as above; SEO-12 merged. Read §4.0 and the page specs in §4.2 for /chord-track, /section-loop and /practice/*.
Before writing any capability, confirm it in code on origin/v3/main (player, sections, chord edits, downloads by plan) and cite file:line in the PR. If the spec's wording claims something the code does not do, follow the code and note the difference.
Use Lucky Ticket as the only example. Write a unique answer-first paragraph and FAQ per page; no two pages share more than one paragraph.
published:false; Jon reviews.
Done when: tests pass; PR lists each capability claim → file:line.
```

---
**Brief SEO-21/23 (guides)**
```
Repo as above; SEO-12 merged. Read §4.0 and the guide brief(s) in §4.3 for <G#>.
Each guide: answer-first, outline as given, visible FAQ mirrored in schema, byline per D-SEO-2, "How this was made" line, Last checked date, links to its pillar and /demo.
Do not name any commercial song or artist. Do not publish G9 without the counsel sign-off recorded in the PR.
published:false; Jon edits and publishes.
Done when: tests pass; Jon's edits are applied.
```

---
**Brief SEO-27 (monthly AI panel)**
```
Run the 20 prompts in §7.1 in ChatGPT (search on), Perplexity, Google AI Mode, Claude (web search on) and Copilot, in a fresh session each, signed out where possible.
Log to overnight/SEO/ai-panel-YYYY-MM.csv: date, engine, prompt #, mentioned y/n, cited URL(s), our facts correct y/n (list errors), competitors named.
Also export Bing Webmaster AI Performance CSVs for the month.
Write a 10-line summary: changes vs last month, wrong statements about us and their cited sources, one fix per wrong statement. Quarterly: re-verify every competitor claim on /compare/* and update checked dates.
```
---

---

## 9. Better ideas Jon may have missed

1. **Publish our chord accuracy, with the method (SEO-29).**
   - The chord-engine work already has a scorer (`a2-scorer/`) and gate numbers.
   - An "How good are the chords? Measured" page, giving the test set (owned or licensed audio), the metric and the result, even if modest, would be the most citable page in the category.
   - No competitor publishes this; reviews only say "chords are often wrong" (RESEARCH.md).
   - It fits our honesty position and answers prompt 10 directly.
2. **Own-recording use cases: bands, rehearsals, teachers' own arrangements (G10).**
   - These are legally clean and nobody targets them.
   - They also build the share-link story GTM wants (band-only sharing) without the commercial-stem exposure.
3. **The demo is the backlink magnet.**
   - A no-account `/demo` on Lucky Ticket is something teachers, forum posters and listicle authors can link to without vouching for an account flow.
   - Put it first in every outreach template (§6.3).
4. **Fix the name collision early.**
   - "stem loops" (samples) and "stem-loop" (RNA) will pollute brand search and AI answers.
   - The hyphen, the "play-along" pairing, consistent profiles and the glossary line cost nothing now. Repairing it later is slow.
5. **Treat "not yet" as content.**
   - When tempo and pitch ship, that is a launch moment for every page that says "not yet" (and for the compare pages, where Moises currently wins).
   - Keep a dated changelog on `/how-it-works` so AI answers pick up the change.
6. **Mobile visitors from search will bounce.**
   - Most music-learning searches are on phones, and we support Chrome on the desktop only.
   - Add a small "send this to my computer" email-me-the-link affordance on content pages for mobile visitors (agent task, after GTM G4 events).
   - This converts search traffic we would otherwise lose. It needs the existing email stack (Resend, A5).
7. **Teacher-ready pages** (only if A8 shows traction): a printable one-page "how to use stems in a lesson" sheet with a link back. Teachers link to resources, not products.
8. **Ask beta users (G2) one question:** "What did you search for before you found us?" Ten real answers beat any keyword tool for niche wording.
9. **Don't fight Moises on volume.** Its strength is dozens of creator and instrument pages and third-party tutorials (Drumeo) [S23]. Ours is depth and honesty on three niches. Resist the instinct to match its page count.

---

## 10. Risks and what not to do

### 10.1 Legal

| Risk | Rule |
|---|---|
| Copyrighted song names in content | Never in titles, URLs, H1s, examples or screenshots. No "chords for [song]" or "[song] backing track" pages, ever. The example is Lucky Ticket. A user's job is never public content. |
| DMCA and takedowns | Depends on GTM G3 (US DMCA agent, takedown flow). No content page goes live claiming anything about sharing until D4s is decided. |
| YouTube | It is an input type only. Never in a title, H1, H2, meta, URL, schema, ad or outreach. GTM RESEARCH.md found a ToS conflict; Moises refuses streaming URLs. The home FAQ about YouTube stays out of FAQ schema. |
| Competitor trademarks | Nominative use only ("stem-loops and Moises"). No logos and no screenshots of their UI. No claim we can't source and date. No disparagement. Correction contact on every compare page; corrections handled within a week. |
| Rights guide (G9) | Not legal advice. Counsel reviews before publishing. |
| Privacy | Analytics changes (SEO-11) update the privacy notice in the same PR. The legal copy tests pin it. |

### 10.2 Honesty rules (from the brand guide, applied to SEO)
- Limits are stated on every product page:
  - Chrome on the desktop;
  - 5 minutes, from `MAX_TRACK_MIN`;
  - deleted after 24 hours;
  - an account to play;
  - rights to the audio;
  - chords are an estimate;
  - no tempo or pitch yet;
  - no lyrics.
- Measured timings only ("about 1–3 minutes for a 3:34 song"). Never "under 60 seconds".
- No downbeat-aligned loop promise.
- No fake reviews, ratings, user counts or testimonials. Production has zero registered users, and the landing test enforces this.
- Illustrations are labelled "Illustration".
- "How this was made" disclosure on AI-assisted content [S3].

### 10.3 What NOT to do
- Don't mass-generate pages: no programmatic song, artist or instrument-by-genre pages. This is the scaled content abuse definition [S4], and GTM A1v is already stopped. The cap is 25.
- Don't target separator head terms ("vocal remover", "stem splitter") as primary pages.
- Don't add `aggregateRating` or `review` schema without real, on-page reviews. Don't use HowTo schema. Don't mark up FAQs that aren't visible.
- Don't hide text, cloak, or write instructions to AI systems in pages.
- Don't disallow app routes in robots.txt instead of noindexing them, because Google must see the noindex.
- Don't let content pages become dynamic (ƒ). That is the crawler cost risk in the `robots.ts` header.
- Don't buy links, swap links, or post from brand or sock-puppet Reddit accounts.
- Don't translate the site by machine.
- Don't put prices or plan names on content pages before Stripe goes live.
- Don't let "not yet" pages go stale after a feature ships.

---

## 11. Sources

All web sources were read on **2026-11-13**.

| # | Source | URL | Notes |
|---|---|---|---|
| S1 | Google Search Central, "Optimizing your website for generative AI features on Google Search" | https://developers.google.com/search/docs/fundamentals/ai-optimization-guide | Last updated 2026-07-10. No llms.txt or special markup needed; structured data not required; unique content. |
| S2 | Google Search Central, "AI features and your website" | https://developers.google.com/search/docs/appearance/ai-features | Last updated 2025-12-10. Indexed and snippet-eligible; no extra requirements; reported under "Web" in GSC. |
| S3 | Google Search Central, "Creating helpful, reliable, people-first content" | https://developers.google.com/search/docs/fundamentals/creating-helpful-content | Last updated 2026-10-05. Who/How/Why; trust is most important; AI disclosure. |
| S4 | Google Search Central, "Spam policies" | https://developers.google.com/search/docs/essentials/spam-policies | Last updated 2026-08-28. Scaled content abuse definition and examples. |
| S5 | Google Search Central, "Software App (SoftwareApplication) structured data" | https://developers.google.com/search/docs/appearance/structured-data/software-app | Last updated 2026-09-08. `offers.price` plus `aggregateRating` or `review` required for the rich result. |
| S6 | Search Engine Journal, "Google drops FAQ rich results" | https://www.searchenginejournal.com/google-drops-faq-rich-results/574429/ | 2026-05-10. FAQ rich results stopped 2026-05-07; markup harmless. |
| S7 | Google Search Central Blog, "Changes to HowTo and FAQ rich results" (2023) | https://developers.google.com/search/blog/2023/08/howto-faq-changes | Seen in search results only; not fetched. |
| S8 | Search Engine Journal, "What opting out of Google's AI search features means now" | https://www.searchenginejournal.com/what-opting-out-of-googles-ai-search-features-means-now/ | 2026-08-01. Google-Extended doesn't control AI Overviews or AI Mode. |
| S9 | OpenAI, "Overview of OpenAI Crawlers" | https://developers.openai.com/api/docs/bots.md | OAI-SearchBot, GPTBot, ChatGPT-User ("robots.txt rules may not apply"), OAI-AdsBot. |
| S10 | Search Engine Roundtable, "Anthropic updates its crawler docs" | https://www.seroundtable.com/anthropic-updates-its-crawler-docs-40978.html | 2026-02-25. ClaudeBot, Claude-User, Claude-SearchBot. SECONDARY for Anthropic's docs. |
| S11 | Perplexity, "Perplexity crawlers" | https://docs.perplexity.ai/docs/resources/perplexity-crawlers.md | PerplexityBot; Perplexity-User "generally ignores robots.txt". |
| S12 | Ahrefs, "We analyzed 137K sites: 97% of llms.txt files never get read" | https://ahrefs.com/blog/llmstxt-study/ | 2026-06-15. |
| S13 | Search Influence, "Inside Bing's new AI Performance report" | https://www.searchinfluence.com/blog/bing-ai-performance-report-copilot-citations/ | 2026-02-12. Citations, cited pages, grounding queries. |
| S14 | eSEOspace, "Bing Webmaster Tools and IndexNow for AI search: what's confirmed and what isn't" | https://eseospace.com/blog/bing-webmaster-tools-indexnow-ai-search/ | 2026-10-13. Quotes Bing Webmaster Guidelines and OpenAI help. SECONDARY. |
| S15 | Semrush, moises.ai overview | https://www.semrush.com/website/moises.ai/overview/ | US, October 2026: 308.71K organic; top five keywords all brand (~73% of organic traffic). |
| S16 | Semrush, chordify.net overview | https://www.semrush.com/website/chordify.net/overview/ | September 2026: "7.83M Traffic"; no keyword detail on the public page. |
| S17 | Semrush, yousician.com overview | https://www.semrush.com/website/yousician.com/overview/ | September 2026: "1.07M Traffic"; no keyword detail. |
| S18 | Moises Help, "Is Moises different across platforms and devices?" | https://help.moises.ai/hc/en-us/articles/12156312650012-Is-Moises-different-across-platforms-and-devices | Web/desktop: Chord Detection, AI Detected Sections, loop, AI Audio Separation, speed and key changer. |
| S19 | Moises, "Create guitar backing tracks for any song" | https://moises.ai/made-for/guitar-backing-tracks/ | Page structure; lead and rhythm split needs Pro. |
| S20 | Yousician, About | https://yousician.com/about | "2000+" songs, "9000+" lessons, real-time feedback, "20M+" MAU (with GuitarTuna). |
| S21 | AlternativeTo, Chordify alternatives | https://alternativeto.net/software/chordify/ | ChordU, muted.io, StrumTube, Capo, Tabs Lite, yalp.io, Transcribe!, and others; no stem-loops; no stem tool. |
| S22 | Next.js 14 docs, sitemap.xml | https://nextjs.org/docs/14/app/api-reference/file-conventions/metadata/sitemap | `MetadataRoute.Sitemap`. |
| S23 | SERP probes via the WebSearch tool | (queries listed in §5.2) | 2026-11-13. Domains observed: moises.ai made-for pages, soundboost.ai, usa.yamaha.com/extrack, lalal.ai/guides, vocalremover.easeus.com, forum.bassbuzz.com, talkbass.com, drumeo.com/beat/moises-drumless-tracks-tutorial, stemsplit.io, songscription.ai, truefire, musical-u.com, pickupmusic.com, guitarchalk.com, americansongwriter.com, alternativeto.net, musicradar.com (Chordify lyrics and live detection). A search proxy, not a ranking report. |
| S24 | web.dev, "Web Vitals" | https://web.dev/articles/vitals | LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1, at the 75th percentile. |

**Internal sources**
- `gtm/RESEARCH.md`: Semrush volumes; Chordify 61% organic; Moises free tier; community sizes; Reddit rules; the YouTube and share-link legal findings.
- `gtm/BRIEF.md` and `gtm/MATRIX.md`:
  - A1 (≤25 pages, week 3, about 33 weeks to material effect);
  - A1v stopped;
  - A2, A8, A12, A14, N2, N3, N4, G3, G4, G5.
- `BRAND/JON-BRAND-GUIDE-v2-SUMMARY.md` (a paraphrased fetch).
- `COPY/BRAND-TONE.md` v1.3.1.
- Code: `origin/v3/main` @ `e739a9e`:
  - `app/layout.tsx`
  - `app/robots.ts`
  - `app/(landing)/page.tsx`
  - `app/pricing/page.tsx`
  - `app/jobs/[id]/page.tsx`
  - the route layouts
  - `test/robots.test.mjs`
  - `test/signed-in-nav.test.mjs`
  - `test/landing-copy.test.mjs`
- Live site: GET requests on 2026-11-13 to `/`, `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/pricing`, `/login`, `/history`, `/jobs/abc`, `www.` and `http://`.

**Not done, and why**
- Live ChatGPT, Perplexity, Claude and Copilot answers were not sampled. No signed-in sessions are available here, so §5.2 uses a search proxy, and SEO-27 starts the real panel.
- Google Autocomplete and Keyword Planner were unreachable from this shell, so play-along volumes are left for SEO-09b.
- Yousician and Chordify prices were not re-verified (D-SEO-4).
