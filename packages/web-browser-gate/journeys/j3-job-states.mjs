// J3 — job states as the UI shows them, each driven for real on the local stack:
//   queued (worker stopped) · unreachable (poll answers 5xx, then network failure) and self-heal ·
//   stalled panel (queued >90 min and active >11 min, reached by back-dating jobs.updated_at —
//   the panel keys off updated_at vs the server Date header, so no 90-minute wait) ·
//   spend brake engaged (job stays queued; what does the user see) then released ·
//   failed (Replicate mock answers `failed`) · degraded player (a done job, one stem fails to
//   load in the browser) · partial stem set (#490: 5 of 6 stems ends FAILED UPLOAD_FAILED and
//   the credit comes back once) · Klangio at-cap tombstone (KLANGIO_MONTHLY_CAP=1).
// Needs JOURNEY_STACK_CMD (worker / stopworker / ctl) and JOURNEY_DB_URL.
import { Journey, mintUser, newContext, sleep, sql, stack, uploadViaLanding } from './lib.mjs';

export const id = 'j3-job-states';

async function panelText(page) {
  return (await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
}

export default async function run() {
  const j = new Journey(id, 'Job states shown in the UI');
  const user = mintUser('j3');
  const { ctx, log } = await newContext({ user });
  const page = await ctx.newPage();
  try {
    // ── queued, worker stopped ───────────────────────────────────────────────
    stack('stopworker');
    const jid = await uploadViaLanding(page, j);
    await page.locator('[role="progressbar"]').waitFor({ timeout: 20_000 });
    await sleep(5000);
    const q = await panelText(page);
    j.check('queued: page shows "Queued" with the progress bar', /Queued/.test(q) && sql(`SELECT status FROM jobs WHERE id='${jid}'`) === 'queued', q.slice(0, 200));
    j.step('queued: copy shown to the user', 'info', q.slice(0, 200));
    await j.shot(page, 'queued-worker-stopped');

    // ── unreachable: poll answers 500 ───────────────────────────────────────
    await page.route(`**/api/jobs/${jid}`, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error_code":"INTERNAL_ERROR"}' }));
    const u500 = await page.locator('[data-testid="job-unreachable"]').waitFor({ timeout: 40_000 }).then(() => true, () => false);
    const t500 = await panelText(page);
    j.check('unreachable (5xx): panel shown, names the status and says it is our fault', u500 && /\(500\)/.test(t500) && /our fault/.test(t500), t500.slice(0, 300));
    await j.shot(page, 'unreachable-500');
    await page.unroute(`**/api/jobs/${jid}`);
    await page.route(`**/api/jobs/${jid}`, (r) => r.abort('internetdisconnected'));
    await page.getByRole('button', { name: 'Try again' }).click();
    const tNet = await page.waitForFunction(() => /connection/.test(document.querySelector('[data-testid="job-unreachable"]')?.textContent ?? ''), null, { timeout: 40_000 }).then(() => true, () => false);
    j.check('unreachable (network): panel says check your connection', tNet, (await panelText(page)).slice(0, 300));
    await j.shot(page, 'unreachable-network');
    await page.unroute(`**/api/jobs/${jid}`);
    const healed = await page.locator('[role="progressbar"]').waitFor({ timeout: 45_000 }).then(() => true, () => false);
    j.check('unreachable: page self-heals to the job when the server answers again (no click)', healed, (await panelText(page)).slice(0, 120));

    // ── stalled: queued for > 90 min ────────────────────────────────────────
    sql(`UPDATE jobs SET updated_at = now() - interval '95 minutes' WHERE id='${jid}'`);
    await page.reload();
    const sq = await page.locator('[data-testid="job-stalled"]').waitFor({ timeout: 20_000 }).then(() => true, () => false);
    const tsq = await panelText(page);
    j.check('stalled (queued > 90 min): "This is taking too long" panel with Check again', sq && /waiting in line for more than 90 minutes/.test(tsq), tsq.slice(0, 300));
    await j.shot(page, 'stalled-queued');
    // ── stalled: active stage quiet for > 11 min ────────────────────────────
    sql(`UPDATE jobs SET status='separating', updated_at = now() - interval '15 minutes' WHERE id='${jid}'`);
    await page.getByRole('button', { name: 'Check again' }).click();
    const sa = await page.waitForFunction(() => /stopped making progress/.test(document.querySelector('[data-testid="job-stalled"]')?.textContent ?? ''), null, { timeout: 20_000 }).then(() => true, () => false);
    j.check('stalled (active > 11 min): "stopped making progress" panel', sa, (await panelText(page)).slice(0, 300));
    await j.shot(page, 'stalled-active');
    sql(`UPDATE jobs SET status='queued', updated_at = now() WHERE id='${jid}'`);

    // ── spend brake engaged: worker running, job stays queued ───────────────
    sql(`UPDATE kill_switches SET enabled = true WHERE scope='spend_global'`);
    stack('worker');
    await page.reload();
    await sleep(15_000);
    const braked = sql(`SELECT status FROM jobs WHERE id='${jid}'`);
    const tb = await panelText(page);
    j.check('spend brake engaged: job stays queued while the worker runs', braked === 'queued', `db status=${braked}`);
    j.step('spend brake engaged: what the user sees (no reason given; stall panel only after 90 min)', 'info', tb.slice(0, 200));
    await j.shot(page, 'spend-brake-engaged');
    sql(`UPDATE kill_switches SET enabled = false WHERE scope='spend_global'`);
    const resumed = await page.locator('[data-testid="player"]').waitFor({ timeout: 180_000 }).then(() => true, () => false);
    j.check('spend brake released: the queued job resumes and reaches the player', resumed, sql(`SELECT status FROM jobs WHERE id='${jid}'`));

    // ── failed: Replicate answers `failed` ──────────────────────────────────
    stack('ctl', JSON.stringify({ status: 'failed' }));
    const fid = await uploadViaLanding(page, j);
    const failed = await page.locator('.jp-failed').waitFor({ timeout: 120_000 }).then(() => true, () => false);
    const tf = await panelText(page);
    const code = sql(`SELECT coalesce(error_code,'') FROM jobs WHERE id='${fid}'`);
    j.check('failed: failed panel shown with a way out', failed && /Something went wrong/.test(tf) && /Start a new song/.test(tf), `${code}: ${tf.slice(0, 250)}`);
    j.check('failed (provider outage, SEPARATION_FAILED): copy does not tell the user to change songs', !/different song|another file/i.test(tf.replace(/Start a new song( →)?/g, '')), tf.slice(0, 250));
    await j.shot(page, 'failed-separation');
    stack('ctl', JSON.stringify({ status: 'succeeded' }));

    // ── degraded: a done job whose `other` stem fails to load in the browser ──
    // #490 (Jon E2 = a): a 5-of-6 provider output no longer ends `done` (next step), so the
    // player's "a stem is missing" notice is reached the way it still happens: all six Opus
    // stems exist, one fails to load (lib/play/load-stems.ts: a 404 is `missing`, never thrown).
    // `other` is the stem the mock's `five` output drops. Uses the brake job (done, 6 stems).
    // A route also disables Chromium's HTTP cache, so the reload really re-fetches.
    const otherOpus = (u) => u.pathname.endsWith(`/${jid}/_stems/play/other.opus`);
    await page.route(otherOpus, (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: '' }));
    await page.goto(`/jobs/${jid}`);
    const dReady = await page.locator('[data-testid="player"][data-phase="ready"]').waitFor({ timeout: 60_000 }).then(() => true, () => false);
    const degraded = await page.locator('[data-testid="player-degraded"]').innerText().catch(() => '');
    const chans = await page.locator('section[aria-label="Stem mixer"] input[type="range"]:not([disabled])').count();
    j.check('degraded (one stem fails to load): player loads, says a stem is missing, 5 faders live', dReady && /not available for this track/.test(degraded) && chans === 5, `ready=${dReady} live faders=${chans} notice="${degraded}"`);
    await j.shot(page, 'degraded-stem-load-404');
    await page.unroute(otherOpus);

    // ── partial: provider returns 5 of 6 stems → FAILED, credit back once ───
    // #490: fewer than six playable stems fails the job UPLOAD_FAILED (failure_reason
    // partial_stem_set, a Sentry tag only) and returns the credit (job_failure.REFUND_SQL).
    // A quota-funded upload spends no credit and gets nothing back, so the user is given one
    // credit first: this upload is then credit-funded (api/jobs: chargeCredit). The web reads
    // credits through a 30 s entitlement cache (lib/billing/entitlements.ts CACHE_TTL_MS), so
    // wait it out, or the upload is charged from a stale 0-credit snapshot.
    sql(`INSERT INTO credit_adjustments (user_id, credits_delta, reason, provider, provider_event_id) VALUES ('${user.user_id}', 1, 'manual_grant', 'beta', 'w4-j3-partial-${user.user_id}')`);
    await sleep(31_000);
    stack('ctl', JSON.stringify({ output: 'five' }));
    const pid = await uploadViaLanding(page, j);
    const pFailed = await page.locator('.jp-failed').waitFor({ timeout: 180_000 }).then(() => true, () => false);
    const pRow = sql(`SELECT status || '|' || coalesce(error_code,'') FROM jobs WHERE id='${pid}'`);
    // The job page shows the worker's stored sentence for UPLOAD_FAILED (lib/error-copy.ts
    // failedJobMessage: only SEPARATION_FAILED is overridden by ERROR_COPY). Worker copy:
    // apps/worker/src/worker/errors.py UploadFailedError.user_message. A credit-funded upload
    // gets no "didn't count" sentence (that is the link-job allowance, QA-64).
    const PARTIAL_COPY = "We separated your stems but couldn't save them. Add the track again to retry.";
    const pMsg = (await page.locator('.jp-failed p').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const tp = await panelText(page);
    const uploadAgain = await page.locator('[data-testid="job-upload-again"]').count();
    const pPlayer = await page.locator('[data-testid="player"]').count();
    j.check('partial (5 stems): job ends failed UPLOAD_FAILED, not done', pRow === 'failed|UPLOAD_FAILED', `db=${pRow}`);
    j.check('partial (5 stems): failed panel with the "couldn\'t save them" copy and Upload again, no player', pFailed && /Something went wrong/.test(tp) && pMsg === PARTIAL_COPY && uploadAgain === 1 && pPlayer === 0, `msg="${pMsg}" uploadAgain=${uploadAgain} player=${pPlayer}`);
    const spent = sql(`SELECT count(*) FROM credit_consumption WHERE job_id='${pid}'`);
    const refunds = sql(`SELECT count(*) FROM credit_adjustments WHERE provider='worker_job_failed' AND provider_event_id='${pid}'`);
    j.check('partial (5 stems): the credit it spent comes back exactly once', spent === '1' && refunds === '1', `credit_consumption=${spent} refunds=${refunds}`);
    await j.shot(page, 'partial-five-stems-failed');
    stack('ctl', JSON.stringify({ output: 'fixed' }));

    // ── Klangio at cap: tombstone copy ──────────────────────────────────────
    stack('worker', 'KLANGIO_MONTHLY_CAP=1');
    const cid = await uploadViaLanding(page, j);
    const done = await page.locator('[data-testid="player"]').waitFor({ timeout: 180_000 }).then(() => true, () => false);
    // the message starts as "Loading chords…"; wait for the settled state
    await page.waitForFunction(() => {
      const t = document.querySelector('[data-testid="completed-job-message"]')?.textContent ?? '';
      return t && !/Loading chords/.test(t);
    }, null, { timeout: 30_000 }).catch(() => {});
    const msg = await page.locator('[data-testid="completed-job-message"]').innerText().catch(() => '');
    j.check('at cap: job still finishes with a player', done, cid);
    j.step('at cap: chord-area copy', 'info', msg);
    j.check('at cap: chord copy does not blame the track ("failed for this track")', msg.length > 0 && !/Loading chords/.test(msg) && !/failed for this track/i.test(msg), msg || '(no message)');
    await j.shot(page, 'klangio-at-cap');
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
    await j.shot(page, 'abort');
  } finally {
    // restore: brake released, mocks default, worker default
    try {
      sql(`UPDATE kill_switches SET enabled = false WHERE scope='spend_global'`);
      stack('ctl', JSON.stringify({ status: 'succeeded' }));
      stack('worker');
    } catch (e) {
      j.note(`restore failed: ${e}`);
    }
    await ctx.close();
  }
  return j.result(log);
}
