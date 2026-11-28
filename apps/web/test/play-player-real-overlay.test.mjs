// #498 (residue of #497): the #496 / #498 chord gates in play-player-screen.test.mjs run against a
// STUBBED ChordOverlay that reports `onHasChords(!globalThis.__noChords)`. This file runs the same
// gates against the REAL overlay (components/ChordOverlay.tsx) and the REAL play-chords loader,
// with only `fetch` stubbed, so "the song has chords" is decided by the code that ships:
//   - a 404 from /api/jobs/:id/play-chords (no artifact)      -> no chords
//   - an artifact whose segments are all "N" (no chord)        -> no chords
//   - the committed golden artifact (fixtures/contracts)       -> chords
// Phone: the ⋯ menu's chord items and its accessible name. Desktop: the aside's "Show all chords".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildModuleGraph } from './helpers/module-graph.mjs';
import { withDom } from './helpers/dom.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = JSON.parse(readFileSync(join(WEB, '..', '..', 'fixtures', 'contracts', 'play-chords.golden.json'), 'utf8'));

// ChordOverlay is NOT overridden here: that is the point of this file.
const graph = buildModuleGraph({
  name: 'play-player-real-overlay',
  entries: ['components/play/Player.tsx'],
  overrides: {
    'lib/play/report-failure.ts': 'export function reportStemFetchFailure() {}',
  },
});

const React = (await import('react')).default;
const Player = await import(graph.url('components/play/Player.tsx'));

const STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'];
const SECTIONS = [
  { startSec: 0, endSec: 9, label: 'intro' },
  { startSec: 9, endSec: 47, label: 'verse' },
];
const noop = () => {};
const viewProps = () => ({
  jobId: 'job-1',
  phase: { kind: 'ready' },
  snapshot: {
    status: 'ready', positionSec: 1, durationSec: 120, loop: null, degraded: null, error: null,
    stems: STEMS.map((name) => ({ name, availability: 'ready', gain: 0.8, muted: false, soloed: false, effectivelySilent: false })),
  },
  sections: SECTIONS,
  onPlay: noop, onPause: noop, onSeek: noop, onGain: noop, onMute: noop, onSolo: noop, onLoop: noop, onSpeed: noop,
  title: 'Lucky Ticket', bpm: 100, musicalKey: 'C major',
});

const NO_ARTIFACT = { label: '404 (no artifact)', route: { ok: false, status: 404, json: async () => ({ reason: 'not_attempted' }) } };
const ALL_N = {
  label: 'artifact with only "N" segments',
  payload: { ...GOLDEN.payload, segments: GOLDEN.payload.segments.map((s) => ({ ...s, label: 'N' })) },
};
const WITH_CHORDS = { label: 'the committed golden artifact', payload: GOLDEN.payload };

/** Mount PlayerView with the real overlay behind a stubbed fetch; run `check`; restore fetch. */
async function withSong(source, desktop, check) {
  await withDom(async (dom) => {
    globalThis.matchMedia = () => ({ matches: desktop, addEventListener() {}, removeEventListener() {} });
    const hadFetch = Object.prototype.hasOwnProperty.call(globalThis, 'fetch');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/play-chords')) return source.route ?? { ok: true, status: 200, json: async () => ({ signed_url: '/signed', expires_in_sec: 60 }) };
      return { ok: true, status: 200, json: async () => source.payload };
    };
    try {
      await dom.mount(React.createElement(Player.PlayerView, viewProps()));
      // Let the loader's two fetches resolve and the overlay's onHasChords effect land.
      for (let i = 0; i < 4; i += 1) await dom.act();
      await check(dom);
      await dom.unmountAll();
    } finally {
      if (hadFetch) globalThis.fetch = realFetch;
      else delete globalThis.fetch;
    }
  });
}

const menuItems = (dom) => dom.findAll('#player-menu button').map((b) => b.textContent);
const asideItems = (dom) => [...dom.find('aside[aria-labelledby="mix-h"]').querySelectorAll('button')].map((b) => b.textContent);

for (const source of [NO_ARTIFACT, ALL_N]) {
  test(`#498 real overlay, ${source.label}: phone ⋯ has no chord items and its name promises none`, async () => {
    await withSong(source, false, async (dom) => {
      assert.equal(dom.find('[data-testid="player-more"]').getAttribute('aria-label'), 'More: speed, song info, count-in, rename parts, set lists');
      await dom.act(() => dom.find('[data-testid="player-more"]').click());
      assert.ok(!menuItems(dom).includes('See all chords'), menuItems(dom).join(' | '));
      assert.equal(dom.find('[data-testid="chord-mode-simple"]'), null);
      assert.equal(dom.find('[data-testid="transpose-group"]'), null);
      assert.ok(menuItems(dom).includes('Song info'));
    });
  });

  test(`#498 real overlay, ${source.label}: desktop aside has no "Show all chords"`, async () => {
    await withSong(source, true, async (dom) => {
      assert.equal(dom.find('[data-testid="player"]').dataset.layout, 'desktop');
      assert.ok(!asideItems(dom).includes('Show all chords'), asideItems(dom).join(' | '));
    });
  });
}

test('#498 real overlay, the committed golden artifact: phone ⋯ offers the chord items and says so', async () => {
  await withSong(WITH_CHORDS, false, async (dom) => {
    assert.equal(dom.find('[data-testid="player-more"]').getAttribute('aria-label'), 'More: all chords, speed, song info, count-in, rename parts, set lists');
    await dom.act(() => dom.find('[data-testid="player-more"]').click());
    assert.ok(menuItems(dom).includes('See all chords'), menuItems(dom).join(' | '));
    assert.ok(dom.find('[data-testid="chord-mode-simple"]'));
    assert.ok(dom.find('[data-testid="transpose-group"]'));
  });
});

test('#498 real overlay, the committed golden artifact: desktop aside offers "Show all chords"', async () => {
  await withSong(WITH_CHORDS, true, async (dom) => {
    assert.ok(asideItems(dom).includes('Show all chords'), asideItems(dom).join(' | '));
  });
});
