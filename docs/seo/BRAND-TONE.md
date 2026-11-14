# Brand book: tone of voice (v1.3.1)

*v1.3.1, 2026-11-13. REVIEW-3 passed (93); v1.3.1 corrects the §3 Errors example only. v1.3 answered REVIEW-2 (v1.2 scored 87). The stem-loops references are anchored at `cffd7bc`. `origin/v3/main` is now `84d275d`; of the lines cited here, only `lib/admission.ts` moved (§6). Paths are relative to `apps/web/src/`.*

**Changed in v1.3:**
- The button rule is 1–5 words, matching its own example.
- Three exemplars that break the length targets are listed in §6.
- The "one cause per error" rule is now stated in §2.5.
- The quote, kHz, non-breaking-hyphen, legal-example and loops-nav rules are tightened.

**Precedence.** If this document and COPY-AUDIT v1.3.1 disagree, this document wins. The exception is a rule that conflicts with a test-pinned owner decision: the pin wins, and §6 lists every such case. Every proposed text in COPY-AUDIT v1.3.1 was checked against these rules.

## 0. Sources and their limits

Jon's brief: base the tone "on current copy or as close to what you see on Ableton.com as possible".

**Ableton: four marketing pages, read 2026-11-13.** The orchestrator fetched them with WebFetch. The quotes are near-verbatim and staged in `COPY/ABLETON-SOURCES.md`. REVIEW-1 re-read the same pages by the same route and found every quote present.
- https://www.ableton.com/en/
- https://www.ableton.com/en/live/
- https://www.ableton.com/en/push/
- https://www.ableton.com/en/about/

**The limits of that basis:**
- **No product interface, error or email copy.** Ableton therefore grounds the marketing voice, headings and buttons (principles 1–4).
- **Principles 5 and 6 (errors, caveats) rest mainly on stem-loops' own best copy.** They borrow only the temperament of the About page.
- **Not read:** the shop and manual pages.
- **Ableton capitalization is mixed.** Headlines and buttons are in sentence case ("Buy now", "Take a first look"). Feature names, blog headlines and "Contact Us" are in Title Case (REVIEW-1's reading).
- **Ableton headings are mostly 2–4 words** ("Sample and slice", "Tutorial videos"). Some questions run longer: "What can you do with Push?" (REVIEW-1's reading).

**Where stem-loops deliberately differs from Ableton:**
- **"Sign in", not Ableton's "Log in".** This keeps the product consistent with itself.
- **Sentence case for our feature names too** ("section loop", "chord track"). Only plan names are capitalized: Free, Pro, Studio.

## 1. Stem-loops at its best

Ableton's traits are already present in stem-loops' best copy:

- **Honest about gaps.**
  - "What it does, and what it does not do yet" (`app/(landing)/page.tsx:104`)
  - "The whole list, so none of it is a surprise once you are inside." (`:105`)
- **Plain about the chords.**
  - "Check it by ear: it is an estimate, not a transcription." (`:114`)
- **Written for the player.**
  - "so you can turn your own part down and play it yourself." (`:66-67`)
  - "Mute the guitar and play the guitar part; solo the bass to work it out; loop the chorus until it sticks." (`:264-265`)
- **Errors that place the blame correctly.**
  - "It's not something you did — we're working through other people's songs." (`lib/error-copy.ts:20`)
  - "It may well be fine, and this is our fault, not your connection." (`app/jobs/[id]/JobView.tsx:227`)

**Where it falls short:**
- Loop-downloader leftovers: "Extract some loops", "Your recent loops".
- Internal codes on screen: "JOB" (`components/ChordOverlay.helpers.ts:1202-1203`), "past_due", "credits_20".
- Title Case and glyphs on buttons: "Buy Credits", "⬇ Download All (ZIP)".
- Engineer-precise detail in the hero: "drifts under 2 ms per 4‑bar repeat (measurement noise)". This is held as a recorded follow-up (`page.tsx:10-13`).

## 2. Voice principles

Each principle cites Ableton (A) and stem-loops (S).

### 1. Lead with the musical action
Start sentences and buttons with a verb the player does.

- **A:** "Tweak controls as you explore, then press Capture to turn gestures into automation." (https://www.ableton.com/en/live/)
- **A:** "Sample and slice", "Play expressively" (https://www.ableton.com/en/push/)
- **S:** "Mute the guitar and play the guitar part; solo the bass to work it out" (`page.tsx:264-265`)
- **Do:** "Mute your part and play it yourself." · "Start a new song"
- **Don't:** "Demucs htdemucs_6s isolates six sources." Keep model names in the spec list and footer.

### 2. Name the capability and the result, and nothing more

- **A:** "Shape attack and sustain separately for punchier hits, louder tails or choppy loops." (https://www.ableton.com/en/live/)
- **A:** "Get a clear overview of the devices on each track, directly in the mixer." (https://www.ableton.com/en/live/)
- **S:** "so you can turn your own part down and play it yourself." (`page.tsx:66-67`)
- **Do:** "Six stems, each with a fader, mute and solo."
- **Don't:** "studio-quality", "clean stems", "real faders".

### 3. Be honest, and humble about the hard parts
State limits before the user finds them, and never claim what the code doesn't do.

- **A:** "Making music isn't always easy. But it's the highs and lows that make it so rewarding." (https://www.ableton.com/en/about/)
- **S:** "Check it by ear: it is an estimate, not a transcription." (`page.tsx:114`)
- **Do:** "Pick a detected section, such as a verse or a chorus."
- **Don't:** "a stretch you choose" (no such control exists).

### 4. Keep headings and buttons short and plain

- **A:** Buttons "Buy now", "Take a first look", "See all posts" (https://www.ableton.com/en/)
- **A:** Headings "What is Push?", "Tutorial videos" (https://www.ableton.com/en/push/, https://www.ableton.com/en/)
- **S:** "Paste a song. Play along." (`page.tsx:63`)
- **Do:** "Buy credits", "Cut 36 loops", "Email me a one-time link".
- **Don't:** "Buy Credits", "⬇ Download All (ZIP)", "Send me a one-time login link".

### 5. Own the problem
Say whose fault it is, what happened, and one next step. This rests on stem-loops copy, with Ableton's "we're in it for the long run" (https://www.ableton.com/en/about/) as the temperament.

- **S:** "It's not something you did — we're working through other people's songs." (`lib/error-copy.ts:20`)
- **Do:** "Something went wrong on our end. Please try again." (server fault). Client validation errors say what to fix and never blame us.
- **Name one cause.** If one error code covers two real causes, name both until the code is split (audit F72, F29). Example: "This track is too short or has no steady beat. Try a longer track with a clear beat."
- **Don't:** "We couldn’t start that job. PAID_LINK_INGEST_DISALLOWED".

### 6. Say it once, unless a guard says otherwise
Put one caveat in one place, next to the thing it qualifies. This rests on stem-loops evidence (the four-times-repeated one-time-link caveat).

- **Exception:** a sentence that a test pins as a launch-blocker guard stays until Jon decides (§6).
- **Do:** one limits row in the spec list.
- **Don't:** a new paragraph that repeats a limit stated nearby.

## 3. Tone by context

| Context | Tone | Shape | Example (current or audit-approved) |
|---|---|---|---|
| **Marketing** (landing, OG, meta) | Confident and concrete. Player first, loops second. "Job" only where the page explains accounts, limits or stages. | H1 ≤ 6 words. Lead sentence ≤ 30 words. Spec rows in fragments. | "Paste a song. Play along." |
| **In-product** (player, mixer, job page) | Quiet and functional. | Verbs on buttons, nouns on headings, status ≤ 8 words. | "Cut 36 loops" · "Finding bars and sections" |
| **Errors** | Calm and specific. Blame placed correctly. One next step. | Headline ≤ 10 words, action ≤ 20 words. Never a code, stack trace or raw server text. | "This track is too short or has no steady beat. Try a longer track with a clear beat." (audit F29, v1.3) |
| **Legal-adjacent** (data FAQ, delete page, pricing small print) | Literal. No "safe", "secure" or "private" unless the code enforces it. | Must match the privacy notice on facts. | "A job’s link is the only thing protecting it." (`app/(landing)/privacy/page.tsx:127`, current) |
| **Emails** | Warm and brief. One purpose per email. | Subject ≤ 50 characters. The first line says why you got it. One verb-first button. Human labels for every status. | "Thanks for subscribing. Upload a song and it opens in the player…" |

## 4. Words

### Name (decision for Jon, F68)

The product is written **stem-loops** everywhere: the wordmark (`components/landing/SiteChrome.tsx:9`), the metadata, and the legal pages. Legal meta tests pin it. The brief says "Stem Loops".

**Recommendation:** keep `stem-loops` and avoid starting sentences with it. Two current exceptions:
- the hero lead (`page.tsx:66`);
- the terms (`terms/page.tsx:32`). Changing the terms needs Jon.

If Jon chooses "Stem Loops", change every instance in one PR, including the pinned tests.

### Nouns

| Term | Rule |
|---|---|
| **song** | What the user brings: "Paste a song", "Start a new song". |
| **track** | Limits, specs and billing: "Tracks up to 5 minutes", "5 tracks a month", "free tracks this month". |
| **job** | The processing record. Use it in the UI ("Job history", "job page") and in the landing page's account and stage explanations (pinned: "Starting a job needs no account", `landing-copy.test.mjs:290`). Never in benefit copy. |
| **stems** | Lowercase, including stem names: drums, bass, vocals, guitar, keys, other. |
| **player**, **play along** | The noun is lowercase. The nav label is "Play along". Use "play-along" only as an adjective. |
| **chord track**, **chords** | Lowercase. Symbols as shown: Gm, E♭. Pair with "estimate" on first mention in marketing copy. |
| **section loop** | Looping a detected section. |
| **loops** | The second product. Verbs: **cut** and **download**. Never "extract" or "map" in user copy. Nav label when it ships: "Download loops", per Jon's brief and `signed-in-nav.test.mjs:150-157`. |
| **plans**, **credits** | Free, Pro, Studio are capitalized. "credit pack" and "credits" are lowercase. Each credit covers one uploaded track on the Free plan. |
| **sign in**, **sign-in** | "Sign in" is the verb; "sign-in" is the noun and adjective. Never "log in" or "login". |

### Use and avoid

| Use | Avoid |
|---|---|
| play along, mute your part, solo, loop the chorus | extract, process, convert, ingest, throughput, submit |
| estimate (chords, key) | accurate, perfect, clean, studio-quality, real, powerful, amazing, instantly |
| not yet | coming soon (undated), unlimited |
| upload, paste a link, add (covers both) | URL (say "link"); "drop your own file" (but "or drop a file here" is right for drag and drop) |
| on our end | on our side |

## 5. Formatting

### Spelling
Use Canadian English throughout:
- -our: colour, behaviour
- -re: centre
- -ize: capitalize, organize
- doubled l: cancelled, travelled
- practise (verb) / practice (noun)
- licence (noun) / license (verb)

Status codes from providers keep their own spelling (`canceled`).

### Case
- Sentence case for headings, buttons, tabs, nav and email subjects.
- No ALL CAPS in visible text.
- Capitalize only proper nouns and plan names.

### Buttons
- Verb first, then the object: "Buy credits", "Cut 36 loops", "Start a new song", "Go to your account".
- Nav labels may be nouns ("Job history").
- Busy states are an -ing verb plus an ellipsis: "Cutting…", "Signing in…".
- Length: 1–5 words. Aim for ≤ 20 characters; the hard maximum is 24 ("Email me a one-time link": 5 words, 24 characters).

### Numerals
- **Spell out one to nine in running prose:** "six stems", "one uploaded track". "Six stems" is the product phrase (pinned, `landing-copy.test.mjs:422`).
- **Use digits for:**
  - 10 and above;
  - any number with a unit: "5 minutes", "8 bars", "200 MB", "102 BPM";
  - counts in labels, buttons and status: "Cut 1 loop", "2 of 5";
  - prices;
  - spec rows.

### Units
- Put a non-breaking space between number and unit: `200 MB`, `44.1 kHz`, `102 BPM`.
- Write "BPM" and "kHz" exactly so: BPM in capitals, kHz with a lowercase k.
- In landing-page JSX prose, hyphenated compounds (`24-bit`, `8-bar`) take a non-breaking hyphen (`&#8209;`) so they don't wrap, as `page.tsx:229-230` does.
- In JS string literals elsewhere (buttons, status, errors: e.g. `LoopResults.tsx` "24-bit WAVs"), a plain hyphen is correct.
- Hyphenated compounds never take a space.
- Song positions and lengths use m:ss ("3:34", "0:51"). Limits use words ("5 minutes").

### Money
- **Price tags:**
  - Drop ".00" on whole dollars: "$12 CAD", "$4.99 CAD". This is pinned: `pricing-credit-packs.test.mjs:180,194`.
  - "/mo" as rendered today.
- **Receipts and emails:** always two decimals, "$5.00 CAD" (pinned: `emails.test.mjs`).
- **Prose:** "a month" or "per month".

### Dates
- **Prose:** "9 October 2026", as the legal pages do ("10 November 2026").
- **Lists, tables and email fields:** ISO, "2026-11-13", as the account page and emails do today (pinned: `emails.test.mjs` `/2027-01-15/`).

### Arrows
- "→" after a text link that moves forward: "Start a new song →".
- "←" before a text link that goes back.
- Never on buttons or button-styled links, and never both arrows at once.

### Punctuation
- One idea per sentence.
- At most one em dash per paragraph.
- No exclamation marks.
- No slash meaning "or".

### Apostrophes and quotes
- New strings use curly ’ and “ ”, as the landing page does.
- **In a file that uses straight quotes** (`lib/error-copy.ts`, `apps/worker/src/worker/errors.py`), a new or edited string stays straight. Convert the file only with its tests, in one PR, because several tests compare those strings exactly.
- Known exception: audit D-03 added one curly sentence to `error-copy.ts`. Straighten it as a follow-up once PR-D lands.

### Icons
- No emoji or glyphs (✂ ⬇) inside labels. Use SVG with `aria-hidden`.
- An accessible name may carry state ("Play (loading)", a deliberate choice: `play-transport.test.mjs:190`).

### Length targets

| Element | Target |
|---|---|
| Button | 1–5 words; ≤ 20 characters, hard max 24 |
| Nav label | 1–2 words |
| H1 | ≤ 6 words |
| H2 | ≤ 8 words |
| Error headline | ≤ 10 words |
| Error action | ≤ 20 words |
| Status | ≤ 8 words |
| Email subject | ≤ 50 characters |
| Meta description | ≤ 155 characters |

## 6. Pinned exceptions

These keep wording that the rules above would change. Each stays until Jon approves the change and its test edit.

| String | Rule it breaks | Pin or record |
|---|---|---|
| "…tracks converted to play-along per month" (`lib/pricing-copy.ts:54`) | avoid "convert" | `pricing-features-table.test.mjs:296` (#210 fix) |
| "Processing…" (`app/jobs/[id]/JobView.tsx:311`) | avoid "process" | `job-page-render.test.mjs:397`, `job-view-poll.test.mjs:299,485` |
| The one-time-link guard sentences (landing ×2, login note) | §2.6 say it once | `landing-copy.test.mjs:586-587`, `login-form.test.mjs:69-76` (launch blocker) |
| "You’re going a bit fast, or we’re at capacity right now…" | one cause per error | Both causes are real (`lib/admission.ts:145,159` on `84d275d`; `:122,136` at `cffd7bc`); `admission-at-capacity.test.mjs:264`. Split the code first (audit F72). |
| No price, plan or pricing link on the landing | — | `landing-copy.test.mjs:316-325` ("no payment at launch") |
| "Play (loading)" and similar accessible names | parentheses in labels | `play-transport.test.mjs:190` |
| Hero lead, `app/(landing)/page.tsx:66-67` (34 words after audit A-09) | lead ≤ 30 words | `landing-copy.test.mjs:422` pins its content |
| "What it does, and what it does not do yet" (`page.tsx:104`, 10 words) | H2 ≤ 8 words | none; cited in §1 as best copy |
| Landing meta description (`page.tsx:37`, 174 characters after audit A-02) | meta ≤ 155 characters | none; shorten as a follow-up once PR-A lands |

## 7. Before and after (rendered strings)

Every "after" follows §2–§5 and appears in COPY-AUDIT v1.3.1.

| # | Where (`cffd7bc`) | Before | After |
|---|---|---|---|
| 1 | `lib/emails/templates/welcome.ts:21-22` (F01) | "Thanks for signing up. You can now separate any YouTube track into clean stems and loop-ready bars." | "Thanks for subscribing. Upload a song and it opens in the player: six stems on faders, with a chord track to play along to." |
| 2 | `components/landing/PlayerArt.tsx:93` (F03) | "Mark a verse, a chorus or a stretch you choose, and it repeats until you have it." | "Pick a detected section, such as a verse or a chorus, and it repeats until you have it." |
| 3 | `app/layout.tsx:8` (F07) | "Split a song into stems and 1, 2, 4 or 8-bar loops at the detected BPM, as 24-bit WAV. Free, no account." | "Split a song into six stems with faders and a chord track, and play along. Tracks up to 5 minutes, in Chrome on the desktop." (minutes derived from `MAX_TRACK_SEC`) |
| 4 | `app/history/page.tsx:23` (F25) | "No jobs yet. Extract some loops →" | "No jobs yet. Start a new song →" |
| 5 | Landing form, from `lib/billing/entitlements.ts:357` (F13) | "We couldn’t start that job. PAID_LINK_INGEST_DISALLOWED" | "We couldn’t start that job. Credits, Pro and Studio only work with files you upload. Upload the audio file instead. YouTube links work on the Free plan." |
| 6 | `components/LoopResults.tsx:170,185` (F27, F47) | "✂ Cut 1 loops" · "⬇ Download All (ZIP)" | "Cut 1 loop" · "Download all (ZIP)" |
| 7 | `components/ChordOverlay.helpers.ts:1202-1203` (F28) | Pill "JOB" | Pill "Ready" |
| 8 | `components/JobProgress.tsx:34` (F73) | "Extracting loops" | "Finding bars and sections" |
| 9 | `app/success/page.tsx:23,27` (F16) | "Thanks!" / "Your credits/subscription is active." | "Thank you" / "Your purchase appears on your account once the payment is confirmed." |
| 10 | `components/LoginForm.tsx:230` (F55) | "Send me a one-time login link" | "Email me a one-time link" (24 characters; the guarded note below it is unchanged) |

## 8. Sources

**stem-loops source:** `origin/v3/main` @ `cffd7bc`. Every file:line above was found by searching for the quoted string in that tree.

**stem-loops live site:** read 2026-11-13 by GET. Text copies are in `COPY/live/`.

**Ableton:** https://www.ableton.com/en/, /en/live/, /en/push/ and /en/about/, read 2026-11-13 with WebFetch. The quotes are near-verbatim, are staged in `COPY/ABLETON-SOURCES.md`, and were re-read in REVIEW-1. The shop and manual pages were not read.
