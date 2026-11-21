// J1 — first run as a signed-in user:
// landing → real file input upload → job page through its states → player with 6 stems →
// chords visible → mixer mute / solo / volume (checked on the engine's GainNode targets) →
// on-demand loop cut → loop plays → loop WAV download → ZIP.
import { GAIN_PROBE, Journey, mintUser, newContext, sleep, uploadViaLanding } from './lib.mjs';
import { recentListsUploadByTitle } from './recent-label.mjs';

export const id = 'j1-first-run';
export default async function run() {
  const j = new Journey(id, 'First run, signed in: upload → states → player → chords → mixer → loops');
  const user = mintUser('j1');
  const { ctx, log } = await newContext({ user });
  await ctx.addInitScript(GAIN_PROBE);
  const page = await ctx.newPage();
  try {
    const jobId = await uploadViaLanding(page, j);

    // Job states as the page shows them, sampled until the player mounts.
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 240_000) {
      const s = await page.evaluate(() => {
        if (document.querySelector('[data-testid="player"]')) return 'PLAYER';
        const fail = document.querySelector('.jp-failed h1');
        if (fail) return `FAILED: ${fail.textContent}`;
        const bar = document.querySelector('[role="progressbar"]');
        return bar ? bar.getAttribute('aria-label') : document.querySelector('main')?.innerText.slice(0, 40) ?? '';
      });
      if (seen[seen.length - 1] !== s) {
        seen.push(s);
        if (s && s !== 'PLAYER' && !s.startsWith('FAILED')) await j.shot(page, `state-${seen.length}-${s.replace(/\W+/g, '_')}`);
      }
      if (s === 'PLAYER' || s.startsWith('FAILED')) break;
      await sleep(300);
    }
    j.check('job page shows the pipeline states, ends at the player', seen[seen.length - 1] === 'PLAYER', seen.join(' → '));
    j.check('at least one in-flight stage label seen', seen.some((s) => /Queued|Downloading|Separating|Extracting|Uploading/.test(s)), seen.join(' → '));

    // Player loads 6 stems
    await page.waitForSelector('[data-testid="player"][data-phase="ready"], [data-testid="player"][data-phase="load-error"], [data-testid="player"][data-phase="no-stems"]', { timeout: 60_000 }).catch(() => {});
    const phase = await page.getAttribute('[data-testid="player"]', 'data-phase');
    const channels = await page.locator('section[aria-label="Stem mixer"] [role="group"]').count();
    const enabledFaders = await page.locator('section[aria-label="Stem mixer"] input[type="range"]:not([disabled])').count();
    j.check('player ready with 6 stems', phase === 'ready' && channels === 6 && enabledFaders === 6, `phase=${phase} channels=${channels} enabledFaders=${enabledFaders}`);
    await j.shot(page, 'player-ready');

    // Chords — Slice 1a: the chord STAGE is the screen (Now/Next + two bar
    // lines); the full chart is one tap away ("Show all chords" on desktop).
    const nowName = page.locator('[data-testid="phone-chords"] [data-testid="playhead-now-name"]').first();
    const stageOk = await nowName.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
    const slotLabels = stageOk ? await page.locator('[data-testid^="phone-slot-"]').evaluateAll((els) => els.slice(0, 6).map((e) => e.getAttribute('aria-label'))) : [];
    const chordMsg = await page.locator('[data-testid="completed-job-message"]').innerText().catch(() => '');
    j.check('chords visible on the stage (Now + bar lines)', stageOk && slotLabels.length > 0, stageOk ? `${await nowName.innerText()} | ${slotLabels.join(' | ')}` : `no stage; message="${chordMsg}"`);
    await page.getByRole('button', { name: 'Show all chords' }).click().catch(() => {});
    const chip = page.locator('[data-testid="chart-sheet"] [data-testid^="chord-chip-"]').first();
    const chartOk = await chip.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
    j.check('the full chart opens ("Show all chords")', chartOk, chartOk ? 'chips rendered' : 'no chips in the chart sheet');
    await page.keyboard.press('Escape');

    // Mixer — mute, solo, volume, checked on the engine's gain targets.
    const gains = () => page.evaluate(() => (window.__w4gains ?? []).map((g) => Math.round(g.target * 100) / 100));
    const g0 = await gains();
    j.step('engine gain nodes (baseline)', g0.length >= 6 ? 'info' : 'fail', JSON.stringify(g0));
    const names = await page.locator('section[aria-label="Stem mixer"] [role="group"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    const first = names[0];
    const second = names[1];

    await page.getByRole('button', { name: `Mute ${first}` }).click();
    await sleep(200);
    const gMute = await gains();
    const mutePressed = await page.getByRole('button', { name: `Mute ${first}` }).getAttribute('aria-pressed');
    j.check(`mute ${first}: pressed and exactly one more stem silent`, mutePressed === 'true' && gMute.filter((g) => g === 0).length === g0.filter((g) => g === 0).length + 1, `pressed=${mutePressed} gains=${JSON.stringify(gMute)}`);
    await page.getByRole('button', { name: `Mute ${first}` }).click();
    await sleep(200);
    j.check(`unmute ${first}: gains back to baseline`, JSON.stringify(await gains()) === JSON.stringify(g0), JSON.stringify(await gains()));

    await page.getByRole('button', { name: `Solo ${second}` }).click();
    await sleep(200);
    const gSolo = await gains();
    const soloPressed = await page.getByRole('button', { name: `Solo ${second}` }).getAttribute('aria-pressed');
    j.check(`solo ${second}: pressed and only one stem audible`, soloPressed === 'true' && gSolo.filter((g) => g > 0).length === 1, `pressed=${soloPressed} gains=${JSON.stringify(gSolo)}`);
    await page.getByRole('button', { name: `Solo ${second}` }).click();
    await sleep(200);

    const fader = page.getByRole('slider', { name: `${first} level` }).or(page.locator(`input[aria-label="${first} level"]`)).first();
    await fader.focus();
    for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.up('ArrowDown');
    await sleep(250);
    const fv = await fader.inputValue();
    const gVol = await gains();
    const changed = gVol.filter((g, i) => g !== g0[i]);
    j.check(`volume ${first}: fader moved and one gain changed to match`, Number(fv) < 100 && changed.length === 1 && Math.abs(changed[0] - Number(fv) / 100) < 0.02, `fader=${fv} gains=${JSON.stringify(gVol)}`);

    // Transport plays
    await page.locator('[data-testid="transport-play"]').click();
    await sleep(2500);
    const tt = await page.locator('[data-testid="transport-time"]').innerText().catch(() => '');
    const playLabel = await page.locator('[data-testid="transport-play"]').getAttribute('aria-label');
    j.check('transport plays (position advances)', !/^0:00\b/.test(tt.trim()), `time="${tt.replace(/\s+/g, ' ')}" button="${playLabel}"`);
    await page.locator('[data-testid="transport-play"]').click().catch(() => {});
    await j.shot(page, 'player-after-mixer');

    // Loops — on-demand cut.
    // Story 6.1 / PR #280 moved the loops OFF the job page: they are their own
    // product now, at /loops with the job preselected, and the job page carries
    // one link there. The cut, the cards, the WAV and the ZIP are the same
    // <LoopResults> as before, mounted by /loops instead. So this journey
    // follows the link a user would follow, and then runs the same checks.
    // Phase A (2026-11-21): the play-along player no longer links to the loops
    // product (it stays reachable from the nav and Account). So the ⋯ menu must
    // NOT offer "Download loops", and the journey opens /loops?job=<id> itself,
    // the address the nav's Download loops page preselects.
    await page.locator('[data-testid="player-more"]').click().catch(() => {});
    const menuText = (await page.locator('#player-menu').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const loopsInMenu = await page.locator('#player-menu a[href*="/loops"], [data-testid="loops-link"]').count();
    // The menu must actually be open (it lists "Song info"), or "no loops link" proves nothing.
    j.check('the player\'s ⋯ menu opened', /Song info/.test(menuText) && /See all chords/.test(menuText), `menu="${menuText}"`);
    j.check('the player\'s ⋯ menu does not link to the loops product', /Song info/.test(menuText) && loopsInMenu === 0 && !/Download loops/.test(menuText), `menu="${menuText}"`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.goto(`/loops?job=${jobId}`);
    await page.waitForURL(/\/loops\b/, { timeout: 30_000 }).catch(() => {});
    // /loops fetches the job client-side, so its section is mounted as `loading`
    // first and the cut button is not there for the first frames. Wait for the
    // section to leave `loading`, and then for the button itself.
    await page.locator('[data-testid="lp-job"]').waitFor({ timeout: 30_000 }).catch(() => {});
    await page.locator('[data-testid="lp-job"]:not([data-view="loading"])').waitFor({ timeout: 60_000 }).catch(() => {});
    j.check('the loops page opens on this song', /\/loops/.test(page.url()) && page.url().includes(jobId),
      `${page.url().slice(0, 120)} view=${await page.getAttribute('[data-testid="lp-job"]', 'data-view').catch(() => '(none)')}`);

    const cut = page.locator('[data-testid="cut-loops"]');
    const hasCut = await cut.first().waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false);
    if (!j.check('"Cut N loops" button offered', hasCut,
      hasCut ? await cut.first().innerText() : `missing; view=${await page.getAttribute('[data-testid="lp-job"]', 'data-view').catch(() => '(none)')} text="${(await page.locator('[data-testid="lp-job"]').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}"`)) throw new Error('no cut button');
    await cut.first().click();
    const cards = page.locator('.loop-card');
    const cutOk = await cards.first().waitFor({ state: 'visible', timeout: 180_000 }).then(() => true, () => false);
    const cutErr = await page.locator('[data-testid="cut-error"]').innerText().catch(() => '');
    j.check('loops appear after the cut', cutOk, cutOk ? `${await cards.count()} loop cards` : `none; error="${cutErr}"`);
    // Every mapped loop must arrive, and the page must leave the "cut" state on its own.
    // (The loop-count read off `h1:has-text("Loops")` is gone: <LoopResults> is a
    // section of /loops now, so its heading is the h2 below, and the count is in
    // `header` already.)
    const allIn = await page.locator('[data-testid="zip-loops"]').waitFor({ timeout: 90_000 }).then(() => true, () => false);
    const header = (await page.locator('.loop-results header').innerText().catch(() => '')).replace(/\s+/g, ' ');
    j.check('the whole cut lands without a manual reload (download view returns, no "Cut N loops" left)', allIn, `${await cards.count()} cards; header="${header}"`);
    await j.shot(page, 'loops');

    const playBtn = cards.first().locator('.play-btn');
    await playBtn.click();
    const playing = await page.waitForFunction((el) => el.getAttribute('aria-pressed') === 'true', await playBtn.elementHandle(), { timeout: 15_000 }).then(() => true, () => false);
    j.check('loop plays (play button pressed)', playing, await playBtn.innerText());
    if (playing) await playBtn.click();

    const a = cards.first().locator('a.btn-download-wav');
    const href = await a.getAttribute('href');
    const resp = href && href !== '#' ? await page.request.get(href) : null;
    const body = resp ? await resp.body() : Buffer.alloc(0);
    j.check('loop WAV link returns a RIFF/WAVE file', resp?.status() === 200 && body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WAVE', `status=${resp?.status()} bytes=${body.length}`);
    const dl = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), a.click()]).then(([d]) => d, () => null);
    j.check('clicking "⬇ WAV" starts a browser download', !!dl, dl ? dl.suggestedFilename() : 'no download event');
    j.check('the loops page is still there after the WAV click (no navigation away)', /\/loops/.test(page.url()), page.url().slice(0, 120));

    const zip = page.locator('[data-testid="zip-loops"]');
    const zt0 = Date.now();
    const zdl = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), zip.click()]).then(([d]) => d, () => null);
    j.check('"Download All (ZIP)" produces a .zip', !!zdl && /\.zip$/.test(zdl.suggestedFilename()), zdl ? `${zdl.suggestedFilename()} after ${Math.round((Date.now() - zt0) / 1000)} s` : `no download in 120 s; url=${page.url().slice(0, 80)} zipButtons=${await zip.count()} button="${await zip.innerText({ timeout: 2000 }).catch(() => '')}"`);
    if (!zdl) await j.shot(page, 'zip-failed');
    // the account page lists this job; a tester recognises it by its file name
    await page.goto('/account');
    const recent = (await page.locator('section[aria-label="Recent jobs"]').innerText().catch(() => '')).replace(/\s+/g, ' ');
    // Slice 1b (P5.1): the label is the stored TITLE (file name without ".mp3"), not the id and
    // not the original_filename fallback — see recent-label.mjs (review round 2, SF-4).
    j.check('account "Recent jobs" lists the upload by its title (file name without .mp3; not its id)',
      recentListsUploadByTitle(recent, jobId), recent.slice(0, 200));
    j.note(`job ${jobId}, user ${user.user_id}`);
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
    await j.shot(page, 'abort');
  } finally {
    await ctx.close();
  }
  return j.result(log);
}
