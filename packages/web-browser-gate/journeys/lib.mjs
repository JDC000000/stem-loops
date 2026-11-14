// Shared helpers for the W4 browser journeys (real Chromium via Playwright).
//
// These journeys drive a LOCAL stack only (next start + a worker + mocks on 127.0.0.1).
// They are deliberately outside CI's test glob (`test/*.test.mjs`): wiring them into CI
// needs ci.yml and a stack bring-up step, which is a separate decision.
//
// Two compromises, recorded in every result file:
//   1. `bypassCSP: true`. The app's CSP `connect-src` allows *.supabase.co and
//      *.r2.cloudflarestorage.com, not http://127.0.0.1:*, so against loopback mocks the
//      browser's direct PUT to the bucket and the Supabase client call are blocked. The
//      bypass exists ONLY for that loopback-host problem; CSP itself is not under test.
//   2. Session by cookie injection. Signup and the login form cannot be driven: hCaptcha
//      fails closed with no key. The cookie is minted by an external command
//      (JOURNEY_MINT_CMD, e.g. P0's mint_session.py) against a fake GoTrue.
//
// Environment:
//   JOURNEY_BASE_URL     web origin, must be http://127.0.0.1:<port>      (default http://127.0.0.1:3104)
//   JOURNEY_DB_URL       loopback Postgres URL for state reads/writes     (required by journeys that use it)
//   JOURNEY_MINT_CMD     command that takes `<email>` and prints JSON {cookie,user_id}
//   JOURNEY_STACK_CMD    command taking `worker [K=V..]` | `stopworker` | `ctl <json>` (fault injection)
//   JOURNEY_EVIDENCE_DIR where screenshots and result JSON go
//   JOURNEY_AUDIO        path to a ~40 s audio file to upload
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

export const BASE = process.env.JOURNEY_BASE_URL ?? 'http://127.0.0.1:3104';
export const EVIDENCE = process.env.JOURNEY_EVIDENCE_DIR ?? join(process.cwd(), 'journey-evidence');
export const AUDIO = process.env.JOURNEY_AUDIO ?? '';

function assertLoopback(url, what) {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new Error(`${what} must be loopback, got ${u.hostname}`);
  }
}
assertLoopback(BASE, 'JOURNEY_BASE_URL');

let xffSeq = Math.floor(Math.random() * 200);
/** A distinct client IP per context, so the per-IP rate limits (5 jobs/min) don't couple journeys. */
export function nextClientIp() {
  xffSeq = (xffSeq + 1) % 250;
  return `10.44.${Math.floor(Math.random() * 250)}.${xffSeq + 1}`;
}

export function sql(query) {
  const url = process.env.JOURNEY_DB_URL;
  if (!url) throw new Error('JOURNEY_DB_URL is not set');
  assertLoopback(url.replace(/^postgres(ql)?:/, 'http:'), 'JOURNEY_DB_URL');
  return execFileSync('psql', [url, '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { encoding: 'utf8' }).trim();
}

export function stack(...args) {
  const cmd = process.env.JOURNEY_STACK_CMD;
  if (!cmd) throw new Error('JOURNEY_STACK_CMD is not set');
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 60_000 });
}

/** Mint a signed-in user. Returns { cookies, user_id, email }. */
export function mintUser(tag) {
  const cmd = process.env.JOURNEY_MINT_CMD;
  if (!cmd) throw new Error('JOURNEY_MINT_CMD is not set');
  const email = `w4-${tag}-${Date.now().toString(36)}@example.test`;
  const out = JSON.parse(execFileSync(cmd, [email], { encoding: 'utf8' }));
  const host = new URL(BASE).hostname;
  const cookies = out.cookie.split(/;\s*/).filter(Boolean).map((kv) => {
    const i = kv.indexOf('=');
    return { name: kv.slice(0, i), value: kv.slice(i + 1), domain: host, path: '/', httpOnly: false, sameSite: 'Lax' };
  });
  return { cookies, user_id: out.user_id, email };
}

let browser = null;
export async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      // Lets an AudioContext start in a headless run; a real user's click does the same.
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
  }
  return browser;
}
export async function closeBrowser() {
  if (browser) await browser.close();
  browser = null;
}

/**
 * A fresh context. `user` (from mintUser) signs it in by cookie; omit for anonymous.
 * Records every console error and failed/5xx response for the result file.
 */
export async function newContext({ user = null, viewport = { width: 1280, height: 900 }, deviceScaleFactor = 1, isMobile = false, hasTouch = false } = {}) {
  const b = await getBrowser();
  const ctx = await b.newContext({
    baseURL: BASE,
    bypassCSP: true, // see header: loopback mock hosts only
    viewport,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    acceptDownloads: true,
    extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() },
  });
  if (user) await ctx.addCookies(user.cookies);
  const log = { console: [], http: [] };
  ctx.on('page', (p) => attachLog(p, log));
  return { ctx, log };
}

function attachLog(page, log) {
  page.on('console', (m) => {
    if (m.type() === 'error') log.console.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => log.console.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on('response', (r) => {
    if (r.status() >= 400) log.http.push(`${r.status()} ${r.request().method()} ${r.url().replace(/X-Amz-[^&]+/g, '')}`.slice(0, 200));
  });
}

/** Records the GainNode targets the play engine asks for, so mute/solo/volume can be checked as audio, not just as aria state. */
export const GAIN_PROBE = () => {
  const gains = [];
  window.__w4gains = gains;
  const origCreate = AudioContext.prototype.createGain;
  AudioContext.prototype.createGain = function (...a) {
    const g = origCreate.apply(this, a);
    const rec = { idx: gains.length, target: 1 };
    gains.push(rec);
    const p = g.gain;
    for (const m of ['setValueAtTime', 'setTargetAtTime', 'linearRampToValueAtTime']) {
      const orig = p[m].bind(p);
      p[m] = (v, ...rest) => {
        rec.target = v;
        return orig(v, ...rest);
      };
    }
    return g;
  };
};

/** A journey's step recorder. */
export class Journey {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.steps = [];
    this.notes = [];
    this.dir = join(EVIDENCE, id);
    mkdirSync(this.dir, { recursive: true });
    this.started = new Date().toISOString();
  }
  /** status: 'pass' | 'fail' | 'not-reached' | 'info' */
  step(name, status, detail = '') {
    this.steps.push({ name, status, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
    const tag = { pass: 'PASS', fail: 'FAIL', 'not-reached': 'N/R ', info: 'INFO' }[status] ?? status;
    console.log(`  [${tag}] ${this.id} · ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`.slice(0, 600));
  }
  check(name, cond, detail = '') {
    this.step(name, cond ? 'pass' : 'fail', detail);
    return !!cond;
  }
  note(s) {
    this.notes.push(s);
  }
  async shot(page, name, opts = {}) {
    const p = join(this.dir, `${name}.png`);
    await page.screenshot({ path: p, fullPage: opts.fullPage ?? true }).catch((e) => this.note(`screenshot ${name} failed: ${e}`));
    return p;
  }
  async text(page, name) {
    const t = await page.locator('main, body').first().innerText().catch(() => '');
    writeFileSync(join(this.dir, `${name}.txt`), t);
    return t;
  }
  result(log) {
    const failed = this.steps.filter((s) => s.status === 'fail').length;
    const passed = this.steps.filter((s) => s.status === 'pass').length;
    const nr = this.steps.filter((s) => s.status === 'not-reached').length;
    const r = {
      id: this.id,
      title: this.title,
      started: this.started,
      finished: new Date().toISOString(),
      verdict: failed ? 'FAIL' : passed ? (nr ? 'PASS (partial: not-reached steps)' : 'PASS') : 'NOT RUN',
      csp_bypassed: true,
      session: 'cookie injection (fake GoTrue); login form and signup not exercised (hCaptcha fails closed)',
      steps: this.steps,
      notes: this.notes,
      console_errors: log?.console ?? [],
      http_errors: log?.http ?? [],
    };
    writeFileSync(join(this.dir, 'result.json'), JSON.stringify(r, null, 2));
    return r;
  }
}

/** Upload AUDIO through the landing page's real file input and wait for the job page. Returns the job id. */
export async function uploadViaLanding(page, j, audioPath = AUDIO, { expectJobPage = true } = {}) {
  await page.goto('/');
  await page.locator('#file').setInputFiles(audioPath);
  await page.locator('#picked-name').waitFor({ state: 'visible', timeout: 10_000 });
  // the duration probe holds submit shut; the CTA label returns to "Separate and play"
  await page.waitForFunction(() => document.querySelector('#cta-label')?.textContent === 'Separate and play', null, { timeout: 15_000 });
  await page.locator('#cta').click();
  if (!expectJobPage) return null;
  await page.waitForURL(/\/jobs\/[0-9a-f-]{36}/, { timeout: 60_000 });
  const id = page.url().match(/\/jobs\/([0-9a-f-]{36})/)[1];
  j.step('landing upload → job page', 'pass', `job ${id}`);
  return id;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
