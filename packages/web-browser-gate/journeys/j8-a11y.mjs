// J8 — keyboard and accessibility basics on the upload form and the player:
// tab order, a visible focus indicator on every stop, accessible names on buttons, and an
// axe-core scan of four pages (JOURNEY_AXE = path to axe.min.js; journeys.sh resolves it
// from this package's own axe-core dependency, so it is set by default).
import { existsSync, readFileSync } from 'node:fs';
import { Journey, mintUser, newContext, uploadViaLanding } from './lib.mjs';

export const id = 'j8-a11y';

/** Press Tab n times; record each focused element's name and whether a focus ring is visible. */
async function tabWalk(page, n, stopAtId = null) {
  const stops = [];
  for (let i = 0; i < n; i++) {
    if (stopAtId && stops.at(-1)?.id === stopAtId) break;
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
    // FAIL, not `not-reached`. A not-reached step yields the verdict
    // "PASS (partial: not-reached steps)", which run.mjs does NOT count as failed —
    // so an empty JOURNEY_AXE would turn all four scans off and leave this gate GREEN.
    // That is the exact silent-skip the job's resolve step exists to prevent; it must
    // not be reachable through the other door.
    j.check(`${tag}: axe-core scan ran`, false, p ? `JOURNEY_AXE points at a missing file: ${p}` : 'JOURNEY_AXE is not set');
    return;
  }
  await page.addScriptTag({ content: readFileSync(p, 'utf8') });
  const res = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, tags: v.tags, n: v.nodes.length, sample: v.nodes.slice(0, 2).map((x) => x.target.join(' ')).join(' ; ') }));
  });
  // `best-practice` is still SCANNED — losing the finding would be worse — but only
  // WCAG violations GATE. best-practice selects 99 of axe's 105 rules, ~30 of them
  // non-WCAG, and some of those (tabindex, aria-dialog-name) carry serious impact. On a
  // blocking gate that means a developer writing tabindex="1" blocks every PR on an
  // opinion rather than on a conformance failure. Non-WCAG findings report as info.
  const wcag = (v) => (v.tags ?? []).some((t) => t.startsWith('wcag'));
  const blocking = res.filter((v) => (v.impact === 'critical' || v.impact === 'serious') && wcag(v));
  j.check(`${tag}: axe — no critical/serious WCAG violations`, blocking.length === 0, blocking.map((v) => `${v.id}(${v.impact},${v.n}): ${v.sample}`).join(' | ') || 'none');
  const rest = res.filter((v) => !blocking.includes(v));
  if (rest.length) j.step(`${tag}: axe — other findings (best-practice, or moderate/minor)`, 'info', rest.map((v) => `${v.id}(${v.impact},${v.n}${wcag(v) ? '' : ',non-wcag'})`).join(', '));
}

export default async function run() {
  const j = new Journey(id, 'Keyboard and a11y basics: upload form and player');
  const user = mintUser('j8');
  // Desktop on purpose (review S5 on #288): the player's tab-order check expects
  // the stems' Mute buttons in the always-visible mixer column. On a phone they
  // live in the Mix sheet, which j7 opens and measures.
  const { ctx, log } = await newContext({ user, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  // Subscribe to file choosers BEFORE the page loads (#286). Playwright turns Chromium's
  // chooser interception (Page.setInterceptFileChooserDialog) on lazily, with a
  // fire-and-forget message, when the page gets its first 'filechooser' listener.
  // keyboard.press sends its key straight away, so a waitForEvent started in the same
  // Promise.all could lose that race: the page's click handler ran and called input.click()
  // with user activation, but the chooser opened un-intercepted, headless cancelled it, and
  // no event arrived (13 of 30 failed in a local loop). With this listener in place,
  // interception is on long before the Enter below; the waitForEvent there still does the waiting.
  page.on('filechooser', () => {});
  try {
    // ── upload form ──
    await page.goto('/');
    // Up to 24 stops, not 18 (Slice 2a): the home page's live demo (3 song chips, Play along,
    // its own-page link) now sits between the nav and the tool, five stops the walk must get
    // past. It stops at the CTA: walking on into the FAQ below left Chromium refusing the
    // keyboard file chooser checked next (measured locally: a 24-stop walk ending on a FAQ
    // summary → no chooser; any walk ending at or before the CTA → chooser). That measurement
    // predates #286 and may have been the interception race described above, not the FAQ.
    const lstops = await tabWalk(page, 24, 'cta');
    const order = lstops.map((s) => s.id || s.name);
    const iFile = order.indexOf('file-btn');
    // Wide screens show the stem chips inline (A4, 2026-11-21: phones have no stem picker and no
    // options toggle). The link field (#source) and its Paste button now come BEFORE "Choose a
    // file", so the middle stop is the first stem chip, not the first input.
    const iOpt = lstops.findIndex((s) => s.tag === 'input' && s.id !== 'source');
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
    await page.locator('[data-testid="playhead-now-name"]').first().waitFor({ timeout: 30_000 }).catch(() => {});
    const pstops = await tabWalk(page, 40);
    const pnames = pstops.map((s) => s.name);
    j.step('player: tab order (first 40 stops)', 'info', pnames.join(' → '));
    // Slice 1a (design v1.4 P1.1): the screen reads top to bottom — the chord
    // stage, then the transport, then (desktop) the mixer column.
    const ip = pnames.findIndex((n) => /^(Play|Pause)/.test(n));
    const im = pnames.findIndex((n) => /^Mute /.test(n));
    const ic = pnames.findIndex((n) => / — edit$/.test(n));
    j.check('player: chords → transport → mixer in reading order', ip >= 0 && ip < im && (ic < 0 || ic < ip), `chords@${ic} play@${ip} mute@${im}`);
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
      // Scan nothing without first proving there is something to scan: an empty <body>
      // and a Next client-side-exception page both score ZERO axe violations and would
      // report [PASS]. This is the weak form of that assertion — HTTP status plus the
      // absence of an error page — chosen over a content selector because no selector
      // for these two pages could be verified without the stack. j5 and j6 assert their
      // real content independently.
      const resp = await page.goto(path);
      // The pathname matters as much as the status. goto() returns the FINAL response
      // after redirects, so a 302 /account -> /login arrives as status 200 and the scan
      // would run against the sign-in page while still labelled `account` -- i.e. the
      // one realistic /account failure would sail through. Demonstrated against real
      // Chromium before this line existed.
      const landed = new URL(page.url()).pathname;
      const body = await page.evaluate(() => document.body?.innerText?.trim() ?? '');
      // No bare `404` here: Next's own 404 says "This page could not be found", while
      // "404" as a token appears in ordinary pricing copy ("404 credits a month"), which
      // made this check report a false RED. Demonstrated the same way.
      const broken = /application error|client-side exception|this page could not be found/i.test(body);
      j.check(`${path}: page rendered before the axe scan`, resp?.status() === 200 && landed === path && body.length > 0 && !broken, `status=${resp?.status()} landed=${landed} bodyChars=${body.length}${broken ? ' ERROR PAGE' : ''}`);
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
