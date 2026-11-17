// J4 — capacity refusal (AT_CAPACITY) copy, shown BEFORE the upload.
// Fills the global in-flight count to the cap (20) with clone rows marked `queued`
// (worker stopped so nothing claims them), then picks a file on the landing page and
// submits. Asserts the refusal copy, and that no PUT to the bucket happened.
import { Journey, mintUser, newContext, sql, stack, uploadViaLanding } from './lib.mjs';

export const id = 'j4-capacity';
const TAG = 'w4-capacity-filler';

export default async function run() {
  const j = new Journey(id, 'AT_CAPACITY refusal before upload');
  const user = mintUser('j4');
  const { ctx, log } = await newContext({ user });
  const page = await ctx.newPage();
  try {
    stack('stopworker');
    const inflight = Number(sql(`SELECT count(*) FROM jobs WHERE status IN ('queued','downloading','separating','extracting','uploading')`));
    const need = Math.max(0, 20 - inflight);
    sql(`DO $$
      DECLARE src jobs; i int;
      BEGIN
        SELECT * INTO src FROM jobs ORDER BY created_at DESC LIMIT 1;
        FOR i IN 1..${need} LOOP
          src.id := gen_random_uuid(); src.status := 'queued'; src.original_filename := '${TAG}';
          src.user_id := NULL; src.created_at := now(); src.updated_at := now();
          INSERT INTO jobs SELECT (src).*;
        END LOOP;
      END $$`);
    j.step('in-flight jobs filled to the cap', 'info', `${inflight} + ${need} fillers`);

    const puts = [];
    page.on('request', (r) => {
      if (r.method() === 'PUT') puts.push(r.url().split('?')[0]);
    });
    await uploadViaLanding(page, j, undefined, { expectJobPage: false });
    const shown = await page.locator('#job-msg.is-failed').waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const msg = (await page.locator('#job-msg').innerText().catch(() => '')).replace(/\s+/g, ' ');
    await j.shot(page, 'at-capacity');
    j.check('capacity refusal shown on the landing', shown, msg);
    j.check('copy says the site is at capacity and it is not the user\'s doing', /at capacity/i.test(msg) && /not something you did/i.test(msg), msg);
    j.check('refused before upload: no PUT to the bucket', puts.length === 0, puts.join(', ') || 'no PUT');
    j.check('the CTA offers a retry', /Try again/.test(await page.locator('#cta-label').innerText()), await page.locator('#cta-label').innerText());
  } catch (e) {
    j.step('journey aborted', 'fail', String(e).slice(0, 400));
    await j.shot(page, 'abort');
  } finally {
    try {
      sql(`DELETE FROM jobs WHERE original_filename='${TAG}'`);
      stack('worker');
    } catch (e) {
      j.note(`restore failed: ${e}`);
    }
    await ctx.close();
  }
  return j.result(log);
}
