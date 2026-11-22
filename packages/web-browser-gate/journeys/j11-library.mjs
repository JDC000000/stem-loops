// J11 — Phase B, B1: the song library keeps every song (migration 043), at 390×844 and 360×800
// portrait (touch).
//
//   signed in: /history lists two EXPIRED songs (a link and an upload; library_entries rows
//   written here by SQL, the shape the worker's retention sweep writes) → each row: title 16 px,
//   "BPM · key" 13 px, "Audio expired", no amber → the link offers "Re-make · uses 1 of your
//   songs" (>= 44 px), the upload "Upload again" → search narrows / "No songs match" → sort
//   control (Recent / Newest / A–Z) → Remove asks first and removes → Re-make is ONE tap to the
//   job page (360×800 pass; the stack has NEXT_PUBLIC_ALLOW_YOUTUBE_INPUT on, as j10 needs).
//   signed out: /history says "Sign in to see your library."
//
// Writes nothing outside its own user's rows.
import { Journey, mintUser, newContext, sql } from './lib.mjs';

export const id = 'j11-library';

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 800 },
];

function seedEntries(userId, tag) {
  const v = `j11${tag}${Date.now().toString(36)}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 11).padEnd(11, 'x');
  const link = sql(
    `INSERT INTO library_entries (user_id, input_kind, youtube_url, title, video_id, bpm, musical_key)
     VALUES ('${userId}', 'youtube', 'https://www.youtube.com/watch?v=${v}', 'Lucky Ticket (live take)', '${v}', 102, 'A major')
     RETURNING id`,
  );
  const upload = sql(
    `INSERT INTO library_entries (user_id, input_kind, original_filename, title)
     VALUES ('${userId}', 'upload', 'band rehearsal.wav', 'band rehearsal') RETURNING id`,
  );
  // psql -At prints the RETURNING row and then the command tag ("INSERT 0 1"): keep the id.
  const first = (out) => out.split('\n')[0].trim();
  return { link: first(link), upload: first(upload) };
}

async function walk(j, vp, user) {
  const tag = `${vp.width}x${vp.height}`;
  const ids = seedEntries(user.user_id, tag.replace('x', ''));
  const { ctx, log } = await newContext({ user, viewport: vp, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  try {
    await page.goto('/history');
    const row = page.locator(`[data-testid="library-entry"][data-entry="${ids.link}"]`);
    await row.waitFor({ timeout: 20_000 });
    const m = await row.evaluate((el) => {
      const px = (q) => parseFloat(getComputedStyle(el.querySelector(q)).fontSize);
      const b = el.querySelector('[data-testid="library-remake"]').getBoundingClientRect();
      const colors = [...el.querySelectorAll('*')].map((n) => getComputedStyle(n).color + getComputedStyle(n).backgroundColor);
      return {
        title: px('[data-testid="song-title"]'),
        meta: px('[data-testid="song-meta"]'),
        metaText: el.querySelector('[data-testid="song-meta"]').textContent,
        chip: el.querySelector('[data-testid="song-status"]').textContent,
        btn: { h: b.height, w: b.width, text: el.querySelector('[data-testid="library-remake"]').textContent },
        amber: colors.some((c) => /rgb\(2(4[5-9]|5\d), 1(5\d|6\d|7\d), (\d|1\d|2\d)\)/.test(c)),
        hscroll: document.scrollingElement.scrollWidth - innerWidth,
      };
    });
    j.check(`${tag}: expired title is 16 px`, m.title === 16, String(m.title));
    j.check(`${tag}: "BPM · key" is 13 px`, m.meta === 13 && m.metaText === '102 BPM · A major', JSON.stringify([m.meta, m.metaText]));
    j.check(`${tag}: says "Audio expired"`, m.chip === 'Audio expired', m.chip);
    j.check(`${tag}: Re-make reads "Re-make · uses 1 of your songs" and is >= 44 px tall`, m.btn.text === 'Re-make · uses 1 of your songs' && m.btn.h >= 44, JSON.stringify(m.btn));
    j.check(`${tag}: no amber on the row`, !m.amber);
    j.check(`${tag}: no sideways scroll`, m.hscroll <= 0, String(m.hscroll));
    const up = page.locator(`[data-testid="library-entry"][data-entry="${ids.upload}"]`);
    j.check(`${tag}: the upload offers "Upload again", not Re-make`, (await up.locator('[data-testid="library-upload-again"]').count()) === 1 && (await up.locator('[data-testid="library-remake"]').count()) === 0);
    await j.shot(page, `${tag}-01-library-expired`, { fullPage: false });

    await page.locator('[data-testid="library-search"]').fill('lucky');
    j.check(`${tag}: search "lucky" leaves the one match`, (await page.locator('[data-testid="library-entry"]').count()) === 1);
    await j.shot(page, `${tag}-02-search-hit`, { fullPage: false });
    await page.locator('[data-testid="library-search"]').fill('zzzz');
    j.check(`${tag}: no match says so`, (await page.locator('[data-testid="library-no-match"]').count()) === 1);
    await j.shot(page, `${tag}-03-search-none`, { fullPage: false });
    await page.locator('[data-testid="library-search"]').fill('');
    await page.locator('[data-sort="az"]').tap();
    j.check(`${tag}: A–Z is pressed`, (await page.locator('[data-sort="az"]').getAttribute('aria-pressed')) === 'true');
    await j.shot(page, `${tag}-04-sort`, { fullPage: false });

    await up.locator('[data-testid="library-remove"]').tap();
    await page.locator('[data-testid="library-remove-sheet"]').waitFor({ timeout: 10_000 });
    await j.shot(page, `${tag}-05-remove-confirm`, { fullPage: false });
    await page.locator('[data-testid="library-remove-confirm"]').tap();
    await up.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    j.check(`${tag}: Remove deleted the entry`, sql(`SELECT count(*) FROM library_entries WHERE id = '${ids.upload}'`) === '0');

    if (vp.width === 360) {
      await row.locator('[data-testid="library-remake"]').tap(); // one tap
      await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 20_000 }).catch(() => {});
      j.check(`${tag}: Re-make is one tap to the job page`, /\/jobs\/[0-9a-f-]{36}$/.test(page.url()), page.url());
    }
  } catch (e) {
    j.step(`${tag}: aborted`, 'fail', String(e).slice(0, 400));
    await j.shot(page, `${tag}-abort`);
  } finally {
    await ctx.close();
  }
  return log;
}

export default async function run() {
  const j = new Journey(id, 'Song library: expired rows with Re-make / Upload again, search, sort, Remove; signed-out prompt');
  const logs = { console: [], http: [] };
  try {
    const user = mintUser('j11-library');
    for (const vp of VIEWPORTS) {
      const log = await walk(j, vp, user);
      logs.console.push(...log.console);
      logs.http.push(...log.http);
    }
    const { ctx, log } = await newContext({ viewport: VIEWPORTS[0], isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    try {
      await p.goto('/history');
      await p.locator('[data-testid="history-sign-in"]').waitFor({ timeout: 20_000 });
      j.check('signed out: /history asks to sign in', /Sign in to see your library\./.test(await p.locator('[data-testid="history-sign-in"]').innerText()));
      await j.shot(p, '390x844-06-signed-out', { fullPage: false });
      logs.console.push(...log.console);
    } finally {
      await ctx.close();
    }
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
  }
  return j.result(logs);
}
