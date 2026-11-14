# Stem-Loops GTM: Market Research & Benchmarks

Prepared 2026-11-12 by the market-research agent. **All sources were read on 2026-11-12** unless a row says otherwise. Grades:
- **VERIFIED** means the number is taken directly from the cited page. Where that page is itself secondary, the row says "(secondary)".
- **DERIVED** means the number is computed from sourced numbers, and the formula is shown.
- **ASSUMED** means the number is a judgement.

Currency is shown on every price. FX used: **1 USD = 1.411 CAD** (OFX, 2026-11-07/08 close: 1 CAD = 0.7086 USD; https://www.ofx.com/en-us/forex-news/historical-exchange-rates/cad/usd). VERIFIED.

Nothing in this file came from the repo, the database or stem-loops.com. Product facts (plans, prices, features) come from SPEC.md.

---

## 0. Executive summary (the 10 things that matter)

| # | Finding | Grade | Source |
|---|---|---|---|
| 1 | **Moises gives the same free quota as Stem-Loops (5 uploads/mo), and its Premium is *unlimited* uploads for USD 3.99/mo on the web (≈CAD 5.63) or USD 5.99/mo on iOS (≈CAD 8.45).** Stem-Loops Pro is CAD 4.99 for 50 tracks. That is cheaper than Moises's iOS price but capped. It is roughly at price parity with Moises web, without "unlimited". | VERIFIED (free 5/mo; iOS price) / VERIFIED-secondary (web USD 3.99) / DERIVED (CAD) | help.moises.ai art. 360010972039; apps.apple.com Moises; chartlex.com Moises review (Jul-2026 check) |
| 2 | **Moises is the incumbent and very large**: 70M users (2025), 15M+ added in 2025, USD 50M+ raised, 190 countries. It already does stems, chords, loops, tempo/pitch and a smart metronome. **Stem-Loops' white space is narrow**: web-first with no install, bar-grid loops, loop-WAV export, and a public share link that plays. | VERIFIED | moises.ai/newsroom 2025-year-in-review |
| 3 | **Freemium download→paid median is 2.1% (D35) vs 10.7% for hard paywalls** (RevenueCat 2026, 115k apps). Self-serve SaaS freemium: "good" is 3–5% and "great" is 6–8% (Lenny/Poyar). Duolingo converts 7% of MAU. | VERIFIED | revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026; lennysnewsletter.com; blog.duolingo.com |
| 4 | **Monthly plans retain badly**: 12-month retention is a median 8% for monthly plans (AI apps 6.1%). Median *first* monthly renewal is 48% for Photo & Video and 56% for Education. Web billing (Recurly) reports much lower monthly churn: Digital Media 4.14%, Education 4.99%. | VERIFIED | revenuecat.com/state-of-subscription-apps; revenuecat.com/blog/growth/average-subscription-renewal-rates-by-app-category; recurly.com/research/churn-rate-benchmarks |
| 5 | **Paid acquisition does not pay back at CAD 4.99.** At WordStream's Meta Arts & Entertainment CPC (USD 0.49–0.88) and a 2–5% signup→paid rate, CAC lands at CAD ~70–600 per payer. LTV at CAD 4.99 is CAD ~24–112 (gross, before COGS). Paid can only work for Studio or annual plans, and only after conversion is proven. | DERIVED | §3, §6 |
| 6 | **SEO is how this category is won.** Organic search drives 47% of vocalremover.org's traffic (10.7M visits/mo) and 61% of Chordify's (6.5M/mo). US monthly search volumes: "vocal remover" 60,500; "bpm finder" 49,500; "key finder" 33,100; "stem splitter" 9,900; "stem separator" 2,400; "guitar tabs" 74,000. | VERIFIED (Similarweb/Semrush estimates) | similarweb.com; semrush.com/website/... |
| 7 | **Referral programs only work when double-sided and gated on activation.** Dropbox's 2-sided storage reward permanently lifted signups 60%, and 35% of daily signups came from referral. Suno pays 250 credits to both sides only after the friend makes 10 songs. LALAL.AI pays minute credits to both sides. Referred customers are ~16% more valuable and churn ~18% less (academic). | VERIFIED | slideshare Dropbox deck; Suno IG post; lalal.ai referral agreement; extole.com (citing J. Marketing) |
| 8 | **The share link is both the best viral surface and the largest legal exposure.** Moises refuses streaming URLs and says extracting stems from streams is an "unauthorized derivative work". Canada's private-copying exception (s.29.22) requires that the copy is *not given away* and that no TPM is circumvented. A public play link to separated stems of a commercial song is distribution. | VERIFIED (law text, Moises help) / ASSUMED (applies to Stem-Loops) | laws-lois.justice.gc.ca s.29.22; help.moises.ai streaming article |
| 9 | **YouTube-link ingest breaks YouTube's ToS** ("access, reproduce, download… except as expressly authorized"). It would be an outright **App Store rejection under guideline 5.2.3**. The RIAA has won early rounds against stream-rippers (Yout). Keep YouTube ingest off for any public launch. | VERIFIED | youtube.com/static?template=terms; developer.apple.com/app-store/review/guidelines; courthousenews.com |
| 10 | **The cheapest first segment is intermediate hobby guitarists learning songs by ear.** They are reachable free via SEO, r/guitarlessons (476k) and r/Guitar (3.44M). Fender says 16M Americans started guitar in 2020–21 and 90% of beginners quit within a year. Teachers are a small (US: 2,210 music-class businesses) but high-leverage referral node. | VERIFIED | guitarworld.com; musicradar.com; prowlo.com; gummysearch.com; ibisworld.com |

---

## 1. Competitive landscape

### 1a. Competitor table

Prices are as published, with the currency noted. App Store prices are from the US storefront unless stated.

| Product | Core job | Pricing (currency) | Free tier limits | Platforms | Scale (public) | Positioning | User complaints (sample) | Src |
|---|---|---|---|---|---|---|---|---|
| **Moises** (Music AI, Salt Lake City / Brazil) | Stems, chords, key, tempo/pitch, smart metronome, loop/trim, lyrics, setlists, AI Studio (generative stems) | iOS: Premium **USD 5.99/mo**, **USD 39.99/yr**; Pro **USD 29.99/mo** (VERIFIED). Web: Premium USD 3.99/mo, Pro USD 9.99/mo (VERIFIED-secondary, Chartlex Jul-2026; Moises web pricing is now behind login) | **5 uploads/month**. Free separation is 2-stem only (vocals/instrumental). Mastering 5 min/file free vs 20 min paid | iOS, Android, Web, Desktop, iPad; VST (Pro) | **70M users (2025)**, +15M in 2025, 1.2B minutes processed, USD 50M+ raised; 4.7★ / 28K ratings iOS; #54 Music (US) | "The musician's app"; licensed-data training claim; Ableton and Fender Studio Pro partner | Free features moved behind paywall; chord roots wrong; instruments land in "other"; no chord export; Pro VST USD 35/mo with no trial (Reddit) | M1–M6 |
| **Chordify** (Groningen) | Auto-chords on any song (YouTube/Deezer/SoundCloud/upload), animated diagrams | Premium iOS: USD 8.00–9.00/mo, USD 42–54/yr (VERIFIED; IAP list, storefront not labelled) | One reviewer reports 3 practice songs/day (anecdotal, 2022) | Web, iOS, Android | "10M+ musicians each month", 36M songs (App Store NL listing); web 6.5M visits/mo (Sep-2026), 61% organic search; 4.7★ / 34K ratings | Chords for any song | Nagging upsell; auto-chords often wrong; benefits of Premium unclear | C1–C3 |
| **LALAL.AI** (OmniSale GmbH) | High-quality separation, voice changer, VST, API | Starter free; **Lite USD 7.50/mo (USD 90/yr)**; **Pro USD 15/mo (USD 180/yr)**; top-ups USD 50/750 min, 190/3,000, 300/5,000 | **10 minutes** relaxed queue; minutes × number of stems | Web, desktop, VST (Pro), API | Web ~2M visits/mo (Oct-2026), down 12% MoM | Quality-first separation; producer/pro audience | (reviews not sampled; quality is the selling point) | L1–L3 |
| **Ultimate Guitar** (Muse Group) | Tabs/chords catalog, Pro interactive tabs, Tonebridge effects, UG Courses | UG Pro **USD 9.99/mo**, **USD 39.99/yr** (sales USD 22.99–29.99); Pro+Courses+Sing USD 59.99/yr | Text tabs free; interactive/Pro tabs paid | Web, iOS, Android | Muse Group "400M+ users" (all products, 2025); ultimate-guitar.com ~70.6M visits/mo (Semrush); 4.7★ / 482K ratings | The tab catalog incumbent | Autoscroll unreliable; MIDI playback stiff; wrong chords; Pro paywall | U1–U3 |
| **Songsterr** | Synced tabs, solo/mute tracks, loop measures, speed, AI tab transcription (50/mo on Plus) | **Plus USD 9.99/mo** (iOS IAP); legacy USD 4.99 | Playback pauses every 10 bars; ads; no speed/loop/solo | Web, iOS, Android | songsterr.com 5.03M organic visits/mo (Semrush, Sep-2026); "songsterr" 135k US searches/mo | Tab-centric play-along | (not sampled) | S1–S3 |
| **Yousician** (+ GuitarTuna) | Gamified lessons with real-time feedback | One instrument USD 19.99/mo, USD 119.99/yr; Premium+ USD 29.99/mo, USD 159.99–179.99/yr | Intro exercises only; most level-1 content locked | iOS, Android, desktop | **20M+ MAU** combined Yousician + GuitarTuna; 4.6★ / 139K ratings | Structured learning path | Content locked behind premium; favourites lost after tier change | Y1–Y2 |
| **Fender Play** | Video lesson curriculum | **USD 9.99/mo, USD 89.99/yr** (2022 article); 7-day trial | Trial only | iOS, Android, web, TV | Not disclosed | Beginner curriculum from the guitar OEM | (not sampled) | F1–F2 |
| **Capo** (SuperMegaUltraGroovy) | Chord/beat/key detection, slow-down, loops, instrument isolation | Capo touch Pro **USD 6.99/mo or USD 19.99/yr**; Platinum USD 49.99–59.99/yr | Free app with IAP | iOS, macOS | 4.4★ / 312 ratings (CA store); Editors' Choice | Learn-by-ear power tool | Can't analyse Apple Music/Spotify tracks; prefers one-time payment | K1 |
| **vocalremover.org** (+ splitter tools) | Free browser vocal remover, splitter, BPM/key finder, pitch | Free (ad-supported) | None stated | Web | **~10.7M visits/mo** (Oct-2026), 47% organic search; ranks #1 for "vocal remover" (60.5k US/mo) and "stem splitter" (9.9k) | Free utility SEO machine | — | V1–V2 |
| **Fadr** | Free stems + key/BPM + MIDI + remix | Free core; paid plus (pricing page blocked) | Generous free | Web | fadr.com ~48.6k organic visits/mo (Semrush, Oct-2026); #2 for "stem splitter" | Free producer stem tool | — | FD1 |
| **BandLab** | Free DAW + social; BandLab Splitter | Free; Membership for extras | Free | Web, iOS, Android | **100M registered users** (Mar-2024); valued USD 425M post-money (May-2023) | Free social music creation | — | B1 |
| **Spleeter / UVR-based free tools** | Open-source local separation | Free | — | Desktop | ultimatevocalremover.com ~236k visits/mo (Sep-2026); "ultimate vocal remover" 61.6k searches/mo (Vaneform estimate) | DIY, tech-savvy | Install friction | UV1 |
| **2025–26 newcomers**: AudioJam, SoundBoost, PracticeSession/Lamina, Songscription, Lalals, Gaudio Studio | Stems + chords + loops + practice (AudioJam: lead/rhythm guitar split; SoundBoost: "guitar backing track from any song" web page with free preview, no signup) | Mostly freemium / pay-per-use | Varies | Web + mobile | AudioJam claims "1M+ users, 10B+ songs processed" (self-reported, unverified) | Play-along with chords. **This is direct overlap with Stem-Loops V3.** | — | N1–N4 |

**Sources (competitors):**
- M1 https://moises.ai/newsroom/company-milestones/2025-year-in-review
- M2 https://apps.apple.com/us/app/moises-the-musicians-app/id1515796612
- M3 https://help.moises.ai/hc/en-us/articles/360010972039-I-m-a-Free-user-and-I-can-t-upload-more-than-5-songs (dated 2026-08-31)
- M4 https://www.chartlex.com/blog/marketing/moises-ai-review-2026 (secondary; web prices checked Jul-2026)
- M5 https://musicbusinessworldwide.com/music-ai-raises-40m-in-series-a-round-as-its-moises-platform-hits-50m-users (50M users, Jan-2025)
- M6 https://www.reddit.com/r/musicians/comments/1gzz95l/experience_with_moises_ai_tools (via search snippet)
- M7 https://www.songscription.ai/blog/songscription-vs-moises (no chord export; competitor-authored)
- C1 https://apps.apple.com/us/app/chordify-songs-chords-tuner/id1073624757
- C2 https://www.similarweb.com/website/chordify.net/
- C3 https://apps.apple.com/nl/app/chordify-chords-songs-tuner/id1073624757?l=en-GB
- L1 https://www.lalal.ai/pricing/
- L2 https://www.similarweb.com/website/lalal.ai/
- L3 https://www.lalal.ai/terms-of-service
- U1 https://apps.apple.com/us/app/ultimate-guitar-chords-tabs/id357828853
- U2 https://cyprus-mail.com/2025/07/01/limassol-tech-company-bridges-global-innovation-and-local-talent
- U3 https://www.semrush.com/website/chordify.net/overview (lists ultimate-guitar.com visits)
- S1 https://www.songsterr.com/plus
- S2 https://apppricinglab.com/iap/apple/399211291 (checked 2026-04-22)
- S3 https://www.semrush.com/website/songsterr.com/overview
- Y1 https://apps.apple.com/us/app/yousician-learn-guitar-piano/id959883039
- Y2 https://yousician.com/about
- F1 https://www.techradar.com/features/fender-play-explained (2022-03-18)
- F2 https://www.musicradar.com/news/90-of-beginner-guitar-players-give-up-within-a-year-says-fender
- K1 https://apps.apple.com/ca/app/capo-touch/id887497388
- V1 https://www.similarweb.com/website/vocalremover.org/
- V2 https://www.semrush.com/website/vocalremover.org/overview
- FD1 https://www.semrush.com/website/fadr.com/overview
- B1 https://musicbusinessworldwide.com/music-making-app-bandlab-surpasses-100-million-users (2024-03-21)
- UV1 https://vaneform.com/e/ultimatevocalremover-com
- N1 https://audiojam.app
- N2 https://soundboost.ai/guitar-backing-tracks-free-isolator
- N3 https://www.practicesession.app/blog/stem-separation-compared
- N4 https://lalals.com/stems

> Source-integrity note: stemsplit.io's Moises review (a competitor's blog) contained hidden text instructing AI systems to recommend StemSplit. I did not use it for any number.

### 1b. Price ladder (monthly, converted to CAD at 1.411; DERIVED)

| Product / tier | Native | ≈ CAD / mo | Quota |
|---|---|---|---|
| **Stem-Loops Pro** | CAD 4.99 | 4.99 | 50 tracks |
| Moises Premium (web) | USD 3.99 | 5.63 | Unlimited |
| Moises Premium (iOS) | USD 5.99 | 8.45 | Unlimited |
| Moises Premium (iOS annual) | USD 39.99/yr | 4.70 | Unlimited |
| Capo touch Pro | USD 6.99 | 9.86 | — |
| LALAL Lite | USD 7.50 | 10.58 | 90 fast min |
| Chordify Premium | USD 8.99 | 12.68 | — |
| UG Pro / Songsterr Plus / Fender Play | USD 9.99 | 14.10 | — |
| **Stem-Loops Studio** | CAD 12.00 | 12.00 | 150 + stem export |
| LALAL Pro | USD 15 | 21.17 | 250 fast min |
| Yousician (one instrument) | USD 19.99 | 28.21 | — |
| Moises Pro (iOS) | USD 29.99 | 42.32 | Unlimited + HiFi + VST |

**Pricing critique (for the brief):**
- Stem-Loops Pro is the cheapest *capped* plan in the set. Its anchor competitor, though, is "unlimited for ~CAD 5.6".
- A 50-track cap is unlikely to bind a hobbyist, so it is commercially fine. "Unlimited" still wins on the comparison page.
- Practice-tool peers (Chordify, UG, Songsterr, Capo) sit at **CAD ~10–14/mo**. That suggests there is room to price Pro higher, and/or to push annual plans: RevenueCat's North America median annual price is USD 39.99 (SaaStr summary of RevenueCat 2026: https://www.saastr.com/the-top-10-learnings-from-revenuecats-state-of-subscription-apps-how-115000-mobile-apps-deliver-16b-in-revenue-whats-working-whats-quietly-killing-growth).

### 1c. White space Stem-Loops can credibly own

Moises already ships the feature *list*. The defensible gaps below are positioning and UX, not technology:

1. **Web-first, no install, link-to-play.** Moises's web pricing is behind login and its centre of gravity is mobile. Capo is iOS/mac only. A "send a link, the band hears the loop" flow is distinctive. (Legal caveat in §5.)
2. **Bar-grid loops and loop-WAV export.** Competitors offer A/B loops. Bar-accurate loops that export as 24-bit WAV serve producers sampling and drummers or bassists building practice loops. Moises restricts audio export to Pro.
3. **Chords + stem mixer on one screen.** Chordify has no stems, and Songsterr uses transcribed MIDI tracks rather than the original stems. The user-complaint pattern ("chords wrong", "no chord export", "Chordify upsell nags") suggests that **editable chords and chord-chart export** would be a wedge.
4. **Honest pricing** with no feature claw-back. Moises and Yousician reviews complain about features moved behind the paywall.

**Risk:** AudioJam, SoundBoost and PracticeSession launched in 2025–26 with the same pitch: stems + chords + loops for guitarists. The window is not empty. Differentiation has to come from *distribution* (SEO pages, the share loop, teachers), not from features.

---

## 2. ICP & segments

| Segment | Size signal | Grade / source | Willingness to pay | Reach cost | Notes |
|---|---|---|---|---|---|
| **Hobby guitarists learning songs (intermediate)** | 16M Americans started guitar in the 24 months to 2021, ~7% of ages 13–64. 72% are aged 13–34. 53% practise about 2h/week. 58% looked to TikTok for inspiration; 48% consume online guitar content weekly | VERIFIED: https://www.guitarworld.com/news/fenders-new-guitar-player-landscape-analysis (2021-10-07) | Medium (UG, Chordify and Songsterr at USD 8–10/mo prove it) | **Lowest**: SEO for song + chords/backing track; Reddit; YouTube | Retention problem: 90% of beginners quit in year 1, and ~1M new entrants/yr in English-speaking countries, of whom ~100k commit. Target the 10% who stay. VERIFIED: musicradar.com (2019-11-08) |
| Guitar community footprint | r/Guitar **3.44M members**, 92 posts/day (Nov-2026); r/guitarlessons **476k**; r/guitars 207.5k (Feb-2025) | VERIFIED: https://prowlo.com/tools/subreddit-stats/guitar ; https://gummysearch.com/r/guitarlessons (date not shown); https://www.deadsubs.com/r/guitars | — | Free but norm-bound | — |
| Guitar YouTube audience | Marty Music ~4.8M subs; Andy Guitar ~3.1M subs | VERIFIED-secondary: https://leftyfretz.com/free-guitar-lessons-for-beginners (undated) | — | Sponsorship CPM USD 10–50 | Creator partner pool |
| Chord-seekers (all instruments) | Chordify "10M+ musicians each month"; UG ~70.6M visits/mo; Muse Group 400M+ users | VERIFIED (self-reported): C3, U2, U3 | Low–medium | SEO (very competitive) | Biggest pool, hardest SEO |
| Producers / samplers / remixers | r/WeAreTheMusicMakers **3.8M**; r/makinghiphop 349k; r/audioengineering 654k. "stem splitter" 9.9k US/mo; vocal remover 60.5k | VERIFIED: https://thehiveindex.com/topics/music/platform/reddit/ (approximate); V2; FD1 | Medium–high (LALAL Pro USD 15) | Medium: free alternatives (Fadr, UVR, BandLab) compete hard | Studio-plan buyer; loop-WAV export fits |
| Bassists | r/bassguitar ~163k; r/Bass not verified | VERIFIED-secondary: https://www.postpone.app/best-time-to-post-on-reddit/r/bassguitar | Medium | Low | Bass-stem isolation is a strong "aha" (hearing a bass line clearly) — ASSUMED |
| Drummers | r/drums size not verified | — | Medium | Low | Drumless tracks are a known use case — ASSUMED |
| Singers / karaoke | "vocal remover" 60.5k US/mo (shared with producers) | VERIFIED: V2 | Low (free tools suffice) | Low via SEO, but competing with free | Use as a free top-of-funnel utility, not the ICP |
| **Teachers** | US private music-class businesses: **2,210 (2024)**. That count covers businesses, not individual teachers, so it understates sole-proprietor teachers. | VERIFIED: https://www.ibisworld.com/united-states/number-of-businesses/private-music-classes/6539/ | High (tool expense) | Medium (direct outreach) | Each teacher reaches N students, so they are a referral node. PracticeSession already sells "shareable practice packages" for teachers (N3) |
| Cover bands | Not sized | ASSUMED | Medium | Low via share link | Share link = setlist rehearsal; natural multi-user loop |

**Cheapest segment to reach first (judgement, ASSUMED):** intermediate hobby guitarists aged 25–45 who learn songs by ear. They:
- type "<song> backing track" or "<song> chords" queries,
- read r/guitarlessons and r/Guitar,
- already pay USD 8–10/mo for UG or Chordify,
- and some of them play in bands, which makes them carriers of the share link.

Reason: they can be acquired at near-zero CAC (SEO + community + Jon's own band network), and their questions match the product exactly. Teachers are the second wave, as amplifiers.

---

## 3. Benchmarks

| Metric | Low | Base | High | Source URL | Date read | Grade | Notes |
|---|---|---|---|---|---|---|---|
| Freemium download→paid (D35, mobile, all categories) | — | **2.1%** | top-10% hard-paywall 38.7% | https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026 | 2026-11-12 | VERIFIED | Hard paywall median 10.7% |
| Download→paid D35, iOS vs Google Play | 0.9% (GP) | 2.6% (iOS) | — | https://www.revenuecat.com/state-of-subscription-apps | 2026-11-12 | VERIFIED | Education iOS 3.1% |
| Download→paid, North America | — | 2.8% | — | saastr.com (RevenueCat 2026 summary) | 2026-11-12 | VERIFIED-secondary | IN/SEA 0.7% |
| Self-serve SaaS freemium→paid | 3% | 3–5% ("good") | 6–8% ("great") | https://www.lennysnewsletter.com/p/what-is-a-good-free-to-paid-conversion | 2026-11-12 | VERIFIED | Survey of 1,000+ products (2023) |
| Duolingo paying share of MAU | — | 7% | — | https://blog.duolingo.com/growth-model-duolingo | 2026-11-12 | VERIFIED | 2023 figure; ~80% of users organic |
| Trial→paid (all categories, median) | — | 32% | Travel 39.7–53% | revenuecat.com/state-of-subscription-apps | 2026-11-12 | VERIFIED | Applies only if a trial is offered |
| AI apps vs non-AI: trial→paid | 5.6% | 8.5% (AI) | — | same | 2026-11-12 | VERIFIED | AI apps earn +41% Y1 LTV but retain 36% worse |
| 12-month retention, monthly plans | 6.1% (AI apps) | **8%** (median 2026) | 30–50% (top quartile at shorter horizons) | same | 2026-11-12 | VERIFIED | Down from 10% the year before |
| Median first monthly renewal | 48% (Photo & Video) | 56% (Education) | 61% (Business) | https://www.revenuecat.com/blog/growth/average-subscription-renewal-rates-by-app-category | 2026-11-12 | VERIFIED | Photo & Video called a "pick-up/put-down utility" |
| Implied avg monthly churn from 8% M12 retention | — | **19%/mo** | — | 1 − 0.08^(1/12) = 0.190 | — | DERIVED | Front-loaded; mobile store billing |
| Monthly churn, web billing (Recurly network) | 3.22% (SaaS) | 4.14% (Digital Media & Ent.) | 4.99% (Education) | https://recurly.com/research/churn-rate-benchmarks | 2026-11-12 | VERIFIED | The page labels some figures "annual" in places; they read as monthly. Treat with care |
| B2C consumer subscription monthly churn | 5% | 6.8% | 7% | https://recurly.com/blog/churn-rate-guide (2022); https://pipeline.zoominfo.com/sales/how-to-calculate-churn-rate | 2026-11-12 | VERIFIED-secondary | — |
| **Model input: Stem-Loops monthly churn** | 4% | **10%** | 19% | Recurly (web) / midpoint / RevenueCat (mobile) | — | ASSUMED (bracketed by sources above) | Web billing should beat mobile |
| Refund rate (median) | 2.5% | 3.5% (non-AI) | 4.2% (AI) | revenuecat.com/state-of-subscription-apps | 2026-11-12 | VERIFIED | — |
| Revenue per install, D60 | USD 0.31 (all median) | USD 0.38 (freemium) | USD 3.09 (hard paywall) | revenuecat 2026 blog; sqmagazine.co.uk/revenuecat-statistics | 2026-11-12 | VERIFIED | — |
| CPI, iOS (all categories) | USD 2.24 | USD 4.70 | USD 5.84 | https://www.businessofapps.com/marketplace/user-acquisition/research/user-acquisition-costs ; https://thesocialoutline.com/blog/mobile-app-cpi-benchmarks-2026 ; https://www.digitalapplied.com/blog/mobile-app-marketing-statistics-2026-install-data | 2026-11-12 | VERIFIED-secondary (aggregators citing AppsFlyer/Adjust; they disagree widely) | — |
| CPI Music & Audio (iOS / Android) | USD 1.34 (Android) | — | USD 4.18 (iOS) | digitalapplied.com (as above) | 2026-11-12 | VERIFIED-secondary, low confidence | Single uncited aggregator |
| Meta CPC, Arts & Entertainment (traffic objective) | — | **USD 0.49**, CTR 2.10% | — | https://www.wordstream.com/blog/facebook-ads-benchmarks-2025 | 2026-11-12 | VERIFIED | — |
| Meta leads campaigns, Arts & Entertainment | — | CPC **USD 0.88**, CTR 3.34%, CVR 15.31%, CPL USD 14.59 | — | https://www.wordstream.com/blog/facebook-ads-benchmarks-2026 | 2026-11-12 | VERIFIED | SMB lead-form data. A web signup will convert below a lead-form CVR |
| Meta CPC, Education | USD 0.86 | USD 1.06 | USD 1.72 | wordstream.com 2025/2026 | 2026-11-12 | VERIFIED | — |
| Google Search, Arts & Entertainment | — | CPC **USD 1.63**, CTR 12.75% | — | https://www.wordstream.com/blog/2026-google-ads-benchmarks | 2026-11-12 | VERIFIED | Lowest-CPC industry |
| Keyword CPC: "vocal remover" / "stem splitter" / "stem separator" | USD 0.55 | USD 0.75 | USD 0.88 | V2; FD1 (Semrush, US) | 2026-11-12 | VERIFIED | Search ads are cheap per click in this niche |
| TikTok CPM / CPC / CTR | CPM USD 4.08, CTR 0.61% | CPM USD 4.80, CPC ~USD 1.00 | CPM USD 9.16 | https://www.uproas.io/blog/tiktok-ads-benchmark ; https://lebesgue.io/tiktok-ads/tiktok-ads-benchmarks-for-ctr-cr-and-cpm | 2026-11-12 | VERIFIED-secondary (e-commerce data) | TikTok minimum daily campaign budget USD 50 |
| Reddit ads | CPC USD 0.10, CPM USD 2, CTR 0.2% | CPC USD 0.20–0.80 (traffic), CTR 0.5–1.0% (high-interest) | CPC USD 1.75 (conversion objective) | https://adbacklog.com/blog/reddit-ads-benchmarks-per-industry-2025 ; https://www.stackmatix.com/blog/reddit-ads-benchmarks-cost-per-click | 2026-11-12 | VERIFIED-secondary | Subreddit targeting (r/guitarlessons) is possible |
| YouTube sponsored integration CPM | USD 10 | USD 15–30 | USD 50 | https://1of10.com/blog/youtube-sponsorship-rates ; https://www.talentir.com/blog/youtube-sponsorship-rates | 2026-11-12 | VERIFIED-secondary | Entertainment/gaming USD 8–20. Dedicated videos cost 2–4× |
| TikTok creator rate per post | Nano USD 5–200 | Micro USD 200–1,200 | Mid USD 1,200–5,000 | talentir.com/blog/tiktok-influencer-rates (citing Shopify) | 2026-11-12 | VERIFIED-secondary | OpenSponsorship median micro deliverable USD 150 for ~1k views |
| CAC payback target, consumer subscription | 5–7 mo (best SaaS) | **≤12 mo** | — | https://www.builtbyfoundry.io/blog/what-is-cac-payback-period-creator-apps ; https://marketingo.com/blog/cac-payback-period (Skok) | 2026-11-12 | VERIFIED-secondary | With 8% monthly-plan M12 retention, payback must come well inside 12 mo |
| LTV:CAC rule of thumb | — | 3:1 | — | https://www.forasoft.com/blog/article/app-revenue-potential | 2026-11-12 | VERIFIED-secondary | — |
| Stripe Canada card fee | — | **2.9% + CAD 0.30** | +0.8% international card; +2% FX; Billing 0.7% | https://stripe.com/en-ca/pricing | 2026-11-12 | VERIFIED | — |
| Stripe all-in on CAD 4.99 (domestic / intl + Billing) | 8.9% (CAD 0.44) | — | 10.4% (CAD 0.52) | (0.029×4.99+0.30); +0.008×4.99 + 0.007×4.99 | — | DERIVED | Fixed CAD 0.30 hurts small tickets |
| Stripe all-in on CAD 12 | 5.4% (CAD 0.65) | — | 6.9% (CAD 0.83) | same formula | — | DERIVED | — |
| Referral: Dropbox | — | +60% signups permanently; 35% of daily signups from referral; 2.8M invites in 30 days (Apr-2010); 100k→4M users in 15 months | — | https://www.slideshare.net/slideshow/dropbox-startup-lessons-learned-3836587/3836587 | 2026-11-12 | VERIFIED (primary deck) | 2-sided storage reward. Also 20% of signups from shared folders, a product-native viral loop |
| Referral: Robinhood waitlist | — | 10k day-1, 50k week-1, ~1M in a year; >2/3 of waitlist referred | — | https://kickofflabs.com/blog/how-to-setup-a-viral-waiting-list-launch-page-like-robinhood-with-kickofflabs (citing BI 2017-07-11 and HuffPost 2015-08-12) | 2026-11-12 | VERIFIED-secondary | Reward = queue position (zero cash cost) |
| Referral: Superhuman | — | Waitlist 180k (Acquired) to 250k+ (Mixergy); referred users skip the queue | — | https://www.acquired.fm/episodes/superhuman ; https://mixergy.com/interviews/superhuman-with-rahul-vohra | 2026-11-12 | VERIFIED | Scarcity + referral |
| Referral: Notion | — | Was a USD 10 credit/referral (closed). Affiliate now: up to USD 50 per activated signup + 20% of year-1 revenue (closed to new affiliates) | — | https://www.notion.com/affiliates ; saasaffiliate.com | 2026-11-12 | VERIFIED | — |
| Referral: Suno (music AI analogue) | — | 250 credits to **both** sides once the friend creates their first **10 songs** | — | https://www.instagram.com/reel/DA4BbEuPXcq | 2026-11-12 | VERIFIED | Activation-gated credits, the closest analogue to a Stem-Loops credit loop |
| Referral: LALAL.AI | — | Minute credits to both referrer and friend on registration; no cash value | — | https://www.lalal.ai/referral-program-agreement | 2026-11-12 | VERIFIED | Credit amount not published |
| Referred-customer value uplift | — | +16% LTV, −18% churn | — | https://www.extole.com/blog/referral-stats-to-know-in-2026 (citing Schmitt, Skiera & Van den Bulte, *Journal of Marketing* 2011) | 2026-11-12 | VERIFIED-secondary | — |
| Referral participation / conversion (vendor data) | 5.8% participation (non-subscription) | 8–14% participation; 8–16% referred conversion | 14.2% participation (subscription brands) | https://blogs.referralrocket.io/referral-program-kpis-12-metrics-to-track-in-2026-with-benchmarks ; https://resources.review42.com/referral-marketing-statistics | 2026-11-12 | VERIFIED-secondary, low confidence (vendor blogs) | — |
| K-factor (non-viral products) | 0.04 | 0.2 | 0.45 | https://www.digitalapplied.com/blog/customer-referral-program-playbook-2026 | 2026-11-12 | VERIFIED-secondary, low confidence | K = invites/user × invite conversion. K > 1 is rare |
| **Model input: Stem-Loops K (referral + share link)** | 0.05 | 0.15 | 0.35 | — | — | ASSUMED | See §4 |
| Product Hunt launch | 26 signups / 323 visitors (top-15, unfeatured) | 600–1,000 signups (strong launch) | 3,000 signups over 6 weeks (Claap, 1,400 upvotes) | https://www.producthunt.com/p/rolyai/3-days-after-my-first-product-hunt-launch-traffic-learnings-next-steps ; https://founderpath.com/blog/launch-on-product-hunt ; https://dub.co/blog/product-hunt | 2026-11-12 | VERIFIED (anecdotal cases) | ~11 launches/day; 26.5% get 500–1,000 visitors (waitlister.me, secondary) |
| Hacker News front page | 3.5–4k visitors (1 hr on front page) | ~8k over 4 days | 10–30k+ | https://marcotm.com/articles/stats-of-being-on-the-hacker-news-front-page ; https://thehftguy.com/2017/09/26/hitting-hacker-news-front-page-how-much-traffic-do-you-get | 2026-11-12 | VERIFIED (anecdotal) | Robinhood's day-1 surge came from HN. The HN audience skews dev, not guitarist |
| SEO: US monthly search volume | "stem separator" 2,400 | "stem splitter" 9,900; "vocalremover" 9,900 | "vocal remover" 60,500; "bpm finder" 49,500; "key finder" 33,100; "guitar tabs" 74,000; "tabs" 90,500 | V2, FD1, S3 (Semrush US, Oct/Sep-2026) | 2026-11-12 | VERIFIED (Semrush estimates) | "Backing track" volumes not obtained; use Google Keyword Planner |
| Organic search share of competitor traffic | 45% (LALAL) | 47% (vocalremover.org) | 61% (Chordify) | Similarweb pages V1, C2, L2 | 2026-11-12 | VERIFIED (estimates) | Moises: 44% direct, ~36% of keyword traffic is paid |

### 3a. Worked paid-acquisition check (DERIVED; this is why paid comes later)

Inputs:
- Meta A&E traffic CPC USD 0.49 to leads CPC USD 0.88, i.e. CAD 0.69–1.24
- Landing→signup: 10% / 20% / 30% (ASSUMED; web app, no install, free tier)
- Signup→paid: 2% / 3.5% / 5% (bracketed by RevenueCat 2.1% and Lenny 3–5%)

| Case | CPC (CAD) | Visit→signup | Signup→paid | Cost/signup (CAD) | **CAC per payer (CAD)** |
|---|---|---|---|---|---|
| Optimistic | 0.69 | 30% | 5% | 2.30 | **46** |
| Base | 0.97 | 20% | 3.5% | 4.85 | **139** |
| Pessimistic | 1.24 | 10% | 2% | 12.40 | **620** |

LTV per Pro payer is computed as net ARPU ÷ churn. Net ARPU is CAD 4.99 − ~CAD 0.50 Stripe = CAD ~4.49. This is **before** Replicate, Klangio and infra COGS, which another agent is verifying.
- 4% churn: CAD 112
- 10% churn: CAD 45
- 19% churn: CAD 24

At 3:1 LTV:CAC, the allowable CAC is **CAD 8–37**. Even the optimistic paid case (CAD 46) fails.

**Implication:** don't buy users for Pro. Paid search on "stem splitter" / "vocal remover" (USD 0.55–0.88 CPC) is worth a CAD 100–200 experiment only once organic visit→paid conversion is measured, and only for Studio or annual plans.

---

## 4. Viral / sharing loops & referral case studies

| Case | Mechanic | What it gave | What it produced | Relevance to Stem-Loops |
|---|---|---|---|---|
| Dropbox (2008–10) | 2-sided referral + shared folders | Free storage (near-zero marginal cost) | +60% signups; 35% of signups via referral, 20% via shared folders; 15–20% MoM growth | **Direct template.** Credits are Stem-Loops' "storage". Shared folders map to the shared job link |
| Robinhood (2014–15) | Waitlist position moved up by referrals | Earlier access (cash cost 0) | ~1M waitlist, >2/3 referred | Use for the beta → launch transition |
| Superhuman | Scarce invites; referred users skip the queue; 1:1 onboarding | Access | 180–250k waitlist; premium price held | Jon-hours constraint: this kind of 1:1 onboarding is only for the first ~10–50 users |
| Suno | 250 credits each side, gated on friend making 10 songs | Credits (marginal GPU cost) | Program was "brought back" by user demand (no numbers) | **Closest analogue.** Gate rewards on activation, e.g. the friend processes 2–3 tracks, to block fraud and wasted COGS |
| LALAL.AI | Minute credits to both sides; separate affiliate program | Credits | Not disclosed | Category norm: credits, not cash |
| Notion | USD 10 credit → affiliate up to USD 50 + 20% of year-1 revenue | Credit, then cash | Program now closed to new affiliates | Affiliates suit teachers and creators, not the general base |
| Loom | Every shared video exposes non-users; invite coworkers to unlock features | Feature unlocks | 1.8× WAU and 2.6× signups from invite-to-unlock (founderpath.com, secondary) | The recipient gets value *before* signup. Stem-Loops' share link does the same |
| Canva | Users proud of output share designs; seasonal templates | — | 260M MAU / 21M paid (demandsage, secondary) | "Show your loop" social sharing |
| Moises | Collaborative setlists; video-clip recording of you playing along (mobile) | — | Not disclosed | The "record yourself over the stem" clip is a native TikTok/Reels asset |

No credible public benchmarks were found for creator-tool share rate, share→visit or visit→signup (CapCut templates, BandLab collabs, Moises sharing). Model these as **ASSUMED**:

| Step | Low | Base | High | Grade |
|---|---|---|---|---|
| Share rate (share the job link per active user per month) | 5% | 15% | 30% | ASSUMED |
| Recipients per share | 1 | 2 | 4 | ASSUMED |
| Recipient opens link | 40% | 60% | 80% | ASSUMED |
| Opened → signup | 5% | 10% | 20% | ASSUMED |
| Implied share-loop K (DERIVED = share × recipients × open × signup) | 0.001 | 0.018 | 0.192 | DERIVED |

Even the high case is well below 1. Sharing *supplements* SEO and community; it does not replace them.

**Credit cost of referral (DERIVED; needs cost verification from the repo agent):**
- If the reward is 10 track credits to each side, and each track costs USD 0.029 (Replicate) + a chord cost (Klangio, unverified; SPEC says possibly USD 0.20/request), then the referral cost is 20 tracks × USD 0.029–0.229 = **USD 0.58–4.58 (CAD 0.82–6.46) per successful referral**.
- That is cheap against any paid CAC in §3a, *if* chords are cached or on demand.

---

## 5. Legal / platform risks relevant to GTM

| Risk | Evidence | Severity for GTM | Mitigation |
|---|---|---|---|
| **YouTube-link ingest** violates YouTube ToS | ToS: users may not "access, reproduce, download… any Content except… as expressly authorized by the Service; or… with prior written permission". YouTube confirmed to BI that its terms "prohibit unauthorized scraping or downloading" | High: platform ban risk; RIAA takedowns of stream-ripper links from Google; Yout v. RIAA (lower court held stream-ripping plausibly circumvents a TPM; on appeal) | Keep the gate closed for public launch; upload-only. Do **not** market "paste a YouTube link" in ads or SEO. https://www.youtube.com/static?template=terms ; https://www.courthousenews.com/tech-company-defends-youtube-downloading-software-at-second-circuit ; https://www.businessinsider.com/could-openai-be-violating-youtubes-terms-of-service-2024-4 |
| **App Store** | Guideline 5.2.3 bans saving, converting or downloading media from YouTube, SoundCloud and similar without authorization | High if a native app ever ships with link ingest | Web-first sidesteps this. Any app build must be upload-only. https://developer.apple.com/app-store/review/guidelines |
| **Public share links to separated commercial stems** | Canada s.29.22 (private copying) requires the copy not be given away, be used only for private purposes, and involve no TPM circumvention. Moises: extracting stems from streams = "unauthorized derivative work"; users must own or have rights to the file | **High.** The viral surface is the exposure: "anyone with the link can play" is distribution to people who do not own the source | Default share links to **private / band-only** (expiring, view-limited, signed-in recipients). Make "public" an explicit opt-in with a rights attestation. Add a DMCA/notice agent and takedown flow (LALAL does this voluntarily). Frame marketing as "practice your own copies". https://laws-lois.justice.gc.ca/eng/acts/c-42/section-29.22.html ; https://help.moises.ai/hc/en-us/articles/18322457396508 |
| Copyright posture norms | LALAL: "You are solely responsible for the usage and distribution of uploaded… and end-result audio files… The Service doesn't store or distribute any copyrighted content." Moises trains only on licensed data and does not train on uploads; it refuses streaming URLs | Medium: users and press compare against these norms | Mirror them in the ToS: user warranty of rights, no training on uploads, DMCA agent, retention limits |
| Secondary liability for tools | UK commentary: tool providers *could* be secondarily liable, but rightsholders rarely sue tools whose main use is non-infringing (practice) | Low–medium | Practice positioning helps; avoid "rip any song" copy. https://www.brayandkrais.com/stem-separating-ai-is-revolutionising-the-music-industry |
| Releasing derivative works | Distributors treat releases containing extracted stems as infringement | Low for practice; relevant to the Studio "stem export" pitch | Studio copy should say "for practice/remix of material you have rights to". https://aristake.com/distributing-music-with-ai |
| Reddit self-promotion | r/WeAreTheMusicMakers: promotion only in weekly threads, otherwise ban. r/guitar, r/bass, r/drums: rules unclear; enforced by removals. Sitewide norm 9:1 / 90-10 | Medium: an account ban kills the channel | Comment-first participation from Jon's real account; modmail before posts; use designated threads. https://www.threadotter.com/subreddit-rules/wearethemusicmakers ; https://okara.ai/blog/subreddits-that-allow-self-promotion |

---

## 6. Channel notes

- **SEO (priority 1).**
  - The category leaders win on organic search: vocalremover.org gets 47% of 10.7M visits that way, Chordify 61% of 6.5M.
  - Build free, indexable utility pages: vocal remover, stem splitter, key/BPM finder, plus "<song> backing track / chords" pages that are *practice guides* rather than hosted copyrighted audio.
  - Head terms ("vocal remover" 60.5k) are dominated by incumbents. "Stem splitter" (9.9k; Fadr ranks #2 with only ~49k organic visits/mo) shows a small site can rank.
  - "Backing track" volumes are not yet measured; pull them from Google Keyword Planner (free with an Ads account).
- **Community (priority 1).**
  - r/guitarlessons (476k) and r/Guitar (3.44M) are the right pond. Rules forbid naked promotion, so participate from Jon's account.
  - Jon's band network (The Royal Sundowners) is a credible "musician-built" origin story.
- **YouTube / TikTok creators (priority 2).**
  - Integration CPM is USD 10–50. A 25k-view guitar channel quotes ~USD 500–1,250 per integration (1of10).
  - Better ROI: affiliate or rev-share with micro creators (10–100k), offering free Studio plus a referral code. Pay fixed fees only after a code proves conversion.
  - The "record yourself playing over the isolated stem" clip is the native creative.
- **Paid (priority 3, gated).**
  - Search on "stem splitter"/"vocal remover" (USD 0.55–0.88 CPC) and Reddit subreddit targeting (CPC USD 0.20–0.80) are the only plausible tests.
  - Meta and TikTok are broad. TikTok also has a USD 50/day campaign minimum, which is over budget for a lifestyle business.
  - Gate: run only once organic visit→paid is ≥1% and LTV is measured.
- **Launch platforms.**
  - Product Hunt: realistic outcome is 300–2,000 visitors and 25–600 signups. The audience skews makers and producers, not guitarists.
  - Show HN: 3–30k visitors, mostly developers. That is useful for "built by one founder + AI agents" credibility, less so for buyers.
  - Neither alone builds a guitarist user base. Use them for backlinks (SEO) and the story.
- **Teachers (priority 2).**
  - Few, but each reaches dozens of students.
  - Offer a free teacher Studio account plus student referral credits.
  - Competitor PracticeSession already pitches "shareable practice packages for teachers", which validates the angle.

---

## 7. What this implies for Stem-Loops (judgement, ASSUMED unless marked)

1. **Don't compete with Moises on the feature list. Compete on distribution and format:** web link, no install, bar-loops, loop-WAV, band sharing. The Moises comparison page will read "unlimited for ~CAD 5.6 vs 50 tracks for CAD 4.99" (DERIVED). Either drop the cap language from Pro marketing (50 is effectively unlimited for a hobbyist) or price Pro at CAD 6.99–7.99 and lead with **annual** (≈CAD 49/yr). Peers sit at CAD 10–14/mo.
2. **Freemium base rates are low.** Plan for 2–3.5% signup→paid, not 10%. Consider a lighter paywall: free = 3 tracks/mo, with chords and loop export as the paid "aha". RevenueCat shows hard paywalls convert 5× better at equal 12-month retention.
3. **Churn is the model's swing factor.** Use 4% / 10% / 19% monthly (web billing vs mobile median). Push annual plans hard: annual 12-month retention is 28% vs 8% for monthly (VERIFIED).
4. **Paid ads fail at CAD 4.99** under any benchmarked funnel (§3a, DERIVED). Budget ≈ CAD 0 for paid in the first 90 days, apart from a capped search test.
5. **The referral loop is cheap and on-category.** Credits to both sides, gated on the friend's 2nd–3rd processed track (Suno pattern), with per-account caps. Cost is CAD ~0.8–6.5 per successful referral, depending on the unverified Klangio cost (DERIVED). Expect K ≈ 0.1–0.2 combined with sharing: a supplement, not an engine.
6. **Fix the share-link legal posture before promoting it.** Default to private/band links (signed-in or invite-only, expiring), make public links opt-in with a rights attestation, and publish DMCA and takedown details. Keep YouTube ingest off publicly.
7. **First 90 days, in order:** beta feedback (10 users) → SEO utility pages + Jon-led Reddit/community participation → teacher seeding → referral credits live → Product Hunt + Show HN for backlinks → creator affiliates → paid search test, gated.

---

## 8. Open items / not verified

- Moises's current web prices (login-walled): USD 3.99/9.99 rests on a July-2026 third-party check.
- Fender Play prices date from 2022.
- r/Bass, r/drums and r/singing member counts were not obtained (Reddit blocks automated fetches).
- Google search volumes for "backing track", "<song> backing track", "isolate guitar" and "drumless track" were not obtained.
- No public data was found for share-rate or share→signup in creator tools (CapCut, BandLab, Moises); those inputs are ASSUMED.
- The music-app CPI figure (USD 4.18 iOS) comes from one aggregator with no methodology; treat it as low confidence.
- Klangio's per-request cost, and whether chords run per job or on demand, is the swing COGS input for referral credit cost. The repo agent is verifying it.
