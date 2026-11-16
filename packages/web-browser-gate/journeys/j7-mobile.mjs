// J7 — mobile viewports 390×844 and 360×800 (deviceScaleFactor 1, touch) on the landing,
// the job page while processing, and the player: no horizontal scroll, interactive controls
// at least 44 px in both dimensions, chord chips readable (font ≥ 11 px, label not clipped).
//
// TWO CARVE-OUTS FROM THE 44 px RULE, both stated here so neither is silent:
//
//  1. INLINE LINKS IN RUNNING TEXT (WCAG 2.5.8's own inline exception: a target in a
//     sentence is sized by the line of non-target text around it). The rule was already
//     here, but it only recognised <p>. The app writes running text in <dd> too — the
//     landing's "you create an account on the <a>sign-in page</a>" is in a spec-row <dd>
//     — so a legitimately inline link was being measured as a standalone control, and
//     padding it to 44 px would overlap the lines above and below it. The app's own
//     standard says the same (src/styles/loops-page.css: "inline links inside running
//     text keep the line box (the 44px hit area is for standalone links)"), and
//     .jp-back, a STANDALONE link, is sized to 44 px, not exempted.
//     The exception is kept as narrow as the evidence: <p> and <dd>, the two elements
//     the app actually writes running text in, and only while the link is still an
//     inline box. Without that last condition the exception would also swallow a
//     button-shaped link (inline-block or flex) that happens to sit inside a
//     paragraph — which is a standalone control and must meet 44 px.
//
//  2. CHORD CELLS — the chord timeline's chips ([data-testid^="chord-chip-"]) and the
//     phone chord grid's slots ([data-testid^="phone-slot-"]). Their WIDTH is a drawing
//     of musical time (chip width = duration × zoom; a slot is its share of a bar), not
//     a size the layout chooses: four bars of two chords across a 360 px phone is eight
//     cells of ~40 px, and 44 px each cannot fit. Forcing 44 px would misdraw the music.
//     So width is NOT asserted here; HEIGHT is, because height is the layout's own
//     choice, and the narrowest cell is reported with it. What the width costs is
//     covered elsewhere, not dropped: packages/web-browser-gate/test/chord-chip-fit.test.mjs
//     and chord-phone-view.test.mjs assert in real Chromium that every chord name
//     renders, is legible and is not clipped at these same widths. The open question —
//     whether a ~36 px-wide chord cell is an acceptable tap target on a phone — is a
//     design decision (docs/design/screens-2026-11-15/chords-mobile/DECISION.md), and
//     this journey records the measurement rather than passing a verdict on it.
import { Journey, mintUser, newContext, sleep, uploadViaLanding } from './lib.mjs';

export const id = 'j7-mobile';

const MEASURE = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('.sr-only,[hidden],[aria-hidden="true"]');
  };
  const hscroll = document.documentElement.scrollWidth - window.innerWidth;
  const small = [];
  const chordCells = [];
  const inlineExempt = [];
  let examined = 0;
  for (const el of document.querySelectorAll('main button, main a[href], main input:not([type="hidden"]), main select, main [role="slider"], main [role="button"], header button, header a[href]')) {
    if (!vis(el)) continue;
    // WCAG 2.5.8 inline exception: a link inside a sentence is sized by the line of
    // text (carve-out 1). Three conditions, all required, and the third is what keeps
    // the exception from swallowing a standalone control that merely sits in prose:
    // the element must still BE an inline box, so a button-shaped link (inline-block,
    // flex, grid, block) is measured against 44x44 however it is nested.
    const prose = el.closest('p,dd');
    if (
      el.matches('a') &&
      prose &&
      prose.textContent.trim().length > el.textContent.trim().length + 10 &&
      getComputedStyle(el).display === 'inline'
    ) {
      inlineExempt.push((el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24));
      continue;
    }
    // a native checkbox/radio inside a <label> is sized by its label
    const target = (el.matches('input[type="checkbox"],input[type="radio"],input[type="file"]') && el.closest('label')) || el;
    const r = target.getBoundingClientRect();
    // Carve-out 2: a chord cell's width is musical time. Height is still the layout's
    // choice, so it is checked — by its own check below, not by this one.
    if (el.matches('[data-testid^="chord-chip-"],[data-testid^="phone-slot-"]')) {
      chordCells.push({ name: (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) });
      continue;
    }
    examined += 1;
    if (r.width < 44 || r.height < 44) {
      const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
      small.push(`${name} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
  }
  const wide = [...document.querySelectorAll('main *')].filter((el) => vis(el) && el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest('[data-testid="chord-scroll"],[style*="overflow"]')).slice(0, 5).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} right=${Math.round(el.getBoundingClientRect().right)}`);
  const chips = [...document.querySelectorAll('[data-testid^="chord-chip-"]')].filter(vis).map((el) => {
    const cs = getComputedStyle(el);
    return { font: parseFloat(cs.fontSize), clipped: el.scrollWidth > el.clientWidth + 1, w: Math.round(el.getBoundingClientRect().width), label: el.textContent.trim() };
  });
  return { hscroll, small, wide, chips, chordCells, inlineExempt, examined };
};

async function checkView(j, page, tag, { chips = false } = {}) {
  const m = await page.evaluate(MEASURE);
  await j.shot(page, tag);
  j.check(`${tag}: no horizontal scroll`, m.hscroll <= 0, `overflow=${m.hscroll}px ${m.wide.join('; ')}`);
  // `m.examined` is reported and REQUIRED to be > 0: "all ≥ 44" and "nothing was
  // looked at" are the same sentence otherwise, and a selector that stops matching
  // (a renamed role, a page that did not render) would turn this gate green while
  // measuring nothing. Same bar the chord gate in this package holds itself to
  // ("'0 clipped' cannot be the result of '0 looked at'").
  j.check(
    `${tag}: interactive controls ≥ 44×44`,
    m.examined > 0 && m.small.length === 0,
    `${m.examined} controls measured` +
      (m.inlineExempt.length ? `, ${m.inlineExempt.length} inline-exempt (${m.inlineExempt.slice(0, 4).join(', ')})` : '') +
      (m.chordCells.length ? `, ${m.chordCells.length} chord cells checked separately` : '') +
      (m.examined === 0 ? ' — NOTHING MEASURED, so this says nothing about the page' : '') +
      (m.small.length ? `; ${m.small.length} under 44: ${m.small.slice(0, 12).join(' | ')}` : '; all ≥ 44'),
  );
  if (m.chordCells.length) {
    const short = m.chordCells.filter((c) => c.h < 44);
    const narrowest = m.chordCells.reduce((a, b) => (b.w < a.w ? b : a));
    j.check(
      `${tag}: chord cells ≥ 44 px tall (width is musical time — see the note at the top of j7)`,
      short.length === 0,
      `${m.chordCells.length} cells; heights ${[...new Set(m.chordCells.map((c) => c.h))].sort((a, b) => a - b).join(',')}px; narrowest ${narrowest.w}px (${narrowest.name})` +
        (short.length ? `; UNDER 44 TALL: ${short.slice(0, 6).map((c) => `${c.name} ${c.w}×${c.h}`).join(' | ')}` : ''),
    );
  }
  if (chips) {
    const bad = m.chips.filter((c) => c.font < 11 || (c.clipped && c.label.length > 0));
    j.check(`${tag}: chord chips readable (≥ 11 px, label not clipped)`, m.chips.length > 0 && bad.length === 0, `${m.chips.length} chips; fonts ${[...new Set(m.chips.map((c) => c.font))].join(',')}px; problems: ${bad.slice(0, 5).map((c) => `${c.label}@${c.w}px font ${c.font} clipped=${c.clipped}`).join(' | ') || 'none'}`);
  }
}

export default async function run() {
  const j = new Journey(id, 'Mobile 390×844 and 360×800: player and job page');
  const user = mintUser('j7');
  const { ctx, log } = await newContext({ user, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  try {
    await page.goto('/');
    await checkView(j, page, '390-landing');
    const jid = await uploadViaLanding(page, j);
    await page.locator('[role="progressbar"]').waitFor({ timeout: 30_000 }).catch(() => {});
    await checkView(j, page, '390-job-processing');
    await page.locator('[data-testid="player"][data-phase="ready"]').waitFor({ timeout: 240_000 });
    await page.locator('[data-testid^="chord-chip-"]').first().waitFor({ timeout: 30_000 }).catch(() => {});
    await sleep(500);
    await checkView(j, page, '390-player', { chips: true });

    await page.setViewportSize({ width: 360, height: 800 });
    await page.reload();
    await page.locator('[data-testid="player"][data-phase="ready"]').waitFor({ timeout: 60_000 });
    await page.locator('[data-testid^="chord-chip-"]').first().waitFor({ timeout: 30_000 }).catch(() => {});
    await sleep(500);
    await checkView(j, page, '360-player', { chips: true });
    await page.goto('/');
    await checkView(j, page, '360-landing');
    await page.goto(`/jobs/${jid}`);
    j.note(`job ${jid}`);
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
    await j.shot(page, 'abort');
  } finally {
    await ctx.close();
  }
  return j.result(log);
}
