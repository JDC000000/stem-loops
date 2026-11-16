# Two products, one top nav — 2026-11-15

Jon (2026-11-15): "on the home page ... stem downloads would be removed from the play along section. It's just up on the top nav. I don't see it up on the top nav. It's a full separate product available in the top nav on a separate user page. ... Look at how Moises handles their different products and separates them."

## 1. How peers separate products (research, 2026-11-15)

- **Moises shows each product's own page before asking for an account.** Its home is titled "The Creative Suite for Musicians". Each product (Moises Studio, Stem Separation, Video Recording) gets its own block on the page: a heading, a tagline, one or two CTAs, and media. Each block links out to a "Learn more" product page. Login, Sign up and Open Moises sit at the right of the bar, apart from the product links. ([moises.ai](https://moises.ai/))
- **Moises lists products as peers.** A "Products" page shows a grid of cards with one "Learn more" per product, and the footer has a separate "Products" column (Moises App, Web App, iPad App). New products are pushed with a banner above the nav ("Introducing Moises Studio"), not by mixing them into another product's sales copy. ([moises.ai/products](https://moises.ai/products/))
- **LALAL.AI gives every tool its own URL and page.** Examples: /stem-splitter, /voice-cleaner, /echo-reverb-remover, /voice-changer, /desktop-app, /api. The home page sells one tool (the vocal remover), and the other tools are reached from the nav. ([lalal.ai/llms.txt](https://www.lalal.ai/llms.txt))
- **Chordify keeps its core product (chords over a song you play back) separate from add-ons.** The Guitar Toolkit, live chord detection and the Premium extras (MIDI/PDF downloads, looping) each get their own name instead of being folded into the core pitch. ([MusicRadar](https://musicradar.com/news/chordify-lyrics-live-chord-detection))
- **The pattern common to all three:** products are peers in navigation, each has a page that says what it is, and sign-in is a separate control. That control is never the only thing behind a product link.
- **What this means for stem-loops:** the bar should read *Play along · Download loops* as two peers on every page. The landing should be the Play along page only. /loops should explain itself to a signed-out visitor before it asks for sign-in, with a return path back to /loops. The footer should list both products.
- **What I could not check:** direct fetches of lalal.ai's home page and chordify.net were not approved during this session. The LALAL.AI and Chordify points above come from LALAL.AI's own llms.txt and from press coverage, not from their live nav markup.

## 2. Audit before this change (Playwright, 1280 and 390, signed out and signed in)

Script: `scripts/design/nav-audit.mjs`. Signed-in cells used the same local, never-committed `getUser()` patch as the 2026-11-14 360px sweep.

| Gap | Where | Evidence |
|---|---|---|
| G1. **Download loops missing from the bar** (Jon's complaint) | `/`, `/terms`, `/privacy`, 404 | These pages rendered the old marketing bar, which had only "Job history" and "Sign in" (`SiteChrome.tsx`). |
| G2. Two different bars across the site | the marketing pages vs every other page | The marketing bar had no Play along item and no current marker. The app bar had both. |
| G3. Signed-in visitors were offered "Sign in" | the marketing pages | That bar was hard-coded. |
| G4. **The landing sold loop downloads** | `/` | The "You can still take the loops home" section (file card, WAV, A/B demo); the "Loop files" spec row; the pipeline "Play" stage (bar-length loops, 24-bit WAV); the "What do I get" FAQ ("cut and download"); and "Can I use the loops commercially?". |
| G5. The landing did not mark which product it is | `/` | No current item and no product tag. |
| G6. Signed-out "Download loops" was a bare bounce | `/loops` | It redirected straight to `/login`, with nothing to say what the product is. |
| G7. /loops was hidden from search | `/loops` | It was `noindex` and absent from the sitemap, so a product in the nav had no public page. |
| G8. (not in this scope) | `/pricing`, `/terms` | Both mention loop downloads as a plan feature or in terms text. That is correct there; other agents own those pages. |
| G9. (follow-up) The hero still frames part of its UI around the loop cut | `/` hero | The tool form's "Loop length" picker and summary, and the example lanes' captions. See §4. |

## 3. What changed

- **One top nav on every page.** The landing, /terms, /privacy and the 404 now render the same component as the app pages (`SignedInNav`): *Play along · Download loops · Job history · Sign in / Account*. The current product is marked by `aria-current`, by the edge-and-weight cue from #275, and by a product tag beside the wordmark ("Play along" / "Download loops") that stays visible on phones. Fixes G1, G2 and G5.
- **Session on static pages.** The marketing pages stay statically rendered, for crawl and edge-cache cost. On them the last item renders "Sign in", then switches to "Account" if the browser holds a Supabase session cookie. This only changes the label. No request is made and nothing is unlocked: `/account` still checks `getUser()`. A server-resolved session always wins over the cookie. Fixes G3.
- **Signed-out "Download loops" goes to a /loops product intro, not straight to sign-in.**
  - Reason: the item now sits on the landing, where most visitors are signed out and new. Sending them to a bare sign-in form makes the link look broken and says nothing about the product. Moises and LALAL.AI both explain a product before asking for an account.
  - The intro says what you get (lengths, stems, 24-bit WAV, naming, beat-counting caveat, the 24-hour window), how it relates to Play along, offers the example loop, and gives the rights note.
  - Its single primary button is "Sign in to download loops", which goes to `/login?return_to=%2Floops`.
  - A `?job=<id>` deep link still goes straight to sign-in, because a visitor arriving from a job page already knows the product.
  - Fixes G6.
- **The landing is Play along only.**
  - Removed: the loops section, the loop-file spec row, and the loop lines in the pipeline and FAQ.
  - Kept: the A/B "hear the split" demo, moved into the pipeline's Play stage, because it shows stem quality, which is a Play along concern.
  - The rights FAQ is reworded for practising and releasing. The loop-specific version moved to /loops.
  - The footer gains a "Products" list: Play along · Download loops.
  - Fixes G4.
- **SEO (#271 rules).** `/loops` is added to the page registry as a published product page, so it appears in the sitemap and llms.txt. Its metadata comes from that registry entry: indexable, canonical `/loops`. The app routes keep their `noindex`. Fixes G7.

## 4. Review round 1 changes (IA 84, conversion/a11y 92)

- **B1:** the Play along form no longer shows a "Loop length" picker or any "N-bar loops" text, and it no longer sends `loop_length_bars`, so the API's default of 4 bars applies. No worker change was needed. The only remaining exception in the landing ban list is the hero's example lanes, whose measured captions are part of the demo-asset contract.
- **B2:** the /loops intro now says that loops are 4 bars, fixed when the song is split. It no longer claims a choice of length.
- **Should-fixes:**
  - The /loops intro's retention line now depends on the plan: 24 hours on Free; on Pro and Studio, kept while you subscribe and for 30 days after it ends. The wording matches PR #279.
  - The intro now states the 5-minute rule.
  - The A/B caption on the landing is reworded so it no longer points at a file card that was removed.
  - The nav's "Sign in" on /loops now keeps the return path back to /loops.
  - Escape now closes the phone menu and returns focus to the toggle.
  - The signed-out /loops intro now has a footer.
  - A new test checks that the static pages keep the "Account" hint.
- **S4 (where /pricing sits):** the /loops intro footer now links to Pricing. The shared marketing footer and the top nav do not, because both render on the landing, where Jon's F31 (2026-11-13) allows exactly one /pricing link and the landing tests ban pricing words. Signed-in visitors still reach /pricing from Account.
- **Screens:** every screenshot in `screens-2026-11-15/nav/` was regenerated from this round's code.
- **Still open:** the hero's example lanes are still captioned around the loop cut, and the landing FAQ's "deleted after 24 hours" belongs to PR #279.

## 5. Screens

`docs/design/screens-2026-11-15/nav/`: every page at 1280 and 390, signed out (`-out-`) and signed in (`-in-`), plus the landing's menu open at 390. `audit.md` in the same folder is the machine-read table from the after state.
