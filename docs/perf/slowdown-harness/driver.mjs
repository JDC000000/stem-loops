// C1 perf driver. One headless Chrome at a time. 390x844 mobile, 4x CPU throttle (real-time runs).
import { chromium } from 'playwright-core'; import fs from 'node:fs';
const OUT = '/home/claude/s19b/c1-harness/results';
const URL = 'http://127.0.0.1:8771/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOAD = () => fs.readFileSync('/proc/loadavg', 'utf8').trim();
async function launch() {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info', '--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--enable-blink-features=AudioContextPlayoutStats'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage(); page.on('pageerror', (e) => console.log('pageerror', e.message)); page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
  await page.goto(URL); await page.waitForFunction(() => window.setupEngine);
  const bcdp = await browser.newBrowserCDPSession();
  return { browser, page, bcdp };
}
const procs = async (bcdp) => (await bcdp.send('SystemInfo.getProcessInfo')).processInfo;

// Group per-channel onsets into markers (within 0.5 s); spread = max-min across the 6 stems.
function groups(onsets) {
  const pts = onsets.slice().sort((a, b) => a[1] - b[1]); const gs = []; let g = null;
  for (const [c, t] of pts) { if (!g || t - g.t0 > 0.5) { g = { t0: t, by: {} }; gs.push(g); } if (!(c in g.by)) g.by[c] = t; }
  return gs.map((x) => { const v = Object.values(x.by); return { t: Math.min(...v), n: v.length, spreadMs: (Math.max(...v) - Math.min(...v)) * 1000, by: x.by }; });
}
// Engine clock at context time t from the anchor in force then.
function posAt(anchors, t) { let a = null; for (const x of anchors) if (x.t <= t) a = x; if (!a || a.status !== 'playing') return null;
  const el = t - a.startCtxTime; let p = a.startOffset + (el > 0 ? el * a.rate : 0);
  if (a.loop && p > a.loop.endSec) p = a.loop.startSec + ((p - a.loop.startSec) % (a.loop.endSec - a.loop.startSec)); return p; }

async function rt(rate, playSec, sr) {
  const { browser, page, bcdp } = await launch();
  const r = { kind: 'rt', rate, playSec, sr, throttle: 4, loadBefore: LOAD() };
  const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.evaluate((s) => window.setupEngine(s), sr);
  await page.evaluate(() => { window.engine.play(); window.anchor('play'); });
  await sleep(8000);
  const cpu0 = await procs(bcdp); const w0 = Date.now();
  const other = rate === 0.75 ? 0.9 : 0.75;
  const events = [];
  r.firstSwitch = await page.evaluate((x) => window.setRate(x), rate); events.push({ what: `rate ${rate} (first: builds + warms nodes)`, T: r.firstSwitch.T });
  // Script over playSec: seeks, pause/play, loop on/off, 100% and back, other speed and back.
  const plan = [
    [20, 'seek', 100], [40, 'pause'], [43, 'play'], [60, 'seek', 30], [80, 'rate', 1], [90, 'rate', rate], [110, 'seek', 200],
    [130, 'loopOn'], [160, 'loopOff'], [180, 'rate', other], [195, 'rate', rate], [215, 'seek', 12], [235, 'pause'], [238, 'play'],
    [255, 'seek', 150], [270, 'rate', 1], [280, 'rate', rate],
  ].filter(([t]) => t < playSec - 8);
  const t0 = Date.now(); const switches = [];
  for (const [at, what, arg] of plan) {
    const wait = at * 1000 - (Date.now() - t0); if (wait > 0) await sleep(wait);
    if (what === 'rate') { const s = await page.evaluate((x) => window.setRate(x), arg); switches.push({ to: arg, ...s }); events.push({ what: `rate ${arg}`, T: s.T }); }
    else { const a = await page.evaluate(([w, x]) => window.act(w, x), [what, arg]); events.push({ what: what + (arg != null ? ' ' + arg : ''), T: a.t }); }
  }
  const rest = playSec * 1000 - (Date.now() - t0); if (rest > 0) await sleep(rest);
  const cpu1 = await procs(bcdp); const wall = (Date.now() - w0) / 1000;
  r.cpu = {}; for (const p of cpu1) { const q = cpu0.find((x) => x.id === p.id); if (q) r.cpu[`${p.type}`] = +((r.cpu[p.type] || 0) + 100 * (p.cpuTime - q.cpuTime) / wall).toFixed(1); }
  r.playoutStats = await page.evaluate(() => { const s = window.ctx.playbackStats || window.ctx.playoutStats; return s ? { underrunDuration: s.underrunDuration, underrunEvents: s.underrunEvents, totalDuration: s.totalDuration } : null; });
  r.heapMiB = (await page.evaluate(() => window.heap())) / 2 ** 20;
  const onsets = await page.evaluate(() => window.onsets); const anchors = await page.evaluate(() => window.anchors);
  r.nodesCreated = await page.evaluate(() => window.created.length);
  r.switches = switches; r.events = events; r.loadAfter = LOAD();
  const firstT = r.firstSwitch.T + 0.3;
  const gs = groups(onsets).filter((g) => g.t > firstT);
  const slowGs = gs.filter((g) => { const a = anchors.filter((x) => x.t <= g.t).at(-1); return a && a.rate !== 1; });
  const full = slowGs.filter((g) => g.n === 6);
  r.markers = { slowGroups: slowGs.length, complete: full.length, spreadMaxMs: Math.max(...full.map((g) => g.spreadMs)), spreadMeanMs: full.reduce((s, g) => s + g.spreadMs, 0) / full.length,
    spreadP95Ms: full.map((g) => g.spreadMs).sort((a, b) => a - b)[Math.floor(full.length * 0.95)] };
  r.groupsDetail = slowGs.map((g) => { const v = Object.values(g.by).sort((a, b) => a - b); const med = v[Math.floor(v.length / 2)];
    return { t: +g.t.toFixed(2), n: g.n, spreadMs: +g.spreadMs.toFixed(1), offs: Object.fromEntries(Object.entries(g.by).map(([c, t]) => [c, +((t - med) * 1000).toFixed(1)])) }; });
  // First marker after every event (seek / rate / pause / loop), at reduced speed.
  r.firstAfterEvent = events.map((e) => { const g = gs.find((x) => x.t > e.T + 0.02); const a = g && anchors.filter((x) => x.t <= g.t).at(-1); return { what: e.what, n: g?.n ?? 0, spreadMs: g ? +g.spreadMs.toFixed(1) : null, rate: a?.rate ?? null, afterMs: g ? +((g.t - e.T) * 1000).toFixed(0) : null }; });
  // G2: engine positionSec at the moment a marker is HEARD vs the marker's song time (2.5 + 5k s). Median over the 6 stems.
  r.g2 = gs.filter((g) => g.n === 6).map((g) => { const ts = Object.values(g.by).sort((a, b) => a - b); const tm = ts[3]; const p = posAt(anchors, tm); if (p == null) return null; const k = Math.round((p - 2.5) / 5); const a = anchors.filter((x) => x.t <= tm).at(-1); return { rate: a.rate, errMs: +((p - (2.5 + 5 * k)) * 1000).toFixed(1) }; }).filter(Boolean);
  const byRate = {}; for (const x of r.g2) (byRate[x.rate] ||= []).push(x.errMs);
  r.g2Summary = Object.fromEntries(Object.entries(byRate).map(([k, v]) => { const s = v.slice().sort((a, b) => a - b); return [k, { n: v.length, medianMs: s[Math.floor(s.length / 2)], minMs: s[0], maxMs: s.at(-1) }]; }));
  r.log = await page.evaluate(() => window.log);
  r.raw = { onsets, anchors };
  await browser.close(); return r;
}

async function latency() {
  const { browser, page } = await launch(); const out = [];
  for (const sr of [24000, 48000]) for (const rate of [0.9, 0.75]) for (const feed of [true, false]) out.push(await page.evaluate(([a, b, c]) => window.offlineLatency(a, b, c), [sr, rate, feed]));
  await browser.close(); return out;
}

const phase = process.argv[2]; let res;
if (phase === 'latency') res = await latency();
else res = await rt(+process.argv[3], +(process.argv[4] || 300), +(process.argv[5] || 24000));
const f = `${OUT}/${phase}-${process.argv[3] || ''}-${Date.now()}.json`; fs.writeFileSync(f, JSON.stringify(res, null, 1));
console.log(JSON.stringify(phase === 'latency' ? res : { ...res, events: undefined, g2: undefined, raw: undefined, groupsDetail: undefined }, null, 0)); console.log('saved', f);
