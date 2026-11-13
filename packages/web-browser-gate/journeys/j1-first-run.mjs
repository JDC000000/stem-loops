// J1 — first run as a signed-in user:
// landing → real file input upload → job page through its states → player with 6 stems →
// chords visible → mixer mute / solo / volume (checked on the engine's GainNode targets) →
// on-demand loop cut → loop plays → loop WAV download → ZIP.
import { GAIN_PROBE, Journey, mintUser, newContext, sleep, uploadViaLanding } from './lib.mjs';

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

    // Chords
    const chip = page.locator('[data-testid^="chord-chip-"]').first();
    const chordsOk = await chip.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
    const chipLabels = chordsOk ? await page.locator('[data-testid^="chord-chip-"]').evaluateAll((els) => els.slice(0, 6).map((e) => e.getAttribute('aria-label'))) : [];
    const chordMsg = await page.locator('[data-testid="completed-job-message"]').innerText().catch(() => '');
    j.check('chords visible (chord chips rendered)', chordsOk && chipLabels.length > 0, chordsOk ? chipLabels.join(' | ') : `no chips; message="${chordMsg}"`);

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

    // Loops — on-demand cut
    const cut = page.locator('[data-testid="cut-loops"]');
    const hasCut = await cut.isVisible().catch(() => false);
    if (!j.check('"Cut N loops" button offered', hasCut, hasCut ? await cut.innerText() : 'missing')) throw new Error('no cut button');
    await cut.click();
    const cards = page.locator('.loop-card');
    const cutOk = await cards.first().waitFor({ state: 'visible', timeout: 180_000 }).then(() => true, () => false);
    const cutErr = await page.locator('[data-testid="cut-error"]').innerText().catch(() => '');
    j.check('loops appear after the cut', cutOk, cutOk ? `${await cards.count()} loop cards` : `none; error="${cutErr}"`);
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

    const zip = page.locator('[data-testid="zip-loops"]');
    const zt0 = Date.now();
    const zdl = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), zip.click()]).then(([d]) => d, () => null);
    j.check('"Download All (ZIP)" produces a .zip', !!zdl && /\.zip$/.test(zdl.suggestedFilename()), zdl ? `${zdl.suggestedFilename()} after ${Math.round((Date.now() - zt0) / 1000)} s` : `no download in 120 s; button="${await zip.innerText().catch(() => '')}"`);
    j.note(`job ${jobId}, user ${user.user_id}`);
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
    await j.shot(page, 'abort');
  } finally {
    await ctx.close();
  }
  return j.result(log);
}
