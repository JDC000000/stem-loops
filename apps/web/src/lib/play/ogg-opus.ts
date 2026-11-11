// Ogg/Opus demuxer — V3-J2a (TSD §12.2a).
//
// ⚠️ STATUS 2026-11-11, recorded by the seam PR: THIS MODULE HAS NO PRODUCTION
// IMPORTER. Its only importer is its own test. The seam that made the player
// reachable audited every file in `lib/play/` and wired engine, loader,
// sections, mixer, transport, section-loop and chord playhead; this one was
// deliberately left out, and that is a decision rather than an oversight.
//
// The reason is in the next paragraph: this demuxer exists to feed a WebCodecs
// `AudioDecoder`, which is TSD §3 Variant D. The shipped engine (engine.ts) is
// NOT Variant D — the spike chose plain `decodeAudioData` plus a mono downmix,
// measured at 329 MB against the ~600 MB bar Jon set on 2026-11-10, and Chrome
// demuxes Ogg/Opus natively on that path. So the bridge this module was written
// to build has no remaining gap to span.
//
// It is kept, not deleted, for two reasons: the 24 kHz fallback and any future
// move back to WebCodecs would both need it, and it is 629 lines of bounded,
// hostile-input-hardened parsing that is expensive to rewrite and cheap to
// keep. It is Jon's call whether that is worth ~20% of the original
// "3,193 lines, zero importers" problem staying open; flagged in PR #197 as
// named residue so the decision is made rather than defaulted into.
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
// THIS PARSES UNTRUSTED BYTES. Every input is hostile until bounded: the bytes come
// from object storage, but nothing in the pipeline re-validates them, and a stem is
// user-supplied audio two hops upstream. The caps below are therefore load-bearing,
// not defensive decoration, and each one states the number it is derived from.
//
// References: RFC 3533 (Ogg), RFC 7845 (Opus-in-Ogg), RFC 6716 §3.1 (TOC byte).

export const OGG_CAPTURE = 0x5367674f; // "OggS" little-endian
const HEADER_TYPE_CONTINUED = 0x01;
const HEADER_TYPE_BOS = 0x02;
const HEADER_TYPE_EOS = 0x04;

/** Opus is always timed at 48 kHz in Ogg, whatever the original sample rate. */
export const OPUS_TIMEBASE_HZ = 48000;

// ---------------------------------------------------------------------------
// RESOURCE BOUNDS
//
// The attack this answers: one `OpusPacket` object plus one `Uint8Array` view is
// allocated per LACING VALUE, and a page may carry 255 lacing values in 255 bytes.
// A 2.15 MB file of 255 one-byte packets per page measured 1,020,000 packets and
// 184 MB of heap in 313 ms — 85x amplification. The amplification is per-lacing-
// value, so MAX_PACKETS is what actually bounds the heap; a byte cap alone
// does not, which is why both exist and both are tested separately.
// ---------------------------------------------------------------------------

/**
 * Largest input we will look at, in bytes.
 *
 * WHY 32 MiB: the worst legitimate case is one 300 s stem (the product ceiling,
 * below) at the highest bitrate libopus emits for mono, 256 kbps => ~9.6 MB. 32 MiB
 * is >3x that, so no real stem is refused, while the page-scan loop stays bounded
 * even in the resync path that advances one byte at a time.
 */
export const MAX_INPUT_BYTES = 32 * 1024 * 1024;

/**
 * Ceiling on accumulated decoded duration, in microseconds.
 *
 * WHY 400 s AND NOT THE GENERIC 1 HOUR: the consumer is a playback engine that
 * decodes six stems at 48 kHz mono against a hard 300 s track ceiling and a ~600 MB
 * memory bar. The generic safety ceiling for an Ogg demuxer would be ~1 hour, but
 * at 1 hour the derived packet cap (below) lands at 1,440,000 — MORE than the
 * 1,020,000-packet proof above, so a 1-hour ceiling would not bound the heap at all.
 * The product constraint is the one that bites, so the product constraint is what
 * this uses: 300 s plus ~33% headroom, so that a track marginally over the product
 * limit is refused by the ingest layer with a message about track length, not by
 * the demuxer with a message about Ogg pages.
 */
export const MAX_DURATION_US = 400_000_000;

/**
 * RFC 6716 §3.1: the shortest Opus frame is 2.5 ms (CELT-only configs 16/20/24/28),
 * so 2.5 ms is also the shortest possible PACKET.
 */
export const MIN_FRAME_DURATION_US = 2500;

/**
 * Hard cap on emitted packets — DERIVED, not a round number: a stream cannot hold
 * more packets than (duration ceiling / shortest possible packet). 400 s / 2.5 ms
 * = 160,000. At ~170 bytes per packet object + view that bounds the demuxer's own
 * heap at ~27 MB per stem, ~165 MB across six — inside the 600 MB bar, against
 * 184 MB for a single 2.15 MB attack file before this cap existed.
 */
export const MAX_PACKETS = MAX_DURATION_US / MIN_FRAME_DURATION_US;

/**
 * RFC 6716 §3.1: a single Opus packet may not represent more than 120 ms of audio.
 * The limit is on frames x frame duration, NOT on frame duration — 60 ms is a legal
 * frame, so a code-3 packet declaring 48 frames of 60 ms claims 2.88 s and must be
 * refused even though every field in it is individually in range.
 */
export const MAX_PACKET_DURATION_US = 120_000;

/**
 * RFC 6716 §3.2.5: a frame is at most 1275 bytes and a packet at most 48 frames,
 * i.e. 61,200 bytes of frame data. 61,440 (60 KiB) is the conventional ceiling and
 * leaves room for the TOC byte and the frame-length bytes.
 */
export const MAX_PACKET_BYTES = 61_440;

/**
 * Separate, larger cap for the two HEADER packets (OpusHead, OpusTags).
 *
 * WHY THIS IS NOT MAX_PACKET_BYTES: 61,440 is an RFC 6716 limit on an AUDIO packet
 * — frames x 1275 bytes. OpusTags is not an Opus packet at all (RFC 7845 §5.2); it
 * is a Vorbis-comment block, and the single most common comment in the wild is
 * METADATA_BLOCK_PICTURE, a base64 cover image. Applying the audio cap to it
 * rejected a perfectly valid file with embedded cover art as an attack: a 100 KB
 * OpusTags threw PACKET_TOO_LARGE before any audio was parsed.
 *
 * WHY 1 MiB: large enough for a base64 cover image (a 700 KB JPEG encodes to
 * ~950 KB), small enough that the heap stays bounded — there are at most TWO header
 * packets per stream, so this allows 2 MiB per stem, 12 MiB across six, against the
 * ~600 MB bar. The audio cap is what bounds the heap, and audio keeps 61,440.
 */
export const MAX_HEADER_PACKET_BYTES = 1024 * 1024;

/**
 * Hard cap on segment-table entries scanned across the whole file.
 *
 * The attack this answers: a lacing value of 0 costs an attacker ONE byte and was
 * never counted against MAX_PACKETS, because an empty segment completes an empty
 * packet which is discarded. A 32 MiB file of pages carrying 255 zero-lacing values
 * each measured 30,341,685 segments scanned in 1,162 ms on a single synchronous
 * call, returning 0 packets — and the player demuxes SIX stems on the main thread.
 * MAX_PACKETS could not catch it: no packet was ever emitted.
 *
 * DERIVED, not a round number. Every segment in a well-formed stream is either the
 * terminator of a packet or a 255-byte continuation of one:
 *   - terminators are bounded by MAX_PACKETS (160,000);
 *   - continuations each cost 255 bytes of input, so they are bounded by
 *     MAX_INPUT_BYTES / 255 (131,587).
 * The sum, 291,587, is therefore an upper bound on the segments any legitimate
 * input can pay for, while the attack above is refused after ~1,144 pages.
 */
export const MAX_SEGMENTS = MAX_PACKETS + Math.ceil(MAX_INPUT_BYTES / 255);

/**
 * Largest granule position we will believe. Above 2**53 a JS number can no longer
 * represent consecutive integers, so `granule - preSkip` silently stops being exact
 * — that is the real defect, and it is distinct from the sign-bit proof
 * (0x8000000000000000, which is NOT the all-ones end-of-stream sentinel and so
 * passed the old sentinel check and yielded durationSec = 1.92e14, finite).
 */
export const MAX_GRANULE = 2 ** 53;

/**
 * Slack allowed when checking the granule against the summed packet durations, in
 * samples. A well-formed stream's final granule is <= the packet sum (end-trimming
 * only ever removes audio), so any excess is encoder rounding; one maximum-length
 * packet (120 ms = 5,760 samples) is a generous allowance.
 *
 * Used in BOTH directions — see MIN_GRANULE_COVERAGE for why the under-claim side
 * needs a second, proportional term as well.
 */
export const GRANULE_SLACK_SAMPLES = (MAX_PACKET_DURATION_US / 1e6) * OPUS_TIMEBASE_HZ;

/**
 * Smallest fraction of the parsed audio the final granule may account for.
 *
 * The cross-check used to be ONE-SIDED: it rejected a granule that over-claimed but
 * believed any granule that under-claimed. A granule of preSkip+1 declared over
 * three 20 ms packets was reported as granuleTrusted with durationSec 0.000021 for
 * 0.06 s of real audio — a consumer clamps its whole timeline to that.
 *
 * WHY AN ABSOLUTE SLACK IS NOT ENOUGH: that attack's shortfall is 2,879 samples,
 * which is INSIDE the 5,760-sample absolute allowance. On a short stream the
 * absolute slack can exceed the whole stream, so it stops bounding anything.
 *
 * WHY NOT A TIGHTER ABSOLUTE RULE INSTEAD: end-trimming legitimately removes more
 * than one packet. The real fixture (mono.opus, generated as exactly 1.234 s) has
 * 63 packets summing to 1.26 s and a final granule 1,248 samples (26 ms) below the
 * sum — more than its 20 ms last packet. So "at most one packet of trim" would
 * refuse a real libopus file.
 *
 * The allowance is therefore min(absolute, proportional): 120 ms of trim on a long
 * stream, never more than half the audio on a short one. mono.opus trims 2.1% and
 * is trusted; the preSkip+1 attack claims 0.03% and is not.
 */
export const MIN_GRANULE_COVERAGE = 0.5;

/**
 * Output gain is an int16 in 1/256 dB, so the field spans +-128 dB — a 2.5-million-
 * fold amplitude multiplier, i.e. a real clipping and listener-safety hazard rather
 * than a cosmetic one. Real-world values are ReplayGain-scale; +-20 dB is already
 * a 10x amplitude swing, so anything beyond is clamped rather than applied.
 */
export const MAX_OUTPUT_GAIN_DB = 20;

/** All bits set: "no packet completes on this page" (RFC 3533 §4). */
const GRANULE_NONE = 0xffffffff * 0x100000000 + 0xffffffff;

/** "OpusHead" (RFC 7845 §4.1) as bytes, so no string allocation is needed. */
const OPUS_HEAD_MAGIC = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64] as const;

/**
 * Why a code and not just a message: a test that asserts only "it throws" passes
 * against a mutant that keeps the OLD error, and this module has exactly that
 * failure mode — a foreign non-BOS page used to surface as "OpusHead too short",
 * so both the old and the new behaviour throw. The code is the identity.
 */
export type OggOpusErrorCode =
  | 'INPUT_TOO_LARGE'
  | 'TOO_MANY_PACKETS'
  | 'TOO_MANY_SEGMENTS'
  | 'DURATION_EXCEEDED'
  | 'PACKET_TOO_LARGE'
  | 'HEADER_PACKET_TOO_LARGE'
  | 'PACKET_DURATION_ILLEGAL'
  | 'FIRST_PAGE_NOT_BOS'
  | 'BAD_CHANNEL_COUNT'
  | 'BAD_MAPPING_FAMILY'
  | 'BAD_OPUS_HEAD'
  | 'NO_OPUS_HEAD';

export class OggOpusError extends Error {
  readonly code: OggOpusErrorCode;
  constructor(code: OggOpusErrorCode, message: string) {
    super(message);
    this.name = 'OggOpusError';
    this.code = code;
  }
}

export type OpusHead = {
  channels: number;
  /** Samples to discard from the start of the decoded stream (RFC 7845 §4.1). */
  preSkip: number;
  inputSampleRate: number;
  /** Clamped to +-MAX_OUTPUT_GAIN_DB. `outputGainClamped` says whether it was. */
  outputGainDb: number;
  /** True when the file declared a gain outside the safe range and we clamped it. */
  outputGainClamped: boolean;
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
  /**
   * Final granule position — total samples at 48 kHz, pre-skip included.
   *
   * ZERO when `granuleTrusted` is false. A caller that reads this field directly
   * must not be handed a number we have already decided is a lie: the previous
   * version returned the attacker's value raw next to `granuleTrusted: false`,
   * which only helps a consumer that remembers to check the second field.
   */
  finalGranule: number;
  /** False when the granule was not believable and the packet sum was used. */
  granuleTrusted: boolean;
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
  const durationUs = frameUs * frames;
  // RFC 6716 §3.1: enforced on the PRODUCT. Checking frameUs alone would pass a
  // code-3 packet of 48 x 60 ms, because 60 ms is itself a legal frame duration.
  if (durationUs > MAX_PACKET_DURATION_US) return 0;
  return durationUs;
}

function parseOpusHead(bytes: Uint8Array): OpusHead {
  // "OpusHead" + version(1) + channels(1) + preSkip(2 LE) + rate(4 LE) + gain(2 LE) + family(1)
  if (bytes.length < 19) throw new OggOpusError('BAD_OPUS_HEAD', 'OpusHead too short');
  // Byte-compare rather than String.fromCharCode(...bytes): spreading a Uint8Array
  // needs downlevelIteration under this tsconfig, and comparing bytes allocates
  // nothing on a path the engine runs once per stem.
  for (let i = 0; i < OPUS_HEAD_MAGIC.length; i++) {
    if (bytes[i] !== OPUS_HEAD_MAGIC[i]) {
      throw new OggOpusError(
        'BAD_OPUS_HEAD',
        `expected OpusHead magic at offset 0, got byte ${bytes[i]} at ${i}`,
      );
    }
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[8];
  // RFC 7845: a decoder must accept any version whose upper nibble is 0.
  if ((version & 0xf0) !== 0) {
    throw new OggOpusError('BAD_OPUS_HEAD', `unsupported OpusHead version ${version}`);
  }

  // channels is a free byte, 0-255. 0 is undecodable; >2 needs a channel mapping
  // table this module does not parse, and the engine is 48 kHz mono/stereo anyway.
  const channels = bytes[9];
  if (channels < 1 || channels > 2) {
    throw new OggOpusError('BAD_CHANNEL_COUNT', `unsupported channel count ${channels}, expected 1 or 2`);
  }

  // RFC 7845 §5.1.1: family 0 is mono/stereo with no mapping table. Families 1, 2
  // and 255 carry a stream count, a coupled count and a per-channel mapping array
  // after this field; accepting one without reading that table would silently
  // mis-route channels.
  const mappingFamily = bytes[18];
  if (mappingFamily !== 0) {
    throw new OggOpusError(
      'BAD_MAPPING_FAMILY',
      `unsupported channel mapping family ${mappingFamily}, expected 0`,
    );
  }

  const rawGainDb = dv.getInt16(16, true) / 256;
  const outputGainDb = Math.min(MAX_OUTPUT_GAIN_DB, Math.max(-MAX_OUTPUT_GAIN_DB, rawGainDb));

  return {
    channels,
    preSkip: dv.getUint16(10, true),
    inputSampleRate: dv.getUint32(12, true),
    outputGainDb,
    outputGainClamped: outputGainDb !== rawGainDb,
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
 *
 * Throws `OggOpusError` with a `code` for anything out of bounds. Truncation is NOT
 * an error: a short or padded file yields the packets it does contain.
 */
export function demuxOggOpus(input: Uint8Array): DemuxResult {
  if (input.length > MAX_INPUT_BYTES) {
    throw new OggOpusError(
      'INPUT_TOO_LARGE',
      `input is ${input.length} bytes, limit is ${MAX_INPUT_BYTES}`,
    );
  }

  let head: OpusHead | null = null;
  let serial: number | null = null;
  const packets: OpusPacket[] = [];

  // Packet being assembled across segments/pages.
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let headerPacketsSeen = 0;
  let timestampUs = 0;
  let finalGranule = 0;
  let sawPage = false;
  let segmentsScanned = 0;

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

    // Counted HERE — before the payload-length sum below, which is itself one pass
    // over the segment table and so is part of the work an attacker buys with
    // zero-lacing values. Counted per page rather than per emitted packet because
    // an empty segment emits nothing: MAX_PACKETS cannot see it at all.
    segmentsScanned += segCount;
    if (segmentsScanned > MAX_SEGMENTS) {
      throw new OggOpusError(
        'TOO_MANY_SEGMENTS',
        `more than ${MAX_SEGMENTS} segment-table entries: a lacing value costs one byte and an empty one emits no packet, so this is the scan bound`,
      );
    }

    let payloadLen = 0;
    for (let i = 0; i < segCount; i++) payloadLen += input[segTableOff + i];
    const payloadOff = segTableOff + segCount;
    if (payloadOff + payloadLen > input.length) break;

    // The FIRST page must be the beginning of a logical stream. Without this,
    // `serial` stayed null for a foreign non-BOS page, that page was parsed as our
    // stream, and the caller got "OpusHead too short" — an error about the wrong
    // page entirely. Checked here, after the bounds checks, so a false "OggS" in
    // trailing garbage still breaks out rather than throwing.
    if (!sawPage) {
      sawPage = true;
      if (!(headerType & HEADER_TYPE_BOS)) {
        throw new OggOpusError(
          'FIRST_PAGE_NOT_BOS',
          'first Ogg page is not a beginning-of-stream page: a foreign or chained page precedes the stream',
        );
      }
    }

    // One logical stream only — the first BOS page wins. A chained or multiplexed
    // file would otherwise interleave another stream's packets into ours.
    if (serial === null && headerType & HEADER_TYPE_BOS) serial = pageSerial;
    if (serial !== null && pageSerial !== serial) {
      off = payloadOff + payloadLen;
      continue;
    }

    // CONTINUED with nothing pending is an orphaned fragment — the page it
    // continues is missing (truncated upload, spliced file, hostile input). Its
    // bytes are the MIDDLE of a packet, so byte 0 is not a TOC: starting a packet
    // from them hands the decoder garbage that may still have a plausible TOC.
    // Discard through the segment that terminates the orphan, then parse normally.
    let dropOrphan = (headerType & HEADER_TYPE_CONTINUED) !== 0 && pending.length === 0;

    // A page whose first segment continues a packet must not start a new one.
    if (!(headerType & HEADER_TYPE_CONTINUED) && pending.length > 0) {
      pending = [];
      pendingBytes = 0;
    }

    let segOff = payloadOff;
    for (let i = 0; i < segCount; i++) {
      const len = input[segTableOff + i];
      const segStart = segOff;
      segOff += len;

      if (dropOrphan) {
        if (len !== 255) dropOrphan = false; // this segment ended the orphan
        continue;
      }

      // A zero lacing value with nothing pending completes an EMPTY packet, which
      // is discarded below. Skipping it here rather than there is not a tidy-up: it
      // is the difference between allocating a Uint8Array view per attacker byte
      // and allocating none. Kept narrow — `pending.length === 0` matters, because a
      // zero segment WITH bytes pending is the terminator of a packet whose length
      // is an exact multiple of 255, and dropping that would lose real audio.
      if (len === 0 && pending.length === 0) continue;

      // Checked as `pending` GROWS, not after concatenating: an unbounded chain of
      // 255-byte continuation segments must not be assembled before it is refused.
      //
      // Headers get their own, larger cap. 61,440 is the RFC 6716 ceiling on an
      // AUDIO packet; OpusTags is a Vorbis-comment block that legitimately carries
      // a base64 cover image, and applying the audio cap to it refused valid files.
      // Audio keeps 61,440 — that is the cap that bounds the heap.
      const isHeaderPacket = headerPacketsSeen < 2;
      const byteCap = isHeaderPacket ? MAX_HEADER_PACKET_BYTES : MAX_PACKET_BYTES;
      if (pendingBytes + len > byteCap) {
        throw new OggOpusError(
          isHeaderPacket ? 'HEADER_PACKET_TOO_LARGE' : 'PACKET_TOO_LARGE',
          isHeaderPacket
            ? `header packet exceeds ${byteCap} bytes`
            : `packet exceeds ${byteCap} bytes (RFC 6716 maximum)`,
        );
      }
      pending.push(input.subarray(segStart, segStart + len));
      pendingBytes += len;
      if (len === 255) continue; // packet continues into the next segment

      // Packet complete.
      let packet: Uint8Array;
      if (pending.length === 1) {
        packet = pending[0];
      } else {
        const total = pendingBytes;
        packet = new Uint8Array(total);
        let w = 0;
        for (const p of pending) {
          packet.set(p, w);
          w += p.length;
        }
      }
      pending = [];
      pendingBytes = 0;
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
      // 0 means the TOC is undecodable or claims more than the RFC 120 ms. Such a
      // packet cannot be timed, so emitting it would both skew every later
      // timestamp and hand AudioDecoder a chunk it will reject at playback time,
      // where the error is far from the cause.
      if (durationUs === 0) {
        throw new OggOpusError(
          'PACKET_DURATION_ILLEGAL',
          `packet ${packets.length} has no legal RFC 6716 duration (TOC 0x${packet[0].toString(16)})`,
        );
      }
      if (packets.length >= MAX_PACKETS) {
        throw new OggOpusError(
          'TOO_MANY_PACKETS',
          `more than ${MAX_PACKETS} packets: one packet is allocated per lacing value, so this is the heap bound`,
        );
      }
      packets.push({ data: packet, timestampUs, durationUs });
      timestampUs += durationUs;
      if (timestampUs > MAX_DURATION_US) {
        throw new OggOpusError(
          'DURATION_EXCEEDED',
          `stream exceeds ${MAX_DURATION_US / 1e6} s of audio`,
        );
      }
    }

    // LAST usable granule wins, not the maximum. RFC 7845 §4.4: the final page's
    // granulepos is where the stream ends, so a single page claiming a huge granule
    // must not become the duration of the whole file. Two kinds are not usable:
    // the all-ones sentinel ("no packet completes here"), and anything above 2**53,
    // where granule arithmetic silently loses integer precision.
    if (granule !== GRANULE_NONE && granule <= MAX_GRANULE) {
      finalGranule = granule;
    }

    off = payloadOff + payloadLen;
    if (headerType & HEADER_TYPE_EOS) break;
  }

  if (!head) throw new OggOpusError('NO_OPUS_HEAD', 'no OpusHead found: not an Ogg Opus stream');

  // Duration comes from the FINAL GRANULE POSITION, not the packet sum.
  //
  // Summing packet durations over-reports by up to one packet (20 ms), because the
  // last packet is usually only partly audio: RFC 7845 §4.4 has the final page's
  // granulepos signal where the stream really ends, and a decoder must discard the
  // remainder. Measured on a real 20 s file: the packet sum gives 20.0135 s where
  // ffprobe gives 20.0065 s — a 7 ms over-report. Small, but it is the number the
  // seek bar and the chord-timeline alignment are built on, so it should be exact.
  //
  // But the granule is an attacker-controlled int64, so it is CROSS-CHECKED against
  // the packets actually parsed before it is believed. A well-formed stream's final
  // granule never exceeds the summed packet durations (end-trimming only removes
  // audio), so an excess beyond one maximum packet of slack means the field is
  // lying — e.g. 1e9 samples (5.8 hours) declared over a single 20 ms packet, which
  // is a safe integer and so clears the 2**53 check above.
  //
  // The cross-check is TWO-SIDED. Rejecting only over-claims left the opposite
  // attack wide open: a granule of preSkip+1 across three 20 ms packets was
  // trusted, and reported durationSec 0.000021 for 0.06 s of real audio. An
  // under-claim is not the harmless direction — a consumer clamps its timeline to
  // the duration it is given, so the short answer truncates the whole track.
  //
  // The under-claim allowance is min(absolute, proportional) — see
  // MIN_GRANULE_COVERAGE. 120 ms of end-trim on a long stream, never more than half
  // the audio on a short one, because on a short stream the absolute slack can
  // exceed the entire stream and stops bounding anything.
  //
  // Falls back to the packet sum if no usable granule was seen (a truncated file),
  // if the granule is at or below the pre-skip, or if it fails either side.
  const preSkipUs = Math.round((head.preSkip / OPUS_TIMEBASE_HZ) * 1e6);
  const packetSumSamples = Math.round((timestampUs / 1e6) * OPUS_TIMEBASE_HZ) + head.preSkip;
  const packetAudioSamples = packetSumSamples - head.preSkip;
  const endTrimAllowance = Math.min(
    GRANULE_SLACK_SAMPLES,
    packetAudioSamples * (1 - MIN_GRANULE_COVERAGE),
  );
  const granuleTrusted =
    finalGranule > head.preSkip &&
    finalGranule <= packetSumSamples + GRANULE_SLACK_SAMPLES &&
    finalGranule >= packetSumSamples - endTrimAllowance;
  const granuleUs = granuleTrusted
    ? Math.round(((finalGranule - head.preSkip) / OPUS_TIMEBASE_HZ) * 1e6)
    : null;
  const durationSec = Math.max(0, (granuleUs ?? timestampUs - preSkipUs) / 1e6);
  // An untrusted granule is reported as 0, never raw. `granuleTrusted` alone only
  // protects a consumer that remembers to read it; 0 protects one that does not.
  return {
    head,
    packets,
    durationSec,
    finalGranule: granuleTrusted ? finalGranule : 0,
    granuleTrusted,
  };
}
