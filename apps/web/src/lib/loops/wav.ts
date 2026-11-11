/**
 * 24-bit PCM WAV encoding, in the browser.
 *
 * The worker writes 24-bit WAV (`encoder/wav_encoder.encode_24bit`) because that
 * is what a DAW wants; a loop cut on this side is written the same way so the
 * two artifacts are interchangeable as files. What differs is the SOURCE, and
 * that difference is stated on the page rather than hidden here: these loops are
 * cut from the Opus playback stems, so 24 bits is the container's precision, not
 * the recording's.
 *
 * Pure: takes Float32 channel arrays, returns bytes. No DOM, no AudioContext.
 */
import { WAV_HEADER_BYTES, LOOP_BIT_DEPTH } from './plan';

const BYTES_PER_SAMPLE = LOOP_BIT_DEPTH / 8;

/**
 * Full-scale for signed 24-bit is -8388608..8388607. Float audio is nominally
 * [-1, 1], so +1.0 maps to 8388607 and -1.0 to -8388608, and anything outside
 * is CLAMPED rather than allowed to wrap. A wrap is not a quiet defect: an
 * over-unity sample would come back as full-scale of the opposite sign, which
 * is an audible click in the middle of a loop.
 */
export const PCM24_MAX = 8388607;
export const PCM24_MIN = -8388608;

export function floatToPcm24(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  const scaled = Math.round(sample < 0 ? sample * 8388608 : sample * PCM24_MAX);
  if (scaled > PCM24_MAX) return PCM24_MAX;
  if (scaled < PCM24_MIN) return PCM24_MIN;
  return scaled;
}

/**
 * Interleave `channels` and write a canonical 44-byte RIFF/WAVE header plus
 * 24-bit little-endian PCM.
 *
 * Every channel must be the same length; a mismatch is a caller bug and throws
 * rather than silently truncating one side of a stereo loop.
 */
export function encodeWav24(channels: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  if (channels.length === 0) throw new RangeError('encodeWav24: no channels');
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`encodeWav24: bad sampleRate ${sampleRate}`);
  }
  const frames = channels[0].length;
  for (const c of channels) {
    if (c.length !== frames) throw new RangeError('encodeWav24: channels differ in length');
  }

  const numChannels = channels.length;
  const blockAlign = numChannels * BYTES_PER_SAMPLE;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // everything after this field
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk length
  view.setUint16(20, 1, true); // WAVE_FORMAT_PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, LOOP_BIT_DEPTH, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let f = 0; f < frames; f += 1) {
    for (let c = 0; c < numChannels; c += 1) {
      const v = floatToPcm24(channels[c][f]);
      // Little-endian 24-bit: low byte first. `& 0xff` on a negative value
      // yields the two's-complement byte, which is what the format wants.
      view.setUint8(offset, v & 0xff);
      view.setUint8(offset + 1, (v >> 8) & 0xff);
      view.setUint8(offset + 2, (v >> 16) & 0xff);
      offset += 3;
    }
  }
  return buffer;
}
