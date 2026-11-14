#!/usr/bin/env node
// Runner for the browser journeys. Not part of `pnpm test` (CI's glob is test/*.test.mjs).
//
//   node journeys/run.mjs                 # every journey, in order
//   node journeys/run.mjs j1 j5           # a subset, by id prefix
//
// Needs a running LOCAL stack and the JOURNEY_* environment described in lib.mjs.
// Writes <JOURNEY_EVIDENCE_DIR>/summary.json and summary.md. Exit code 0 only when every
// selected journey ran and none failed; a subset run says "PARTIAL RUN" in the summary.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeBrowser, EVIDENCE } from './lib.mjs';

const ALL = [
  'j1-first-run',
  'j2-anonymous',
  'j3-job-states',
  'j4-capacity',
  'j5-account',
  'j6-pricing',
  'j7-mobile',
  'j8-a11y',
];

const want = process.argv.slice(2);
const selected = want.length ? ALL.filter((id) => want.some((w) => id.startsWith(w))) : ALL;
mkdirSync(EVIDENCE, { recursive: true });

if (!process.env.JOURNEY_AUDIO || !existsSync(process.env.JOURNEY_AUDIO)) {
  // Generated, never committed (AGENTS.md: no audio outside fixtures/): ~40 s at 120 BPM —
  // a kick on every beat, a bass note per bar and a sustained C-major triad, enough for the
  // extractor's 8-bar minimum and for the chord stage.
  const out = join(EVIDENCE, 'journey-song-40s-120bpm.mp3');
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*55*t)*exp(-30*mod(t,0.5))':d=40:s=44100",
    '-f', 'lavfi', '-i', "aevalsrc='0.3*sin(2*PI*65.41*t)*(mod(t,2)<1.6)':d=40:s=44100",
    '-f', 'lavfi', '-i', "aevalsrc='0.12*(sin(2*PI*261.63*t)+sin(2*PI*329.63*t)+sin(2*PI*392*t))':d=40:s=44100",
    '-filter_complex', 'amix=inputs=3:normalize=0', '-ac', '2', '-b:a', '192k', out,
  ]);
  process.env.JOURNEY_AUDIO = out;
}

const results = [];
for (const id of selected) {
  console.log(`\n▶ ${id}`);
  const mod = await import(`./${id}.mjs`);
  try {
    results.push(await mod.default());
  } catch (e) {
    results.push({ id, verdict: 'FAIL', steps: [{ name: 'crashed', status: 'fail', detail: String(e) }] });
  }
  // A fresh browser per journey: after j7's touch/mobile contexts, j8's file-chooser
  // interception stopped firing in the same browser (reproduced j7→j8; j8 alone passes).
  await closeBrowser();
}
await closeBrowser();

const partial = selected.length !== ALL.length;
const failed = results.filter((r) => r.verdict.startsWith('FAIL'));
const md = [
  `# Browser journeys — ${new Date().toISOString()}`,
  '',
  partial ? `**PARTIAL RUN** (${selected.join(', ')}) — not a full result.` : 'Full run.',
  'CSP bypassed for loopback mock hosts (`bypassCSP: true`); session by cookie injection; signup and the login form not exercised (hCaptcha fails closed).',
  '',
  '| journey | verdict | pass | fail | not reached |',
  '|---|---|---|---|---|',
  ...results.map((r) => {
    const c = (s) => r.steps.filter((x) => x.status === s).length;
    return `| ${r.id} | ${r.verdict} | ${c('pass')} | ${c('fail')} | ${c('not-reached')} |`;
  }),
  '',
  ...results.flatMap((r) => [
    `## ${r.id}`,
    ...r.steps.map((s) => `- **${s.status.toUpperCase()}** ${s.name}${s.detail ? ` — ${s.detail}` : ''}`),
    ...(r.notes ?? []).map((n) => `- note: ${n}`),
    ...((r.console_errors ?? []).length ? [`- console errors: ${r.console_errors.length} (see result.json)`] : []),
    '',
  ]),
].join('\n');
writeFileSync(join(EVIDENCE, 'summary.md'), md);
writeFileSync(join(EVIDENCE, 'summary.json'), JSON.stringify({ partial, results }, null, 2));
console.log(`\n${results.length} journeys, ${failed.length} failed${partial ? ' (PARTIAL RUN)' : ''}. Summary: ${join(EVIDENCE, 'summary.md')}`);
process.exit(failed.length || partial ? 1 : 0);
