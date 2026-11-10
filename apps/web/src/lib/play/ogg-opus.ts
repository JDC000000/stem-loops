// Ogg/Opus demuxer — V3-J2a (TSD §12.2a).
//
// WHY THIS EXISTS. TSD §3 Variant D drives "a WebCodecs `AudioDecoder` per stem"
// and holds each stem as "the Opus-encoded bytes". `AudioDecoder` does NOT demux:
// it consumes `EncodedAudioChunk`s, i.e. raw Opus packets. Our playback artifact is
// an Ogg file. Nothing bridged the two, and no TSD section had named the work.
//
// The alternative — `decodeAudioData` — is the path §3 explicitly rejects: it
// materialises the whole song as float32 PCM, measured at 643 MB against a 400 MB
// bar (110 MiB/stem x 6).
//
// Pure module: no `@/` imports, no DOM, no AudioDecoder reference. It turns bytes
// into packets and nothing else, so it is unit-testable under bare `node:test`.
//
// References: RFC 3533 (Ogg), RFC 7845 (Opus-in-Ogg), RFC 6716 §3.1 (TOC byte).

export const OGG_CAPTURE = 0x5367674f; // "OggS" little-endian
const HEADER_TYPE_CONTINUED = 0x01;
const HEADER_TYPE_BOS = 0x02;
const HEADER_TYPE_EOS = 0x04;

/** Opus is always timed at 48 kHz in Ogg, whatever the original sample rate. */
export const OPUS_TIMEBASE_HZ = 48000;

/** "OpusHead" (RFC 7845 §4.1) as bytes, so no string allocation is needed. */
const OPUS_HEAD_MAGIC = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64] as const;

export type OpusHead = {
  channels: number;
  /** Samples to discard from the start of the decoded stream (RFC 7845 §4.1). */
  preSkip: number;
  inputSampleRate: number;
  outputGainDb: number;
  /** The raw OpusHead bytes — pass as `description` to AudioDecoder.configure(). */
  description: Uint8Array;
};

export type OpusPacket = {
  data: Uint8Array;
  /** Microseconds from the start of the stream, pre-skip already removed. */
  timestampUs: number;
  /** Microseconds this packet decodes to. */
  durationUs: number;
};

export type DemuxResult = {
  head: OpusHead;
  packets: OpusPacket[];
  /** Exact decoded duration in seconds: pre-skip AND end-trimming removed. */
  durationSec: number;
  /** Final granule position — total samples at 48 kHz, pre-skip included. */
  finalGranule: number;
};

/** RFC 6716 §3.1 Table 2 — frame duration in microseconds, indexed by TOC config. */
const FRAME_US: readonly number[] = [
  // config 0-11: SILK-only (NB, MB, WB) x 10/20/40/60 ms
  10000, 20000, 40000, 60000,
  10000, 20000, 40000, 60000,
  10000, 20000, 40000, 60000,
  // 12-13 Hybrid SWB, 14-15 Hybrid FB: 10/20 ms
  10000, 20000,
  10000, 20000,
  // 16-31: CELT-only (NB, WB, SWB, FB) x 2.5/5/10/20 ms
  2500, 5000, 10000, 20000,
  2500, 5000, 10000, 20000,
  2500, 5000, 10000, 20000,
  2500, 5000, 10000, 20000,
];

/** Decoded duration of one Opus packet, in microseconds. 0 if undecodable. */
export function packetDurationUs(packet: Uint8Array): number {
  if (packet.length < 1) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  const code = toc & 0x03;
  const frameUs = FRAME_US[config];
  if (frameUs === undefined) return 0;

  let frames: number;
  switch (code) {
    case 0:
      frames = 1;
      break;
    case 1:
    case 2:
      frames = 2;
      break;
    default: {
      // Code 3: a frame-count byte follows the TOC; low 6 bits hold the count.
      if (packet.length < 2) return 0;
      frames = packet[1] & 0x3f;
      if (frames < 1 || frames > 48) return 0;
      break;
    }
  }
  return frameUs * frames;
}

function parseOpusHead(bytes: Uint8Array): OpusHead {
  // "OpusHead" + version(1) + channels(1) + preSkip(2 LE) + rate(4 LE) + gain(2 LE) + family(1)
  if (bytes.length < 19) throw new Error('OpusHead too short');
  // Byte-compare rather than String.fromCharCode(...bytes): spreading a Uint8Array
  // needs downlevelIteration under this tsconfig, and comparing bytes allocates
  // nothing on a path the engine runs once per stem.
  for (let i = 0; i < OPUS_HEAD_MAGIC.length; i++) {
    if (bytes[i] !== OPUS_HEAD_MAGIC[i]) {
      throw new Error(`expected OpusHead magic at offset 0, got byte ${bytes[i]} at ${i}`);
    }
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[8];
  // RFC 7845: a decoder must accept any version whose upper nibble is 0.
  if ((version & 0xf0) !== 0) throw new Error(`unsupported OpusHead version ${version}`);
  return {
    channels: bytes[9],
    preSkip: dv.getUint16(10, true),
    inputSampleRate: dv.getUint32(12, true),
    outputGainDb: dv.getInt16(16, true) / 256,
    description: bytes.slice(),
  };
}

/**
 * Demux an Ogg/Opus file into Opus packets ready for `AudioDecoder.decode()`.
 *
 * Handles the two things a naive reader gets wrong: segment lacing (a 255-byte
 * segment means the packet continues, so packets span segments AND pages), and the
 * two mandatory header packets (OpusHead, OpusTags) which are NOT audio and must
 * not be fed to the decoder.
 */
export function demuxOggOpus(input: Uint8Array): DemuxResult {
  let head: OpusHead | null = null;
  let serial: number | null = null;
  const packets: OpusPacket[] = [];

  // Packet being assembled across segments/pages.
  let pending: Uint8Array[] = [];
  let headerPacketsSeen = 0;
  let timestampUs = 0;
  let finalGranule = 0;

  let off = 0;
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);

  while (off + 27 <= input.length) {
    if (dv.getUint32(off, true) !== OGG_CAPTURE) {
      // Resync rather than throw: a truncated or padded file should yield the
      // packets it does contain, not nothing.
      off += 1;
      continue;
    }
    const headerType = input[off + 5];
    // granule position is int64 LE. Read as two u32s: a 53-bit safe integer covers
    // 48 kHz samples for ~5,700 years, so the low/high split is exact here.
    const granuleLo = dv.getUint32(off + 6, true);
    const granuleHi = dv.getUint32(off + 10, true);
    const granule = granuleHi * 0x100000000 + granuleLo;
    const pageSerial = dv.getUint32(off + 14, true);
    const segCount = input[off + 26];
    const segTableOff = off + 27;
    if (segTableOff + segCount > input.length) break;

    let payloadLen = 0;
    for (let i = 0; i < segCount; i++) payloadLen += input[segTableOff + i];
    const payloadOff = segTableOff + segCount;
    if (payloadOff + payloadLen > input.length) break;

    // One logical stream only — the first BOS page wins. A chained or multiplexed
    // file would otherwise interleave another stream's packets into ours.
    if (serial === null && headerType & HEADER_TYPE_BOS) serial = pageSerial;
    if (serial !== null && pageSerial !== serial) {
      off = payloadOff + payloadLen;
      continue;
    }

    // A page whose first segment continues a packet must not start a new one.
    if (!(headerType & HEADER_TYPE_CONTINUED) && pending.length > 0) pending = [];

    let segOff = payloadOff;
    for (let i = 0; i < segCount; i++) {
      const len = input[segTableOff + i];
      pending.push(input.subarray(segOff, segOff + len));
      segOff += len;
      if (len === 255) continue; // packet continues into the next segment

      // Packet complete.
      let packet: Uint8Array;
      if (pending.length === 1) {
        packet = pending[0];
      } else {
        const total = pending.reduce((n, p) => n + p.length, 0);
        packet = new Uint8Array(total);
        let w = 0;
        for (const p of pending) {
          packet.set(p, w);
          w += p.length;
        }
      }
      pending = [];
      if (packet.length === 0) continue;

      if (headerPacketsSeen === 0) {
        head = parseOpusHead(packet);
        headerPacketsSeen = 1;
        continue;
      }
      if (headerPacketsSeen === 1) {
        headerPacketsSeen = 2; // OpusTags — metadata, never decoded
        continue;
      }

      const durationUs = packetDurationUs(packet);
      packets.push({ data: packet, timestampUs, durationUs });
      timestampUs += durationUs;
    }

    // -1 (all bits set) means "no packet completes on this page"; ignore those.
    if (granule !== 0xffffffff * 0x100000000 + 0xffffffff && granule > finalGranule) {
      finalGranule = granule;
    }

    off = payloadOff + payloadLen;
    if (headerType & HEADER_TYPE_EOS) break;
  }

  if (!head) throw new Error('no OpusHead found: not an Ogg Opus stream');

  // Duration comes from the FINAL GRANULE POSITION, not the packet sum.
  //
  // Summing packet durations over-reports by up to one packet (20 ms), because the
  // last packet is usually only partly audio: RFC 7845 §4.4 has the final page's
  // granulepos signal where the stream really ends, and a decoder must discard the
  // remainder. Measured on a real 20 s file: the packet sum gives 20.0135 s where
  // ffprobe gives 20.0065 s — a 7 ms over-report. Small, but it is the number the
  // seek bar and the chord-timeline alignment are built on, so it should be exact.
  //
  // Falls back to the packet sum if no usable granule was seen (a truncated file).
  const preSkipUs = Math.round((head.preSkip / OPUS_TIMEBASE_HZ) * 1e6);
  const granuleUs =
    finalGranule > head.preSkip
      ? Math.round(((finalGranule - head.preSkip) / OPUS_TIMEBASE_HZ) * 1e6)
      : null;
  const durationSec = Math.max(0, (granuleUs ?? timestampUs - preSkipUs) / 1e6);
  return { head, packets, durationSec, finalGranule };
}
