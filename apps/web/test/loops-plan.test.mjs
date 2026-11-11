// The loop PLAN and the CUT — the arithmetic and the bytes behind /loops.
//
// WHY EVERY EXPECTED VALUE HERE IS WRITTEN OUT BY HAND.
// The obvious way to check `planLoops` is to recompute each figure with
// `barSeconds` and compare. That proves only that the module applied its own
// rule consistently; it cannot see whether the rule is right, and it stays
// green when the rule changes in both places at once. That exact defect
// blocked #207 twice. So the numbers below are independent: 120 BPM is two
// beats a second, so a bar of 4/4 is 2.000 s and a 4-bar loop is 8.000 s, and
// 8 s of 48 kHz mono 24-bit PCM is 8 x 48000 x 3 = 1,152,000 bytes plus a
// 44-byte header. None of them is produced by the code under test.
//
// The WAV gates read the emitted bytes back through a DataView, so they check
// the file a DAW would open rather than the shape of the function that wrote
// it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from './helpers/render-chrome.mjs';

const [planUrl, wavUrl, cutUrl] = compile(['lib/loops/plan', 'lib/loops/wav', 'lib/loops/cut']);
const plan = await import(planUrl);
const wav = await import(wavUrl);
const cut = await import(cutUrl);

const {
  LOOP_BAR_BANKS, BEATS_PER_BAR, LOOP_BIT_DEPTH, WAV_HEADER_BYTES,
  barSeconds, loopSeconds, wavByteLength, planLoops, banksOf,
  downbeatAnchorSec, slug, formatBytes, formatSeconds,
} = plan;

// ═════════════════════════════════════════════════════════════════════════
// 1. Constants — IMPORTED and compared, never matched against source text.
//    A regex over plan.ts would be satisfied by this very comment.
// ═════════════════════════════════════════════════════════════════════════

test('the four banks are 1, 2, 4 and 8 bars, in that order', () => {
  assert.deepEqual([...LOOP_BAR_BANKS], [1, 2, 4, 8]);
  assert.equal(BEATS_PER_BAR, 4);
  assert.equal(LOOP_BIT_DEPTH, 24);
  assert.equal(WAV_HEADER_BYTES, 44);
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Bar maths.
// ═════════════════════════════════════════════════════════════════════════

test('a bar of 4/4 is four beats, at tempos worked out by hand', () => {
  assert.equal(barSeconds(120), 2); // 120 bpm = 2 beats/s, 4 beats = 2 s
  assert.equal(barSeconds(60), 4);
  assert.equal(barSeconds(240), 1);
  assert.equal(barSeconds(90), 8 / 3);
  assert.equal(loopSeconds(120, 4), 8);
  assert.equal(loopSeconds(60, 8), 32);
  assert.equal(loopSeconds(240, 1), 1);
});

test('a tempo that is not a tempo is refused, not silently used', () => {
  for (const bad of [0, -120, NaN, Infinity, 39, 251, undefined, null]) {
    assert.throws(() => barSeconds(bad), RangeError, `accepted ${bad}`);
  }
  // The boundaries themselves are allowed.
  assert.equal(barSeconds(40), 6);
  assert.equal(barSeconds(250), 0.96);
});

test('wavByteLength is the header plus the frames', () => {
  assert.equal(wavByteLength(48000, 1, 24), 144044); // 48000 * 1 * 3 + 44
  assert.equal(wavByteLength(48000, 2, 24), 288044);
  assert.equal(wavByteLength(0, 1, 24), 44);
});

// ═════════════════════════════════════════════════════════════════════════
// 3. The plan itself.
// ═════════════════════════════════════════════════════════════════════════

const BASE = {
  bpm: 120,
  anchorSec: 0,
  durationSec: 180,
  sampleRate: 48000,
  channels: 1,
  title: 'My Song',
  musicalKey: 'C major',
};

test('a plan is 24 loops: four banks across six stems', () => {
  const specs = planLoops(BASE);
  assert.equal(specs.length, 24);
  assert.deepEqual(
    [...new Set(specs.map((s) => s.bars))],
    [1, 2, 4, 8],
  );
  assert.deepEqual(
    [...new Set(specs.map((s) => s.stem))],
    ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'],
  );
  // Every (stem, bank) pair exactly once — no duplicates, none missing.
  assert.equal(new Set(specs.map((s) => s.id)).size, 24);
});

test('durations and file sizes are the ones a hand calculation gives', () => {
  const specs = planLoops(BASE);
  const four = specs.find((s) => s.stem === 'drums' && s.bars === 4);
  assert.equal(four.durationSec, 8);
  assert.equal(four.startSec, 0);
  assert.equal(four.endSec, 8);
  assert.equal(four.frames, 384000); // 8 s x 48 kHz
  assert.equal(four.byteLength, 1152044); // 384000 x 1 x 3 + 44

  const one = specs.find((s) => s.stem === 'vocals' && s.bars === 1);
  assert.equal(one.durationSec, 2);
  assert.equal(one.frames, 96000);
  assert.equal(one.byteLength, 288044);

  const eight = specs.find((s) => s.stem === 'bass' && s.bars === 8);
  assert.equal(eight.durationSec, 16);
  assert.equal(eight.frames, 768000);
  assert.equal(eight.byteLength, 2304044);
});

test('the anchor moves every loop start, it is not decoration', () => {
  const specs = planLoops({ ...BASE, anchorSec: 0.4 });
  for (const s of specs) {
    assert.equal(s.startSec, 0.4, `${s.id} did not start at the anchor`);
    assert.equal(s.endSec, 0.4 + s.durationSec);
  }
});

test('a bank that does not fit inside the track is dropped, not truncated', () => {
  // 10 s of music at 120 bpm: 1, 2 and 4 bars fit (2, 4 and 8 s); 8 bars is 16 s.
  const specs = planLoops({ ...BASE, durationSec: 10 });
  assert.deepEqual([...new Set(specs.map((s) => s.bars))], [1, 2, 4]);
  assert.equal(specs.length, 18);
  // And with the anchor pushed late, the 4-bar bank goes too: 3 + 8 > 10.
  const late = planLoops({ ...BASE, durationSec: 10, anchorSec: 3 });
  assert.deepEqual([...new Set(late.map((s) => s.bars))], [1, 2]);
});

test('filenames name the stem, the bar count, the tempo and the key', () => {
  const specs = planLoops(BASE);
  const s = specs.find((x) => x.stem === 'drums' && x.bars === 4);
  assert.equal(s.filename, 'my-song_drums_4bar_120bpm_c-major.wav');
  // Every filename in a plan is distinct — 24 files land in one folder.
  assert.equal(new Set(specs.map((x) => x.filename)).size, 24);
  // No title and no key still produce a usable, non-empty name.
  const anon = planLoops({ ...BASE, title: null, musicalKey: null });
  assert.equal(anon[0].filename, 'stem-loops_drums_1bar_120bpm_unknown-key.wav');
});

test('slug keeps filenames to lowercase alphanumerics and dashes', () => {
  assert.equal(slug('My Song.mp3'), 'my-song-mp3');
  assert.equal(slug('  Ωmega / Track #2  '), 'mega-track-2');
  assert.equal(slug(''), 'stem-loops');
  assert.equal(slug(null), 'stem-loops');
  assert.equal(slug('!!!'), 'stem-loops');
  assert.equal(slug('---a---'), 'a');
  assert.ok(slug('x'.repeat(200)).length <= 60);
});

test('banksOf groups in bank order and omits what is not there', () => {
  const banks = banksOf(planLoops({ ...BASE, durationSec: 10 }));
  assert.deepEqual(banks.map((b) => b.bars), [1, 2, 4]);
  for (const b of banks) assert.equal(b.specs.length, 6);
});

// ═════════════════════════════════════════════════════════════════════════
// 4. Recovering the worker's downbeat from the rows it wrote.
// ═════════════════════════════════════════════════════════════════════════

test('the downbeat is recovered from loop rows, as the median of what they imply', () => {
  // bpm 120 -> bar 2 s. Rows that all imply an anchor of ~1.0 s.
  const rows = [
    { start_sec: '5.000', start_bar: 2 }, // 5 - 2*2 = 1.00
    { start_sec: '9.010', start_bar: 4 }, // 9.01 - 4*2 = 1.01
    { start_sec: '13.000', start_bar: 6 }, // 13 - 6*2 = 1.00
  ];
  assert.equal(downbeatAnchorSec(rows, 120), 1);
});

test('a row whose implied anchor is not inside one bar cannot drag the median', () => {
  const good = [
    { start_sec: '5.000', start_bar: 2 },
    { start_sec: '9.000', start_bar: 4 },
    { start_sec: '13.000', start_bar: 6 },
  ];
  // 7 - 0*2 = 7, which is 3.5 bars out: noise, not a grid origin.
  const withNoise = [...good, { start_sec: '7.000', start_bar: 0 }];
  assert.equal(downbeatAnchorSec(withNoise, 120), 1);
  // Unparseable rows are ignored rather than becoming NaN.
  assert.equal(
    downbeatAnchorSec([...good, { start_sec: null, start_bar: 1 }, {}, null], 120),
    1,
  );
});

test('with nothing usable the downbeat is 0, and never NaN', () => {
  for (const rows of [[], null, undefined, [{ start_sec: 'x', start_bar: 'y' }]]) {
    const a = downbeatAnchorSec(rows, 120);
    assert.equal(a, 0);
  }
  // An unusable tempo cannot produce a bar, so there is no anchor to recover.
  assert.equal(downbeatAnchorSec([{ start_sec: '5', start_bar: 2 }], 0), 0);
  assert.equal(downbeatAnchorSec([{ start_sec: '5', start_bar: 2 }], NaN), 0);
});

// ═════════════════════════════════════════════════════════════════════════
// 5. Labels.
// ═════════════════════════════════════════════════════════════════════════

test('durations and sizes are labelled the way the card shows them', () => {
  assert.equal(formatSeconds(8), '8.00 s');
  assert.equal(formatSeconds(0.75), '0.75 s');
  assert.equal(formatBytes(44), '44 B');
  assert.equal(formatBytes(288044), '288 KB');
  assert.equal(formatBytes(1152044), '1.2 MB');
});

// ═════════════════════════════════════════════════════════════════════════
// 6. The WAV bytes, read back as a decoder reads them.
// ═════════════════════════════════════════════════════════════════════════

const { encodeWav24, floatToPcm24, PCM24_MAX, PCM24_MIN } = wav;

/** Read a little-endian signed 24-bit sample at a byte offset. */
function readPcm24(view, offset) {
  const raw = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
  return raw & 0x800000 ? raw - 0x1000000 : raw;
}
const ascii = (view, at, len) =>
  String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(at + i)));

test('the header is a canonical 44-byte PCM RIFF/WAVE', () => {
  const buf = encodeWav24([new Float32Array(10)], 48000);
  assert.equal(buf.byteLength, 74); // 44 + 10 frames x 1 ch x 3 bytes
  const v = new DataView(buf);
  assert.equal(ascii(v, 0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), 66); // 36 + 30 data bytes
  assert.equal(ascii(v, 8, 4), 'WAVE');
  assert.equal(ascii(v, 12, 4), 'fmt ');
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1); // WAVE_FORMAT_PCM
  assert.equal(v.getUint16(22, true), 1); // channels
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint32(28, true), 144000); // byte rate: 48000 x 3
  assert.equal(v.getUint16(32, true), 3); // block align
  assert.equal(v.getUint16(34, true), 24); // bits per sample
  assert.equal(ascii(v, 36, 4), 'data');
  assert.equal(v.getUint32(40, true), 30);
});

test('a stereo file declares two channels and interleaves them', () => {
  const left = Float32Array.from([1, 0]);
  const right = Float32Array.from([0, -1]);
  const buf = encodeWav24([left, right], 44100);
  const v = new DataView(buf);
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint16(32, true), 6);
  assert.equal(buf.byteLength, 44 + 2 * 2 * 3);
  assert.equal(readPcm24(v, 44), PCM24_MAX); // frame 0, left
  assert.equal(readPcm24(v, 47), 0); // frame 0, right
  assert.equal(readPcm24(v, 50), 0); // frame 1, left
  assert.equal(readPcm24(v, 53), PCM24_MIN); // frame 1, right
});

test('samples survive the round trip, and over-unity CLAMPS rather than wraps', () => {
  // A wrap would turn +1.5 into a large NEGATIVE value — an audible click, and
  // exactly the failure a modulo-based writer produces.
  const buf = encodeWav24([Float32Array.from([1, -1, 0, 0.5, 1.5, -1.5, NaN])], 48000);
  const v = new DataView(buf);
  assert.equal(readPcm24(v, 44), PCM24_MAX);
  assert.equal(readPcm24(v, 47), PCM24_MIN);
  assert.equal(readPcm24(v, 50), 0);
  assert.equal(readPcm24(v, 53), 4194304); // round(0.5 x 8388607)
  assert.equal(readPcm24(v, 56), PCM24_MAX);
  assert.equal(readPcm24(v, 59), PCM24_MIN);
  assert.equal(readPcm24(v, 62), 0); // NaN is silence, not garbage
  assert.equal(floatToPcm24(2), PCM24_MAX);
  assert.equal(floatToPcm24(-2), PCM24_MIN);
});

test('a malformed call is refused rather than writing a broken file', () => {
  assert.throws(() => encodeWav24([], 48000), RangeError);
  assert.throws(() => encodeWav24([new Float32Array(4), new Float32Array(5)], 48000), RangeError);
  assert.throws(() => encodeWav24([new Float32Array(4)], 0), RangeError);
  assert.throws(() => encodeWav24([new Float32Array(4)], NaN), RangeError);
});

// ═════════════════════════════════════════════════════════════════════════
// 7. The cut.
// ═════════════════════════════════════════════════════════════════════════

const { sliceFrames, declick, cutLoop, cutPlan, peakEnvelope, downmixToMono, DECLICK_SEC } = cut;

test('a decoded stem is summed to ONE channel, scaled so it cannot clip', () => {
  // Not cosmetic. A cut holds every stem decoded at once, and lib/play/types.ts
  // records 6 x 300 s x 48 kHz x 4 B x 2 channels = 691 MB as MEASURED FAILING.
  // It is also what makes the size on each idle card true: planLoops is called
  // with channels: 1, so a stereo cut would be twice the promised file.
  const out = downmixToMono([Float32Array.from([1, 0, -1]), Float32Array.from([0, 1, -1])]);
  assert.equal(out.length, 1, 'the downmix left more than one channel');
  assert.deepEqual([...out[0]], [0.5, 0.5, -1]);
  // Correlated full-scale on both sides stays inside full scale.
  assert.deepEqual([...downmixToMono([Float32Array.from([1]), Float32Array.from([1])])[0]], [1]);
  // Already mono: one channel in, one channel out, values untouched.
  assert.deepEqual([...downmixToMono([Float32Array.from([0.25, -0.25])])[0]], [0.25, -0.25]);
  assert.deepEqual(downmixToMono([]), []);
  // Six channels, the worst case the stems could present.
  const six = Array.from({ length: 6 }, () => Float32Array.from([1]));
  assert.deepEqual([...downmixToMono(six)[0]], [1]);
});

test('a planned size is the size the cut file actually has', () => {
  // The two halves of the promise, checked against each other: planLoops says
  // 1,152,044 bytes for a 4-bar loop at 120 BPM / 48 kHz / 1 channel, and the
  // encoder is handed a downmixed stem. Both figures are also asserted
  // separately against hand arithmetic above, so this is not circular.
  const stereo = [new Float32Array(48000 * 20).fill(0.5), new Float32Array(48000 * 20).fill(-0.5)];
  const source = { name: 'drums', channels: downmixToMono(stereo), sampleRate: 48000 };
  const spec = planLoops(BASE).find((s) => s.stem === 'drums' && s.bars === 4);
  assert.equal(cutLoop(source, spec).bytes.byteLength, spec.byteLength);
  assert.equal(spec.byteLength, 1152044);
});

test('a slice that runs past the end is padded with silence, not shortened', () => {
  const src = [Float32Array.from([1, 1, 1, 1])];
  const out = sliceFrames(src, 2, 6);
  assert.equal(out[0].length, 6);
  assert.deepEqual([...out[0]], [1, 1, 0, 0, 0, 0]);
  // Entirely past the end: six frames of silence, still the right length.
  assert.deepEqual([...sliceFrames(src, 99, 3)[0]], [0, 0, 0]);
});

test('the declick ramps both ends and leaves the middle untouched', () => {
  const sampleRate = 1000; // 1 ms = 1 frame, so the ramp is exactly 1 frame
  const c = [new Float32Array(10).fill(1)];
  declick(c, sampleRate);
  assert.equal(DECLICK_SEC, 0.001);
  assert.equal(c[0][0], 0, 'the first frame must start from silence');
  assert.equal(c[0][9], 0, 'the last frame must end at silence');
  assert.deepEqual([...c[0].slice(1, 9)], [1, 1, 1, 1, 1, 1, 1, 1]);
});

test('cutLoop produces a file of exactly the planned length', () => {
  const frames = 48000 * 20;
  const source = {
    name: 'drums',
    channels: [new Float32Array(frames).fill(0.5)],
    sampleRate: 48000,
  };
  const specs = planLoops(BASE);
  const four = specs.find((s) => s.stem === 'drums' && s.bars === 4);
  const made = cutLoop(source, four);
  assert.equal(made.bytes.byteLength, 1152044); // the planned size, measured
  assert.equal(made.sampleRate, 48000);
  assert.equal(made.channels, 1);
  assert.equal(new DataView(made.bytes).getUint32(40, true), 1152000);
  // A mid-loop sample is the signal, so the slice read real audio and not zeros.
  assert.equal(readPcm24(new DataView(made.bytes), 44 + 3 * 1000), 4194304);
  assert.ok(made.peaks.length > 0 && made.peaks.every((p) => p >= 0 && p <= 1));
});

test('cutPlan skips a stem that never decoded instead of failing the lot', () => {
  const frames = 48000 * 20;
  const mk = (name) => ({ name, channels: [new Float32Array(frames)], sampleRate: 48000 });
  const sources = [mk('drums'), mk('bass')];
  const made = cutPlan(sources, planLoops(BASE));
  assert.equal(made.length, 8); // 2 stems x 4 banks
  assert.deepEqual([...new Set(made.map((m) => m.spec.stem))], ['drums', 'bass']);
  assert.equal(cutPlan([], planLoops(BASE)).length, 0);
});

test('peakEnvelope reports the loudest sample in each bucket', () => {
  const c = [Float32Array.from([0, 0, 0.5, 0, 1, 0, 0.25, 0])];
  assert.deepEqual(peakEnvelope(c, 4), [0, 0.5, 1, 0.25]);
  assert.deepEqual(peakEnvelope([new Float32Array(0)], 4), []);
});
