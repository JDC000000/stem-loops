/**
 * THE tap-target floor for every chord surface, in CSS px (QA-73).
 *
 * Brand rule ("tap targets >= 24px, primary controls >= 44px") and WCAG 2.5.8.
 * Every chord chip and slot that opens the chord editor is at least this wide
 * and this tall where a finger lands on it:
 *
 *  - the phone stage's chord slots (ChordPhone.helpers.ts, #312);
 *  - the "See all chords" sheet's wrapped rows on phones (QA-68, #324);
 *  - the strip on tablets and desktop (QA-73).
 *
 * It used to be defined twice (ChordPhone.helpers.ts `MIN_TAP_PX` and
 * ChordOverlay.helpers.ts `CHIP_MIN_TAP_PX`). It lives in this leaf module, which
 * imports nothing, so both helpers can import it without a module cycle
 * (ChordPhone.helpers.ts already imports ChordOverlay.helpers.ts).
 *
 * The real-Chromium gate (packages/web-browser-gate/test/chord-sheet-tap.test.mjs)
 * measures against its own literal 24 and fails if this constant is not 24, so
 * the floor cannot be lowered here alone. Primary controls use the 44px
 * `--touch-min` design token, not this number.
 */
export const MIN_TAP_PX = 24;
