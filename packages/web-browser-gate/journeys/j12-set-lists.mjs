// J12 — Phase B, B2: set lists (#322), at 390×844 and 360×800 portrait (touch).
//
//   signed in: /sets → "+ New set list" → "Create" (prefilled "Set list 1") → the empty list
//   → a processed song → ⋯ → "Add to Set list 1" (one tap) → a second song the same way
//   → /sets/<id> shows both (nav: Songs is current) → Move down / Move up → drag song 1 below
//   song 2 and back (B2 follow-up: one PUT per drop) → open song 1 → "Next song ›" (one tap)
//   → song 2, last in the list: no Next → delete the list (confirm says songs are kept)
//   signed out: /sets/demo → the Demo set, read-only.
//
// SETUP: two songs uploaded through the landing by the journey's own user and processed by
// the stack's worker (the J9 way). Writes nothing outside its own user's rows.
import { Journey, mintUser, newContext, sleep, sql, uploadViaLanding } from './lib.mjs';

export const id = 'j12-set-lists';

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
];

async function processedSong(page, j) {
  const jobId = await uploadViaLanding(page, j);
  let status = '';
  for (let i = 0; i < 90 && !['done', 'failed'].includes(status); i += 1) {
    await sleep(2000);
    status = sql(`SELECT status FROM jobs WHERE id='${jobId}'`);
  }
  j.check('setup: the song is processed by the worker', status === 'done', `${jobId} status=${status}`);
  return status === 'done' ? jobId : null;
}

async function addFromPlayer(page, j, tag, jobId, listName) {
  await page.goto(`/jobs/${jobId}`);
  await page.locator('[data-testid="player"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="player-more"]').tap();
  const quick = page.locator('[data-testid="player-add-last"]');
  await quick.waitFor({ timeout: 10_000 });
  const label = (await quick.innerText()).trim();
  j.check(`${tag}: with ⋯ open, one tap reads "Add to ${listName}"`, label === `Add to ${listName}`, label);
  await j.shot(page, `${tag}-player-menu`, { fullPage: false });
  await quick.tap();
  const toast = await page.locator('[data-testid="set-toast"]').innerText({ timeout: 10_000 }).catch(() => '');
  j.check(`${tag}: the player says it was added`, toast === `Added to ${listName}.`, toast);
}

async function walk(j, vp, user, songs) {
  const tag = `${vp.width}x${vp.height}`;
  const { ctx, log } = await newContext({ user, viewport: vp, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  try {
    await page.goto('/sets');
    await page.locator('[data-testid="sets-new"]').waitFor({ timeout: 20_000 });
    // B2 follow-up: set lists have no nav item of their own; Song library ("Songs") is current.
    const navCurrent = (await page.locator('a.sin-item[aria-current="page"]').allInnerTexts()).map((t) => t.trim());
    j.check(`${tag}: on /sets the nav marks Songs as current`, navCurrent.length === 1 && navCurrent[0] === 'Songs', JSON.stringify(navCurrent));
    await j.shot(page, `${tag}-01-sets-empty`, { fullPage: false });
    await page.locator('[data-testid="sets-new"]').tap(); // tap 1
    const prefill = await page.locator('[data-testid="sets-new-name"]').inputValue();
    j.check(`${tag}: the new list is prefilled "Set list 1"`, prefill === 'Set list 1', prefill);
    await j.shot(page, `${tag}-02-new-list-sheet`, { fullPage: false });
    await page.locator('[data-testid="sets-create"]').tap(); // tap 2
    await page.waitForURL(/\/sets\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    const listId = page.url().split('/').pop();
    j.check(`${tag}: two taps made the list and opened it`, (await page.locator('[data-testid="set-name"]').innerText()) === 'Set list 1');

    for (const s of songs) await addFromPlayer(page, j, tag, s, 'Set list 1');

    await page.goto(`/sets/${listId}`);
    await page.locator('[data-testid="set-item"]').nth(1).waitFor({ timeout: 15_000 });
    j.check(`${tag}: the list shows both songs`, (await page.locator('[data-testid="set-item"]').count()) === 2);
    const box = await page.locator('[data-move="down"]').first().boundingBox();
    j.check(`${tag}: Move down is at least 44×44`, box && box.width >= 44 && box.height >= 44, JSON.stringify(box));
    const first = await page.locator('[data-testid="set-item"]').first().getAttribute('data-item');
    await page.locator('[data-move="down"]').first().focus();
    await page.keyboard.press('Enter');
    await sleep(800);
    j.check(`${tag}: Move down by keyboard moved the song`, (await page.locator('[data-testid="set-item"]').nth(1).getAttribute('data-item')) === first);
    await j.shot(page, `${tag}-03-move-focus`, { fullPage: false });
    await page.locator(`[data-item="${first}"] [data-move="up"]`).focus();
    await page.keyboard.press('Enter');
    await sleep(800);

    // Drag to reorder (B2 follow-up): drag song 1's handle below song 2; one PUT; then back.
    const dragTo = async (fromIdx, toIdx, shotName) => {
      const h = await page.locator('[data-testid="set-item"]').nth(fromIdx).locator('[data-testid="set-drag"]').boundingBox();
      const target = await page.locator('[data-testid="set-item"]').nth(toIdx).boundingBox();
      const x = h.x + h.width / 2;
      const dy = toIdx > fromIdx ? target.height * 0.8 : -target.height * 0.8;
      const puts = [];
      const onReq = (r) => r.method() === 'PUT' && r.url().endsWith(`/api/set-lists/${listId}/songs`) && puts.push(r);
      page.on('request', onReq);
      await page.mouse.move(x, h.y + h.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, target.y + target.height / 2 + dy, { steps: 10 });
      if (shotName) {
        j.check(`${tag}: mid-drag the row is marked as dragged`, (await page.locator('[data-drag="true"]').count()) === 1);
        await j.shot(page, shotName, { fullPage: false });
      }
      await page.mouse.up();
      await page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/set-lists/${listId}/songs`), { timeout: 10_000 }).catch(() => {});
      await sleep(500);
      page.off('request', onReq);
      return puts.length;
    };
    const dragHandle = await page.locator('[data-testid="set-drag"]').first().boundingBox();
    j.check(`${tag}: the drag handle is at least 44×44`, dragHandle && dragHandle.width >= 44 && dragHandle.height >= 44, JSON.stringify(dragHandle));
    const sent = await dragTo(0, 1, `${tag}-03b-mid-drag`);
    j.check(`${tag}: one drop sent one PUT`, sent === 1, String(sent));
    j.check(`${tag}: dragging song 1 below song 2 moved it`, (await page.locator('[data-testid="set-item"]').nth(1).getAttribute('data-item')) === first);
    await page.reload();
    await page.locator('[data-testid="set-item"]').nth(1).waitFor({ timeout: 15_000 });
    j.check(`${tag}: the dragged order is saved`, (await page.locator('[data-testid="set-item"]').nth(1).getAttribute('data-item')) === first);
    await j.shot(page, `${tag}-03c-after-drop`, { fullPage: false });
    await dragTo(1, 0, null);
    j.check(`${tag}: dragging it back restored the order`, (await page.locator('[data-testid="set-item"]').first().getAttribute('data-item')) === first);

    await page.locator('[data-testid="set-item"] a').first().tap();
    await page.locator('[data-testid="set-next"]').waitFor({ timeout: 20_000 });
    const back = await page.locator('[data-testid="player"] header a').first().getAttribute('aria-label');
    j.check(`${tag}: the back link says "Back to Set list 1"`, back === 'Back to Set list 1', back);
    const head = await page.evaluate(() => ({ scroll: document.querySelector('[data-testid="player"]').scrollHeight - window.innerHeight }));
    j.check(`${tag}: with the set row, the player still fits one screen`, head.scroll <= 0, JSON.stringify(head));
    await j.shot(page, `${tag}-04-player-next-song`, { fullPage: false });
    await page.locator('[data-testid="set-next"]').tap(); // one tap
    await page.waitForURL(new RegExp(`/jobs/${songs[1]}\\?set=${listId}$`), { timeout: 15_000 }).catch(() => {});
    j.check(`${tag}: "Next song ›" opened song 2 in one tap`, page.url().includes(`/jobs/${songs[1]}?set=${listId}`), page.url());
    await page.locator('[data-testid="set-next-text"]').waitFor({ timeout: 15_000 });
    j.check(`${tag}: at the last song there is no Next`, (await page.locator('[data-testid="set-next"]').count()) === 0);

    await page.goto(`/sets/${listId}`);
    await page.locator('[data-testid="set-delete"]').tap();
    const confirm = await page.locator('[data-testid="set-delete-sheet"]').innerText();
    j.check(`${tag}: the delete confirm says songs are kept`, /Deleting a list never deletes songs\./.test(confirm), confirm.replace(/\s+/g, ' '));
    await j.shot(page, `${tag}-05-delete-confirm`, { fullPage: false });
    const jobsBefore = sql(`SELECT count(*) FROM jobs WHERE user_id = (SELECT user_id FROM jobs WHERE id='${songs[0]}')`);
    await page.locator('[data-testid="set-delete-confirm"]').tap();
    await page.waitForURL(/\/sets$/, { timeout: 15_000 }).catch(() => {});
    const jobsAfter = sql(`SELECT count(*) FROM jobs WHERE user_id = (SELECT user_id FROM jobs WHERE id='${songs[0]}')`);
    j.check(`${tag}: deleting the list deleted no song`, jobsBefore === jobsAfter, `${jobsBefore} -> ${jobsAfter}`);
  } catch (e) {
    j.step(`${tag}: aborted`, 'fail', String(e).slice(0, 400));
    await j.shot(page, `${tag}-abort`);
  } finally {
    await ctx.close();
  }
  return log;
}

export default async function run() {
  const j = new Journey(id, 'Set lists: create in 2 taps, add from the player in 1, reorder, Next song, delete; Demo set signed out');
  const logs = { console: [], http: [] };
  try {
    const user = mintUser('j12-set-lists');
    const { ctx } = await newContext({ user });
    const page = await ctx.newPage();
    const songs = [];
    try {
      for (let i = 0; i < 2; i += 1) {
        const s = await processedSong(page, j);
        if (s) songs.push(s);
      }
    } finally {
      await ctx.close();
    }
    if (songs.length < 2) {
      j.step('walk', 'not-reached', 'two processed songs are needed');
      return j.result(logs);
    }
    for (const vp of VIEWPORTS) {
      const log = await walk(j, vp, user, songs);
      logs.console.push(...log.console);
      logs.http.push(...log.http);
    }

    const { ctx: anon, log } = await newContext({ viewport: VIEWPORTS[0], isMobile: true, hasTouch: true });
    const p = await anon.newPage();
    try {
      await p.goto('/sets/demo');
      await p.locator('[data-testid="set-view"][data-state="ok"]').waitFor({ timeout: 20_000 });
      j.check('signed out: /sets/demo shows the Demo set', (await p.locator('[data-testid="set-name"]').innerText()) === 'Demo set');
      j.check('signed out: the Demo set has 3 rows and no edit controls', (await p.locator('[data-testid="set-item"]').count()) === 3 && (await p.locator('[data-move]').count()) === 0);
      const st = async (method) => (await p.request.fetch('/api/set-lists/demo', { method, failOnStatusCode: false, headers: { origin: new URL(p.url()).origin } })).status();
      j.check('signed out: GET /api/set-lists/demo is 200', (await st('GET')) === 200);
      for (const m of ['POST', 'PATCH', 'DELETE']) j.check(`${m} /api/set-lists/demo is 405`, (await st(m)) === 405);
      await j.shot(p, '390x844-06-demo-set-signed-out', { fullPage: false });
      logs.console.push(...log.console);
    } finally {
      await anon.close();
    }
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
  }
  return j.result(logs);
}
