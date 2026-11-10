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
import {
  demuxOggOpus,
  packetDurationUs,
  OPUS_TIMEBASE_HZ,
  OggOpusError,
  MAX_INPUT_BYTES,
  MAX_PACKETS,
  MAX_DURATION_US,
  MAX_PACKET_BYTES,
  MAX_PACKET_DURATION_US,
  MAX_OUTPUT_GAIN_DB,
  MAX_GRANULE,
} from '../src/lib/play/ogg-opus.ts';

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

/**
 * Return the OggOpusError `fn` threw. Fails the test if it threw nothing, or threw
 * something that is not an OggOpusError. `assert.throws` returns undefined, so it
 * cannot be used to then inspect `err.code` — and the code IS the assertion here.
 */
function caughtOggError(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(
      e instanceof OggOpusError,
      `expected OggOpusError, got ${e && e.name}: ${e && e.message}`,
    );
    return e;
  }
  return assert.fail('expected demuxOggOpus to throw, but it returned normally');
}

// ---------- HARDENING: resource bounds (FINDING 1) ----------
//
// These cases are the adversarial reviewer's proofs, rebuilt programmatically.
// No binary fixtures: a malicious file must be auditable in the diff that adds it.

/** Pages of `count` one-byte packets each — the per-lacing-value amplification. */
function amplificationPages(pageCount, perPage = 255) {
  // Each lacing value of 1 completes a packet, so one page yields `perPage`
  // OpusPacket objects + views from 27 + perPage*2 bytes of input.
  const seg = () => {
    const b = new Uint8Array(1);
    b[0] = (16 << 3) | 0; // config 16 => CELT 2.5 ms, code 0 => one frame
    return b;
  };
  const parts = [];
  for (let p = 0; p < pageCount; p++) {
    parts.push(page({ segments: Array.from({ length: perPage }, seg), seq: 2 + p }));
  }
  return concat(...parts);
}

const headerPages = (opts = {}) =>
  concat(
    page({ segments: [opusHead({ channels: 1, preSkip: 0, ...opts })], bos: true, seq: 0 }),
    page({ segments: [opusTags()], seq: 1 }),
  );

test('input larger than MAX_INPUT_BYTES is refused before parsing', () => {
  const tooBig = new Uint8Array(MAX_INPUT_BYTES + 1);
  const err = caughtOggError(() => demuxOggOpus(tooBig));
  assert.equal(err.code, 'INPUT_TOO_LARGE');
});

test('input exactly at MAX_INPUT_BYTES is NOT refused for its size', () => {
  // The cap must be inclusive — an at-the-limit file fails for having no OpusHead,
  // not for its length. Pins the boundary so the check cannot drift to `>=`.
  const atLimit = new Uint8Array(MAX_INPUT_BYTES);
  const err = caughtOggError(() => demuxOggOpus(atLimit));
  assert.equal(err.code, 'NO_OPUS_HEAD');
});

test('the 255-one-byte-packets-per-page amplification is bounded by MAX_PACKETS', () => {
  // The reviewer's proof: 4000 pages x 255 one-byte packets = 1,020,000 packets
  // and ~172 MB of heap from 2.15 MB of input. MAX_PACKETS must stop it.
  const bytes = concat(headerPages(), amplificationPages(4000));
  assert.ok(bytes.length < 2.2e6, `the attack file is small by design, got ${bytes.length}`);
  const err = caughtOggError(() => demuxOggOpus(bytes));
  assert.equal(err.code, 'TOO_MANY_PACKETS');
  // MAX_PACKETS is derived, not round: 400 s ceiling / 2.5 ms minimum frame.
  assert.equal(MAX_PACKETS, 160000);
});

test('a packet count just under MAX_PACKETS still demuxes', () => {
  // The cap must not fire on a legitimately dense stream. 255 x 100 = 25,500
  // packets of 2.5 ms = 63.75 s — well inside the product's 300 s ceiling.
  const bytes = concat(headerPages(), amplificationPages(100));
  const r = demuxOggOpus(bytes);
  assert.equal(r.packets.length, 25500);
});

test('accumulated duration above MAX_DURATION_US is refused', () => {
  // Independent of the packet cap: 120 ms packets reach the duration ceiling in
  // ~3,334 packets, far below MAX_PACKETS. Both bounds must bite on their own.
  const long = new Uint8Array([(3 << 3) | 1, 0, 0]); // config 3 = 60 ms, code 1 = 2 frames
  assert.equal(packetDurationUs(long), 120000);
  const needed = Math.ceil(MAX_DURATION_US / 120000) + 10;
  const pages = [];
  for (let i = 0; i < Math.ceil(needed / 200); i++) {
    pages.push(page({ segments: Array.from({ length: 200 }, () => long), seq: 2 + i }));
  }
  const bytes = concat(headerPages(), ...pages);
  const err = caughtOggError(() => demuxOggOpus(bytes));
  assert.equal(err.code, 'DURATION_EXCEEDED');
  assert.ok(MAX_PACKETS > needed, 'this case must be reached before the packet cap');
});

test('a single packet above MAX_PACKET_BYTES is refused mid-assembly', () => {
  // 242 continuation segments of 255 bytes = 61,710 > 61,440 (RFC 6716 max).
  // The check must fire while `pending` grows, not after a 61 kB concat.
  const seg = () => new Uint8Array(255);
  const bytes = concat(
    headerPages(),
    page({ segments: Array.from({ length: 242 }, seg), seq: 2 }),
  );
  const err = caughtOggError(() => demuxOggOpus(bytes));
  assert.equal(err.code, 'PACKET_TOO_LARGE');
  assert.equal(MAX_PACKET_BYTES, 61440);
});

// ---------- HARDENING: granule trust (FINDING 2) ----------

test('a granule with the sign bit set is not trusted', () => {
  // 0x8000000000000000 is NOT the -1 sentinel, so the old code accepted it and
  // reported durationSec = 1.92e14 — finite, so no NaN/Infinity guard caught it.
  const bytes = concat(
    headerPages(),
    page({ segments: [audioPacket(20)], granule: 0x8000000000000000, seq: 2, eos: true }),
  );
  const r = demuxOggOpus(bytes);
  assert.equal(r.durationSec, 0.02, 'must fall back to the packet-duration sum');
  assert.ok(r.durationSec < 1e3, `absurd duration leaked: ${r.durationSec}`);
  assert.equal(r.granuleTrusted, false);
  // The REPORTED granule must also never be an imprecise integer — a caller that
  // reads finalGranule directly would otherwise get 9223372036854776000.
  assert.ok(r.finalGranule <= MAX_GRANULE, `unsafe granule reported: ${r.finalGranule}`);
});

test('a granule above 2**53 is not trusted even below the sign bit', () => {
  // The real bug is precision, not the sign bit: above 2**53 granule arithmetic
  // silently loses integers, so (granule - preSkip) stops being exact.
  const bytes = concat(
    headerPages({ preSkip: 312 }),
    page({ segments: [audioPacket(20)], granule: 2 ** 53 + 2048, seq: 2, eos: true }),
  );
  const r = demuxOggOpus(bytes);
  assert.ok(r.durationSec < 1e3, `unsafe granule leaked: ${r.durationSec}`);
  assert.equal(r.granuleTrusted, false);
  assert.ok(r.finalGranule <= MAX_GRANULE, `unsafe granule reported: ${r.finalGranule}`);
});

test('a safe-integer granule far above the packet sum is not trusted', () => {
  // 1e9 samples = 5.8 hours, from one 20 ms packet. Well under 2**53, so only the
  // granule-vs-packet-sum cross-check can reject it.
  const bytes = concat(
    headerPages(),
    page({ segments: [audioPacket(20)], granule: 1e9, seq: 2, eos: true }),
  );
  const r = demuxOggOpus(bytes);
  assert.equal(r.durationSec, 0.02, 'must fall back to the packet-duration sum');
  assert.equal(r.granuleTrusted, false, 'the cross-check, not the 2**53 cap, must catch this');
});

test('a NORMAL multi-page file still takes its duration from the granule', () => {
  // Pins legitimate behaviour across the max-granule -> last-granule change.
  // 3 pages x one 20 ms packet; final granule 2880 samples = 0.06 s at 48 kHz.
  const bytes = concat(
    headerPages(),
    page({ segments: [audioPacket(20)], granule: 960, seq: 2 }),
    page({ segments: [audioPacket(20)], granule: 1920, seq: 3 }),
    page({ segments: [audioPacket(20)], granule: 2880, seq: 4, eos: true }),
  );
  const r = demuxOggOpus(bytes);
  assert.equal(r.packets.length, 3);
  assert.equal(r.finalGranule, 2880);
  assert.equal(r.durationSec, 0.06);
});

test('a mid-stream -1 granule does not clobber the running granule', () => {
  // "No packet completes on this page" must not reset the duration to the packet
  // sum now that the LAST granule wins rather than the maximum.
  const big = new Uint8Array(255);
  big[0] = (19 << 3) | 0;
  const bytes = concat(
    headerPages(),
    page({ segments: [audioPacket(20)], granule: 960, seq: 2 }),
    page({ segments: [big], granule: 0xffffffff * 0x100000000 + 0xffffffff, seq: 3 }),
    page({ segments: [new Uint8Array([7])], granule: 1920, seq: 4, continued: true, eos: true }),
  );
  const r = demuxOggOpus(bytes);
  assert.equal(r.finalGranule, 1920);
  assert.equal(r.durationSec, 0.04);
});

test('the LAST granule wins over an earlier larger one', () => {
  // Makes the max-granule -> last-granule change load-bearing. A hostile middle
  // page declares 1e9 samples (safe integer, so the 2**53 check cannot catch it);
  // the real final page declares 2400 samples, which is BELOW the 2880-sample
  // packet sum because the stream is end-trimmed — exactly as a real file is.
  //
  //   last-granule (correct): finalGranule 2400 -> trusted -> 0.05 s
  //   max-granule  (old)    : finalGranule 1e9  -> cross-check fails -> packet sum 0.06 s
  //
  // Both paths return a sane number, so only asserting the EXACT value separates
  // them. That is why this case exists alongside the malicious ones.
  const bytes = concat(
    headerPages(),
    page({ segments: [audioPacket(20)], granule: 960, seq: 2 }),
    page({ segments: [audioPacket(20)], granule: 1e9, seq: 3 }),
    page({ segments: [audioPacket(20)], granule: 2400, seq: 4, eos: true }),
  );
  const r = demuxOggOpus(bytes);
  assert.equal(r.packets.length, 3);
  assert.equal(r.finalGranule, 2400, 'the LAST granule, not the largest');
  assert.equal(r.granuleTrusted, true);
  assert.equal(r.durationSec, 0.05);
  // The packet sum would have been 0.06 — proving the granule, not the sum, was used.
  assert.equal(r.packets.reduce((n, p) => n + p.durationUs, 0), 60000);
});

// ---------- HARDENING: RFC 6716 limits and header fields (FINDING 3) ----------

test('packetDurationUs refuses a packet claiming more than 120 ms', () => {
  // RFC 6716 §3.1: a packet may not represent more than 120 ms of audio. The old
  // code allowed code 3 up to 48 x 60 ms = 2.88 s.
  const max48 = new Uint8Array([(3 << 3) | 3, 48, 0, 0]); // 48 x 60 ms = 2.88 s
  assert.equal(packetDurationUs(max48), 0);
  const threeFrames = new Uint8Array([(3 << 3) | 3, 3, 0, 0]); // 3 x 60 ms = 180 ms
  assert.equal(packetDurationUs(threeFrames), 0);
});

test('the 120 ms limit is enforced on frames x frameDuration, not frameDuration', () => {
  // 60 ms is a legal FRAME duration, so a check on frameDuration alone would pass
  // all three of these. Only the product may be rejected.
  const twoFrames = new Uint8Array([(3 << 3) | 3, 2, 0, 0]); // 2 x 60 ms = 120 ms exactly
  assert.equal(packetDurationUs(twoFrames), 120000, '120 ms is legal, inclusive');
  assert.equal(packetDurationUs(new Uint8Array([(3 << 3) | 1, 0, 0])), 120000); // code 1
  assert.equal(packetDurationUs(new Uint8Array([(3 << 3) | 3, 48, 0])), 0);
  assert.equal(MAX_PACKET_DURATION_US, 120000);
});

test('an over-long packet is refused by the demuxer, not emitted as audio', () => {
  const bytes = concat(
    headerPages(),
    page({ segments: [new Uint8Array([(3 << 3) | 3, 48, 0, 0])], granule: 960, seq: 2, eos: true }),
  );
  const err = caughtOggError(() => demuxOggOpus(bytes));
  assert.equal(err.code, 'PACKET_DURATION_ILLEGAL');
});

test('a channel count outside 1-2 is refused', () => {
  for (const channels of [0, 3, 8, 255]) {
    const bytes = concat(
      page({ segments: [opusHead({ channels, preSkip: 0 })], bos: true, seq: 0 }),
      page({ segments: [opusTags()], seq: 1 }),
      page({ segments: [audioPacket(20)], granule: 960, seq: 2, eos: true }),
    );
    const err = caughtOggError(() => demuxOggOpus(bytes));
    assert.equal(err.code, 'BAD_CHANNEL_COUNT', `channels=${channels}`);
  }
});

test('a non-zero channel mapping family is refused', () => {
  const head = opusHead({ channels: 2, preSkip: 312 });
  head[18] = 1; // family 1 needs a channel mapping table we do not parse
  const bytes = concat(
    page({ segments: [head], bos: true, seq: 0 }),
    page({ segments: [opusTags()], seq: 1 }),
    page({ segments: [audioPacket(20)], granule: 960, seq: 2, eos: true }),
  );
  const err = caughtOggError(() => demuxOggOpus(bytes));
  assert.equal(err.code, 'BAD_MAPPING_FAMILY');
});

test('an extreme output gain is clamped, a sane one is not', () => {
  const demuxWithGain = (rawGain) => {
    const head = opusHead({ channels: 1, preSkip: 0 });
    new DataView(head.buffer).setInt16(16, rawGain, true);
    return demuxOggOpus(
      concat(
        page({ segments: [head], bos: true, seq: 0 }),
        page({ segments: [opusTags()], seq: 1 }),
        page({ segments: [audioPacket(20)], granule: 960, seq: 2, eos: true }),
      ),
    );
  };
  // int16 / 256 spans +-128 dB: +128 dB is a 2.5-million-fold amplitude multiplier.
  assert.equal(demuxWithGain(32767).head.outputGainDb, MAX_OUTPUT_GAIN_DB);
  assert.equal(demuxWithGain(-32768).head.outputGainDb, -MAX_OUTPUT_GAIN_DB);
  assert.equal(MAX_OUTPUT_GAIN_DB, 20);
  // A real ReplayGain-style value must pass through untouched.
  assert.equal(demuxWithGain(-1536).head.outputGainDb, -6);
  assert.equal(demuxWithGain(0).head.outputGainDb, 0);
});

// ---------- HARDENING: stream selection and continuation (FINDING 4) ----------

test('a foreign non-BOS page ahead of the real head is refused by identity', () => {
  // Before: `serial` stayed null, the foreign page was parsed as our stream, and
  // the caller got "OpusHead too short" — a confusing error about the wrong page.
  const bytes = concat(
    page({ segments: [new Uint8Array([1, 2, 3])], serial: 77, seq: 5 }), // not BOS
    page({ segments: [opusHead({ channels: 1, preSkip: 0 })], bos: true, serial: 1, seq: 0 }),
    page({ segments: [opusTags()], serial: 1, seq: 1 }),
    page({ segments: [audioPacket(20)], granule: 960, serial: 1, seq: 2, eos: true }),
  );
  const err = caughtOggError(() => demuxOggOpus(bytes));
  // Assert the NEW identity, not merely that it throws: a mutant that keeps the
  // old behaviour throws too, with code NO_OPUS_HEAD and /OpusHead too short/.
  assert.equal(err.code, 'FIRST_PAGE_NOT_BOS');
  assert.doesNotMatch(err.message, /OpusHead/);
});

test('a CONTINUED page with no pending packet discards the orphan fragment', () => {
  // Before: the continuation data started a brand-new packet, so a garbage TOC was
  // handed to the decoder as audio.
  const orphan = new Uint8Array(255);
  orphan[0] = (0 << 3) | 0; // a VALID TOC, so the old code emitted it as a packet
  const good = audioPacket(20);
  const bytes = concat(
    headerPages(),
    page({
      segments: [orphan, new Uint8Array([4, 4, 4]), good],
      granule: 960,
      seq: 2,
      continued: true,
      eos: true,
    }),
  );
  const r = demuxOggOpus(bytes);
  assert.equal(r.packets.length, 1, 'the orphaned continuation must not become a packet');
  assert.deepEqual(r.packets[0].data, good);
});
