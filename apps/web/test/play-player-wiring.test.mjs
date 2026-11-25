// #381 delta review D1 residue: two wiring gaps where a dropped prop survived
// the suite. `Player` (the hook-owning component) is not renderable under
// node:test (its phase leaves `idle` only from effects), so the wiring is
// pinned from source: the <PlayerView .../> element `Player` returns.
//   1. getEngineLatencySec must reach the count-in (PlayerView -> PlayerScreen).
//   2. #383 onSpeed must be passed, and only while speedAvailable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLAYER = process.env.PLAYER_SRC_OVERRIDE ?? join(WEB, 'src/components/play/Player.tsx');
const src = readFileSync(PLAYER, 'utf8');
const screen = readFileSync(join(WEB, 'src/components/play/PlayerScreen.tsx'), 'utf8');

// The JSX element Player() returns: from `<PlayerView` to its self-closing `/>`.
const open = src.indexOf('<PlayerView\n');
assert.ok(open > 0, 'Player must return a <PlayerView> element');
const view = src.slice(open, src.indexOf('/>', open));

test('Player passes getEngineLatencySec (the callback it defines) to PlayerView for the count-in', () => {
  assert.match(src, /const getEngineLatencySec = useCallback\(/);
  assert.match(view, /\bgetEngineLatencySec=\{getEngineLatencySec\}/);
});

test('PlayerView forwards its props to PlayerScreen, which feeds the latency into the count-in timing', () => {
  assert.match(src, /<PlayerScreen \{\.\.\.props\}/);
  assert.match(screen, /engineLatRef\.current = getEngineLatencySec/);
  assert.match(screen, /engineLatencySec: engineLatRef\.current\?\.\(\) \?\? 0/);
});

test('Player wires onSpeed into PlayerView only while speedAvailable (#383)', () => {
  assert.match(src, /const onSpeed = useCallback\(/);
  assert.match(view, /\{\.\.\.\(speedAvailable \? \{ onSpeed \} : \{\}\)\}/);
});

test('the onSpeed handler sets the engine rate, persists it, and hides Speed when the engine cannot change it', () => {
  const h = src.slice(src.indexOf('const onSpeed = useCallback('), src.indexOf('P1.2 — Screen Wake Lock'));
  assert.match(h, /engine\.setPlaybackRate\(rate\)/);
  assert.match(h, /writeSpeed\(jobId, rate\)/);
  assert.match(h, /canChangeSpeed === false\) setSpeedAvailable\(false\)/);
});
