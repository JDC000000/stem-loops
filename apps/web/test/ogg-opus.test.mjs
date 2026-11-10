// Run: pnpm --filter web test
//
// Ogg/Opus demuxer tests — V3-J2a (TSD §12.2a).
//
// Two kinds of test, deliberately:
//
//  1. SYNTHETIC pages built byte by byte, for the structural rules. Segment lacing
//     and page continuation are where a demuxer is wrong in ways a real file may
//     never exercise — libopus emits small, tidy packets, so a 255-byte segment
//     boundary might not appear in any fixture we happen to commit.
//  2. ONE REAL FILE (fixtures/mono.opus, 1.234 s mono @ 64k) end to end, because
//     synthetic pages only prove the parser agrees with my own idea of the format.
//
// The duration assertions are exact, not approximate. That is the point: summing
// packet durations over-reports by up to one packet, and even `ffprobe -show_entries
// format=duration` over-reports by the pre-skip (it reports granule/48000 without
// subtracting priming). The RFC-correct value is (finalGranule - preSkip) / 48000,
// and on a file generated as exactly 1.234 s that is what this asserts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { demuxOggOpus, packetDurationUs, OPUS_TIMEBASE_HZ } from '../src/lib/play/ogg-opus.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- helpers: build Ogg pages by hand ----------

function opusHead({ channels = 2, preSkip = 312, rate = 48000 } = {}) {
  const b = new Uint8Array(19);
  b.set(new TextEncoder().encode('OpusHead'), 0);
  b[8] = 1;
  b[9] = channels;
  new DataView(b.buffer).setUint16(10, preSkip, true);
  new DataView(b.buffer).setUint32(12, rate, true);
  return b;
}

const opusTags = () => {
  const b = new Uint8Array(16);
  b.set(new TextEncoder().encode('OpusTags'), 0);
  return b;
};

/** One Opus packet whose TOC asks for `frameMs` and a single frame. */
function audioPacket(frameMs = 20, payload = 10) {
  const configByMs = { 2.5: 16, 5: 17, 10: 18, 20: 19 };
  const config = configByMs[frameMs] ?? 19;
  const b = new Uint8Array(1 + payload);
  b[0] = (config << 3) | 0; // code 0 => exactly one frame
  return b;
}

/** Build one Ogg page. `segments` is an array of byte arrays used verbatim as the lacing. */
function page({ segments, granule = 0, serial = 1, seq = 0, bos = false, eos = false, continued = false }) {
  const table = [];
  const datas = [];
  for (const seg of segments) {
    table.push(seg.length);
    datas.push(seg);
  }
  const payload = datas.reduce((n, d) => n + d.length, 0);
  const out = new Uint8Array(27 + table.length + payload);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode('OggS'), 0);
  out[4] = 0;
  out[5] = (continued ? 1 : 0) | (bos ? 2 : 0) | (eos ? 4 : 0);
  dv.setUint32(6, granule >>> 0, true);
  dv.setUint32(10, Math.floor(granule / 0x100000000), true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, seq, true);
  dv.setUint32(22, 0, true); // CRC not validated by the demuxer
  out[26] = table.length;
  for (let i = 0; i < table.length; i++) out[27 + i] = table[i];
  let w = 27 + table.length;
  for (const d of datas) {
    out.set(d, w);
    w += d.length;
  }
  return out;
}

const concat = (...parts) => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let w = 0;
  for (const p of parts) {
    out.set(p, w);
    w += p.length;
  }
  return out;
};

// ---------- packet duration (RFC 6716 §3.1) ----------

test('packetDurationUs reads the TOC frame size', () => {
  assert.equal(packetDurationUs(audioPacket(20)), 20000);
  assert.equal(packetDurationUs(audioPacket(10)), 10000);
  assert.equal(packetDurationUs(audioPacket(2.5)), 2500);
});

test('packetDurationUs handles multi-frame codes', () => {
  const two = new Uint8Array([(19 << 3) | 1, 0, 0]); // code 1 => 2 frames of 20 ms
  assert.equal(packetDurationUs(two), 40000);
  const arb = new Uint8Array([(19 << 3) | 3, 3, 0, 0]); // code 3 => count byte = 3
  assert.equal(packetDurationUs(arb), 60000);
});

test('packetDurationUs refuses garbage rather than guessing', () => {
  assert.equal(packetDurationUs(new Uint8Array(0)), 0);
  assert.equal(packetDurationUs(new Uint8Array([(19 << 3) | 3])), 0); // code 3, no count byte
  assert.equal(packetDurationUs(new Uint8Array([(19 << 3) | 3, 0])), 0); // count 0 is illegal
});

// ---------- header handling ----------

test('OpusHead is parsed and OpusTags is never emitted as audio', () => {
  const a = audioPacket(20);
  const bytes = concat(
    page({ segments: [opusHead({ channels: 1, preSkip: 0 })], bos: true, seq: 0 }),
    page({ segments: [opusTags()], seq: 1 }),
    page({ segments: [a], granule: 960, seq: 2, eos: true }),
  );
  const r = demuxOggOpus(bytes);
  assert.equal(r.head.channels, 1);
  assert.equal(r.head.preSkip, 0);
  // exactly ONE audio packet: the two header packets must not reach the decoder
  assert.equal(r.packets.length, 1);
  assert.deepEqual(r.packets[0].data, a);
});

test('the OpusHead bytes are exposed for AudioDecoder.configure({description})', () => {
  const head = opusHead({ channels: 2, preSkip: 312 });
  const bytes = concat(
    page({ segments: [head], bos: true }),
    page({ segments: [opusTags()], seq: 1 }),
    page({ segments: [audioPacket()], granule: 1272, seq: 2, eos: true }),
  );
  const r = demuxOggOpus(bytes);
  assert.deepEqual(r.head.description, head);
});

test('a stream with no OpusHead throws rather than returning silence', () => {
  // Silence would be indistinguishable from "this job has no chords" — the silent
  // failure mode this whole module is meant to avoid.
  const bytes = page({ segments: [audioPacket()], bos: true, eos: true });
  assert.throws(() => demuxOggOpus(bytes), /OpusHead/);
});

// ---------- segment lacing: the part real fixtures may never exercise ----------

test('a packet spanning two segments is reassembled', () => {
  // A 255-byte segment means "continues"; the next short segment terminates it.
  const big = new Uint8Array(255);
  big[0] = (19 << 3) | 0;
  const tail = new Uint8Array([1, 2, 3]);
  const bytes = concat(
    page({ segments: [opusHead()], bos: true }),
    page({ segments: [opusTags()], seq: 1 }),
    page({ segments: [big, tail], granule: 1272, seq: 2, eos: true }),
  );
  const r = demuxOggOpus(bytes);
  assert.equal(r.packets.length, 1);
  assert.equal(r.packets[0].data.length, 258);
  assert.equal(r.packets[0].data[255], 1, 'tail bytes must follow the 255-byte segment');
});

test('a packet spanning two PAGES is reassembled via the continued flag', () => {
  const big = new Uint8Array(255);
  big[0] = (19 << 3) | 0;
  const tail = new Uint8Array([9, 9]);
  const bytes = concat(
    page({ segments: [opusHead()], bos: true }),
    page({ segments: [opusTags()], seq: 1 }),
    page({ segments: [big], seq: 2 }),                            // no terminator here
    page({ segments: [tail], granule: 1272, seq: 3, continued: true, eos: true }),
  );
  const r = demuxOggOpus(bytes);
  assert.equal(r.packets.length, 1);
  assert.equal(r.packets[0].data.length, 257);
});

test('a dangling partial packet is dropped when the next page is NOT continued', () => {
  const big = new Uint8Array(255);
  big[0] = (19 << 3) | 0;
  const good = audioPacket(20);
  const bytes = concat(
    page({ segments: [opusHead()], bos: true }),
    page({ segments: [opusTags()], seq: 1 }),
    page({ segments: [big], seq: 2 }),                 // starts a packet, never finishes it
    page({ segments: [good], granule: 1272, seq: 3, eos: true }), // fresh page, not continued
  );
  const r = demuxOggOpus(bytes);
  assert.equal(r.packets.length, 1, 'the abandoned fragment must not be concatenated onto the next packet');
  assert.deepEqual(r.packets[0].data, good);
});

// ---------- robustness ----------

test('leading garbage is resynced past rather than fatal', () => {
  const bytes = concat(
    new Uint8Array([0x00, 0x01, 0x4f, 0x67, 0x67]), // includes a partial "Ogg"
    page({ segments: [opusHead()], bos: true }),
    page({ segments: [opusTags()], seq: 1 }),
    page({ segments: [audioPacket()], granule: 1272, seq: 2, eos: true }),
  );
  const r = demuxOggOpus(bytes);
  assert.equal(r.packets.length, 1);
});

test('another logical stream is ignored, not interleaved', () => {
  const bytes = concat(
    page({ segments: [opusHead()], bos: true, serial: 1 }),
    page({ segments: [opusTags()], seq: 1, serial: 1 }),
    page({ segments: [audioPacket()], granule: 1272, seq: 2, serial: 1 }),
    page({ segments: [audioPacket()], granule: 9999, seq: 2, serial: 77 }), // foreign stream
  );
  const r = demuxOggOpus(bytes);
  assert.equal(r.packets.length, 1, 'only the first BOS stream belongs to us');
});

test('timestamps are monotonic and start at zero', () => {
  const bytes = concat(
    page({ segments: [opusHead()], bos: true }),
    page({ segments: [opusTags()], seq: 1 }),
    page({ segments: [audioPacket(20), audioPacket(20), audioPacket(20)], granule: 3192, seq: 2, eos: true }),
  );
  const r = demuxOggOpus(bytes);
  assert.deepEqual(r.packets.map((p) => p.timestampUs), [0, 20000, 40000]);
});

// ---------- the real file ----------

test('a real libopus file demuxes to the EXACT duration', () => {
  // fixtures/mono.opus was generated as exactly 1.234 s:
  //   ffmpeg -f lavfi -i "sine=f=440:d=1.234:r=44100" -ac 1 -c:a libopus -b:a 64k -ar 48000
  const bytes = new Uint8Array(readFileSync(join(HERE, 'fixtures', 'mono.opus')));
  const r = demuxOggOpus(bytes);
  assert.equal(r.head.channels, 1);
  // OpusHead's "input sample rate" is the rate of the audio handed TO the encoder,
  // which is 48000 here because `-ar 48000` resampled the 44.1k source first. It is
  // informational only (RFC 7845 §4.1) — Opus always decodes at 48 kHz regardless,
  // which is why AudioContext is created at 48 kHz per TSD §3.1. I asserted 44100
  // here first, on the assumption it recorded the ORIGINAL rate; the test caught it.
  assert.equal(r.head.inputSampleRate, 48000);
  assert.equal(r.durationSec, 1.234);
  assert.ok(r.packets.length > 50, `expected ~62 packets, got ${r.packets.length}`);
  assert.ok(r.packets.every((p) => p.durationUs > 0), 'every packet must have a known duration');
  // monotonic, no gaps
  for (let i = 1; i < r.packets.length; i++) {
    assert.equal(
      r.packets[i].timestampUs,
      r.packets[i - 1].timestampUs + r.packets[i - 1].durationUs,
      `gap before packet ${i}`,
    );
  }
});

test('granule-based duration beats summing packets, and beats ffprobe', () => {
  const bytes = new Uint8Array(readFileSync(join(HERE, 'fixtures', 'mono.opus')));
  const r = demuxOggOpus(bytes);
  const packetSum = r.packets.reduce((n, p) => n + p.durationUs, 0) / 1e6;
  const ffprobeStyle = r.finalGranule / OPUS_TIMEBASE_HZ; // what ffprobe reports
  assert.equal(r.durationSec, 1.234, 'ours is exact');
  assert.ok(packetSum > r.durationSec, 'the packet sum over-reports (untrimmed tail + pre-skip)');
  assert.ok(ffprobeStyle > r.durationSec, 'ffprobe over-reports by the pre-skip');
  assert.ok(
    Math.abs(ffprobeStyle - r.durationSec - r.head.preSkip / OPUS_TIMEBASE_HZ) < 1e-9,
    'the ffprobe delta IS exactly the pre-skip',
  );
});
