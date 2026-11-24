# PR #375 screenshots (2026-11-23)

Captured with headless Chromium (Playwright, one process) rendering the real PlayerView (real CSS) at 390x844 and 360x800, mobile+touch, DPR 2; chord fixture play-chords-4m-two-chord-bars.json. Harness: the packages/web-browser-gate chords-mobile-shots approach (bundle of Player.tsx), driven through the UI.

uptime at capture (round 1):  17:28:01 up 10 min,  0 user,  load average: 3.07, 1.82, 0.80

Round 4 (visual): all 14 PNGs regenerated after the header fix (badge no longer squeezes the artist; stepper label one line). Harness /home/claude/s19b/shots/shots.mjs, ONE headless Chromium. uptime at capture:  17:31:19 up 14 min,  0 user,  load average: 3.65, 2.43, 1.23
Artist width before/after (Demo, 390 Capo 2): 15.4 -> 65.6 px; (360 Capo 2): 0 -> 65.6 px; (360 +3): 13.1 -> 65.6 px.

- 01-more-menu-capo-stepper-zero-360x800.png
- 01-more-menu-capo-stepper-zero-390x844.png
- 02-more-menu-capo-2-360x800.png
- 02-more-menu-capo-2-390x844.png
- 03-header-badge-capo-2-360x800.png
- 03-header-badge-capo-2-390x844.png
- 04-see-all-chords-capo-2-360x800.png
- 04-see-all-chords-capo-2-390x844.png
- 05-more-menu-plus-3-360x800.png
- 05-more-menu-plus-3-390x844.png
- 06-header-badge-plus-3-360x800.png
- 06-header-badge-plus-3-390x844.png
- 07-see-all-chords-plus-3-360x800.png
- 07-see-all-chords-plus-3-390x844.png
