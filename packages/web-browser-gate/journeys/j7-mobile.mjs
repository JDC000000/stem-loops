// J7 — mobile viewports 390×844 and 360×800 (deviceScaleFactor 1, touch) on the landing,
// the job page while processing, and the player: no horizontal scroll, interactive controls
// at least 44 px in both dimensions, chord chips readable (font ≥ 11 px, label not clipped).
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
  for (const el of document.querySelectorAll('main button, main a[href], main input:not([type="hidden"]), main select, main [role="slider"], main [role="button"], header button, header a[href]')) {
    if (!vis(el)) continue;
    // WCAG 2.5.8 inline exception: a link inside a sentence is sized by the line of text
    if (el.matches('a') && el.closest('p') && el.closest('p').textContent.trim().length > el.textContent.trim().length + 10) continue;
    // a native checkbox/radio inside a <label> is sized by its label
    const target = (el.matches('input[type="checkbox"],input[type="radio"],input[type="file"]') && el.closest('label')) || el;
    const r = target.getBoundingClientRect();
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
  return { hscroll, small, wide, chips };
};

async function checkView(j, page, tag, { chips = false } = {}) {
  const m = await page.evaluate(MEASURE);
  await j.shot(page, tag);
  j.check(`${tag}: no horizontal scroll`, m.hscroll <= 0, `overflow=${m.hscroll}px ${m.wide.join('; ')}`);
  j.check(`${tag}: interactive controls ≥ 44×44`, m.small.length === 0, m.small.length ? `${m.small.length} under 44: ${m.small.slice(0, 12).join(' | ')}` : 'all ≥ 44');
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
