// J8 — keyboard and accessibility basics on the upload form and the player:
// tab order, a visible focus indicator on every stop, accessible names on buttons, and an
// axe-core scan (JOURNEY_AXE = path to axe.min.js; without it only the manual checks run).
import { existsSync, readFileSync } from 'node:fs';
import { Journey, mintUser, newContext, uploadViaLanding } from './lib.mjs';

export const id = 'j8-a11y';

/** Press Tab n times; record each focused element's name and whether a focus ring is visible. */
async function tabWalk(page, n) {
  const stops = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab');
    stops.push(
      await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return { name: '(body)', ring: false };
        const cs = getComputedStyle(el);
        const ring =
          (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) ||
          (cs.boxShadow && cs.boxShadow !== 'none');
        const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.id || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
        return { name, id: el.id, tag: el.tagName.toLowerCase(), ring };
      }),
    );
  }
  return stops;
}

async function axe(page, j, tag) {
  const p = process.env.JOURNEY_AXE;
  if (!p || !existsSync(p)) {
    j.step(`${tag}: axe-core scan`, 'not-reached', 'JOURNEY_AXE not set; manual checks only');
    return;
  }
  await page.addScriptTag({ content: readFileSync(p, 'utf8') });
  const res = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes.slice(0, 2).map((x) => x.target.join(' ')).join(' ; ') }));
  });
  const serious = res.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  j.check(`${tag}: axe — no critical/serious violations`, serious.length === 0, serious.map((v) => `${v.id}(${v.impact},${v.n}): ${v.sample}`).join(' | ') || 'none');
  const minor = res.filter((v) => !serious.includes(v));
  if (minor.length) j.step(`${tag}: axe — moderate/minor`, 'info', minor.map((v) => `${v.id}(${v.impact},${v.n})`).join(', '));
}

export default async function run() {
  const j = new Journey(id, 'Keyboard and a11y basics: upload form and player');
  const user = mintUser('j8');
  const { ctx, log } = await newContext({ user });
  const page = await ctx.newPage();
  try {
    // ── upload form ──
    await page.goto('/');
    const lstops = await tabWalk(page, 18);
    const order = lstops.map((s) => s.id || s.name);
    const iFile = order.indexOf('file-btn');
    // narrow screens show an "options" toggle; wide screens show the stem chips inline
    // (the toggle is display:none there), so either is the middle stop.
    const iOpt = order.indexOf('options-toggle') >= 0 ? order.indexOf('options-toggle') : lstops.findIndex((s) => s.tag === 'input');
    const iCta = order.indexOf('cta');
    j.check('upload form: tab reaches Choose a file → stem/length options → Separate and play, in that order', iFile >= 0 && iFile < iOpt && iOpt < iCta, order.join(' → '));
    const noRing = lstops.filter((s) => s.name !== '(body)' && !s.ring);
    j.check('upload form: every tab stop shows a focus indicator', noRing.length === 0, noRing.map((s) => s.name).join(' | ') || 'all visible');
    // keyboard-only file pick: Enter on "Choose a file" opens the native chooser
    await page.locator('#file-btn').focus();
    const chooser = await Promise.all([page.waitForEvent('filechooser', { timeout: 15_000 }), page.keyboard.press('Enter')]).then(([c]) => c, () => null);
    j.check('upload form: Enter on "Choose a file" opens the file chooser', !!chooser, chooser ? '' : `no chooser; focused=${await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName)}`);
    if (chooser) await chooser.setFiles(process.env.JOURNEY_AUDIO);
    else await page.locator('#file').setInputFiles(process.env.JOURNEY_AUDIO); // keep going: the rest of the journey does not depend on the chooser
    await page.waitForFunction(() => document.querySelector('#cta-label')?.textContent === 'Separate and play', null, { timeout: 15_000 });
    const after = await page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent);
    j.step('upload form: focus after picking a file', 'info', String(after));
    await axe(page, j, 'landing');
    await j.shot(page, 'landing-file-picked');

    // ── player ──
    await page.keyboard.press('Escape');
    await page.locator('#cta').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/jobs\//, { timeout: 60_000 });
    j.step('upload submitted with the keyboard (Enter on the CTA)', 'pass', page.url());
    await page.locator('[data-testid="player"][data-phase="ready"]').waitFor({ timeout: 240_000 });
    await page.locator('[data-testid^="chord-chip-"]').first().waitFor({ timeout: 30_000 }).catch(() => {});
    const pstops = await tabWalk(page, 40);
    const pnames = pstops.map((s) => s.name);
    j.step('player: tab order (first 40 stops)', 'info', pnames.join(' → '));
    const ip = pnames.findIndex((n) => /^(Play|Pause)/.test(n));
    const im = pnames.findIndex((n) => /^Mute /.test(n));
    const ic = pnames.findIndex((n) => /chord|C:maj/i.test(n));
    j.check('player: transport → mixer → chords in reading order', ip >= 0 && ip < im && (ic < 0 || im < ic), `play@${ip} mute@${im} chords@${ic}`);
    const pNoRing = pstops.filter((s) => s.name !== '(body)' && !s.ring);
    j.check('player: every tab stop shows a focus indicator', pNoRing.length === 0, pNoRing.map((s) => s.name).join(' | ') || 'all visible');
    // keyboard operation: Space on the play button toggles playback
    await page.locator('[data-testid="transport-play"]').focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(600);
    const lbl = await page.locator('[data-testid="transport-play"]').getAttribute('aria-label');
    j.check('player: Space on Play starts playback (label becomes Pause)', /Pause/i.test(lbl ?? ''), lbl);
    await page.keyboard.press('Space');
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll('main button, main [role="button"], main a[href]')]
        .filter((b) => !(b.getAttribute('aria-label') || b.textContent.trim() || b.getAttribute('title') || b.getAttribute('aria-labelledby')))
        .map((b) => b.outerHTML.slice(0, 80)),
    );
    j.check('player page: every button/link has an accessible name', unnamed.length === 0, unnamed.join(' | ') || 'all named');
    await axe(page, j, 'player');
    await j.shot(page, 'player');
    for (const path of ['/account', '/pricing']) {
      await page.goto(path);
      await axe(page, j, path.slice(1));
    }
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
    await j.shot(page, 'abort');
  } finally {
    await ctx.close();
  }
  return j.result(log);
}
