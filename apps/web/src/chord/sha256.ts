// SHA-256 hex digest helper for in-browser + Node 20+ contexts.
//
// Scope: used by chordnet-session.ts to verify the ChordNet ONNX model
// bytes against EXPECTED_MODEL_SHA256. The CQT plan has its own
// sha256Hex() local to cqt-frontend.ts (including a pure-TS fallback for
// no-WebCrypto environments); this module intentionally stays smaller —
// model-verification only runs where WebCrypto is available (every
// browser targeting ES2022 + Node 20+ test runners).
//
// See session-6 security audit v2 finding F2.

export async function sha256Hex(
  buf: ArrayBuffer | Uint8Array,
): Promise<string> {
  // Copy into a fresh Uint8Array so WebCrypto's BufferSource type-check
  // doesn't choke on a Uint8Array<ArrayBufferLike> (which could, in theory,
  // be backed by a SharedArrayBuffer). The copy is a few MB at most.
  const src = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const bytes = new Uint8Array(src.length);
  bytes.set(src);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
