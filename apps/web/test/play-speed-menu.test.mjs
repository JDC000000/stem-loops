// Phase C C1 (Beta): the Speed control in the player ⋯ menu and the speed pill.
// Rendered from the real module graph, like play-player-screen.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildModuleGraph } from './helpers/module-graph.mjs';
import { withDom } from './helpers/dom.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');

const graph = buildModuleGraph({
  name: 'play-speed-menu',
  entries: ['components/play/Player.tsx'],
  overrides: {
    'components/ChordOverlay.tsx': `import { createElement } from 'react';
      export const ChordOverlay = (props) => createElement('div', { 'data-testid': 'chord-overlay', 'data-view': String(props.view) });
      export default ChordOverlay;`,
    'lib/play/report-failure.ts': 'export function reportStemFetchFailure() {}',
  },
});

const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const Player = await import(graph.url('components/play/Player.tsx'));

const STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const snap = (over = {}) => ({
  status: 'ready', positionSec: 20, durationSec: 120,
  stems: STEMS.map((name) => ({ name, availability: 'ready', gain: 0.8, muted: false, soloed: false, effectivelySilent: false })),
  loop: null, degraded: null, error: null, ...over,
});
const noop = () => {};
const viewProps = (over = {}) => ({
  jobId: 'job-1', phase: { kind: 'ready' }, snapshot: snap(), sections: [{ startSec: 0, endSec: 60, label: 'verse' }, { startSec: 60, endSec: 120, label: 'chorus' }],
  onPlay: noop, onPause: noop, onSeek: noop, onGain: noop, onMute: noop, onSolo: noop, onLoop: noop,
  title: 'Lucky Ticket', ...over,
});
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const openMenu = async (dom) => dom.act(() => dom.find('[data-testid="player-more"]').click());

test('⋯ → Speed: 100% · 90% · 75% (Beta); no 50%; picking calls onSpeed; the playing speed is pressed', async () => {
  await withDom(async (dom) => {
    const picks = [];
    await dom.mount(React.createElement(Player.PlayerView, viewProps({ onSpeed: (r) => picks.push(r) })));
    await openMenu(dom);
    const group = dom.find('[data-testid="speed-group"]');
    assert.ok(group, 'Speed group in the menu');
    assert.equal(group.getAttribute('role'), 'group');
    assert.match(dom.find('#player-speed').textContent, /^Speed\s*Beta$/);
    const buttons = [...group.querySelectorAll('button')];
    assert.deepEqual(buttons.map((b) => b.textContent), ['100%', '90%', '75%']);
    assert.equal(group.querySelector('[data-testid="speed-50"]'), null, '50% is not offered');
    assert.ok(!/50%/.test(group.textContent));
    assert.equal(dom.find('[data-testid="speed-100"]').getAttribute('aria-pressed'), 'true');
    assert.equal(dom.find('[data-testid="speed-75"]').getAttribute('aria-pressed'), 'false');
    await dom.act(() => dom.find('[data-testid="speed-75"]').click());
    await dom.act(() => dom.find('[data-testid="speed-90"]').click());
    await dom.act(() => dom.find('[data-testid="speed-100"]').click());
    assert.deepEqual(picks, [0.75, 0.9, 1]);
    await dom.unmountAll();
    await dom.mount(React.createElement(Player.PlayerView, viewProps({ onSpeed: noop, snapshot: snap({ playbackRate: 0.75 }) })));
    await openMenu(dom);
    assert.equal(dom.find('[data-testid="speed-75"]').getAttribute('aria-pressed'), 'true');
    assert.equal(dom.find('[data-testid="speed-100"]').getAttribute('aria-pressed'), 'false');
  });
});

test('no Speed control where the browser cannot slow down (no onSpeed)', async () => {
  await withDom(async (dom) => {
    await dom.mount(React.createElement(Player.PlayerView, viewProps()));
    await openMenu(dom);
    assert.equal(dom.find('[data-testid="speed-group"]'), null);
    assert.ok(dom.find('#player-menu'), 'the rest of the menu is still there');
  });
});

test('speed pill next to the play state only when not 100%', () => {
  const at100 = renderToStaticMarkup(React.createElement(Player.PlayerView, viewProps({ onSpeed: noop })));
  assert.ok(!at100.includes('data-testid="transport-speed"'));
  assert.match(at100, /data-testid="transport-time" aria-hidden="true"/, '100%: the time row is exactly as before');
  for (const [rate, label] of [[0.9, '90%'], [0.75, '75%']]) {
    const h = renderToStaticMarkup(React.createElement(Player.PlayerView, viewProps({ onSpeed: noop, snapshot: snap({ playbackRate: rate }) })));
    const m = h.match(/data-testid="transport-speed">(.*?)<\/span><\/span>|data-testid="transport-speed">(.*?)<\/span>/s);
    assert.ok(h.includes('data-testid="transport-speed"'), `pill at ${label}`);
    assert.ok(h.includes(label));
    assert.ok(m);
  }
});

test('styles: selected = #222 fill + 2px #fff edge (brand tokens), ≥44 px targets, pill neutral (no lime / amber), no animation', () => {
  const css = read('src/components/play/Player.module.css');
  const seg = css.match(/\.segment \{[^}]*\}/)[0];
  assert.match(seg, /min-height: var\(--touch-min, 44px\)/);
  assert.match(seg, /border: 2px solid/);
  const pressed = css.match(/\.segment\[aria-pressed='true'\] \{[^}]*\}/)[0];
  assert.match(pressed, /background: var\(--bg-selected\)/);
  assert.match(pressed, /border-color: var\(--text-primary\)/);
  assert.match(css, /\.segmented3 \{\s*grid-template-columns: 1fr 1fr 1fr;/);
  const tcss = read('src/components/play/Transport.module.css');
  const pill = tcss.match(/\.speed \{[^}]*\}/)[0];
  assert.ok(!/accent|lime|amber|warn|transition|animation/i.test(pill), pill);
  const beta = css.match(/\.beta \{[^}]*\}/)[0];
  assert.ok(!/accent|lime|amber|warn|background/i.test(beta), beta);
});
