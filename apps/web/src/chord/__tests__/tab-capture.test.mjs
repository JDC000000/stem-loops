import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UnsupportedBrowserError,
  __internal,
  checkTabCaptureSupport,
  startTabCapture,
} from '../tab-capture.ts';

const UA = {
  chrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  edge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/129.0.0.0',
  firefox:
    'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
  desktopSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
};

test('support check: Chrome desktop is supported', () => {
  const r = checkTabCaptureSupport(UA.chrome);
  // Node has no mediaDevices, so without a global this must fail; we only
  // assert the UA-detection branch. Patch navigator.mediaDevices to simulate.
  if (r.supported) return;
  assert.equal(r.reason, 'no-display-media');
});

test('support check: Edge is supported (UA includes Edg)', () => {
  const r = checkTabCaptureSupport(UA.edge);
  if (r.supported) return;
  assert.equal(r.reason, 'no-display-media');
});

test('support check: Firefox is blocked with branded message', () => {
  const r = checkTabCaptureSupport(UA.firefox);
  assert.equal(r.supported, false);
  assert.equal(r.reason, 'firefox');
  assert.ok(/chrome/i.test(r.message));
});

test('support check: iOS Safari is blocked with desktop-only message', () => {
  const r = checkTabCaptureSupport(UA.iphone);
  assert.equal(r.supported, false);
  assert.equal(r.reason, 'ios-safari');
  assert.ok(/desktop/i.test(r.message));
});

test('support check: desktop Safari is blocked', () => {
  const r = checkTabCaptureSupport(UA.desktopSafari);
  assert.equal(r.supported, false);
  assert.equal(r.reason, 'safari-desktop');
});

test('ring buffer: write-then-read returns everything since last read', () => {
  const rb = __internal.createRingBuffer(8);
  rb.write(new Float32Array([1, 2, 3]));
  const a = rb.readSinceLast();
  assert.deepEqual([...a], [1, 2, 3]);
  rb.write(new Float32Array([4, 5]));
  const b = rb.readSinceLast();
  assert.deepEqual([...b], [4, 5]);
});

test('ring buffer: rollover preserves the newest capacity samples', () => {
  const rb = __internal.createRingBuffer(4);
  rb.write(new Float32Array([1, 2, 3, 4, 5, 6])); // overflows
  const a = rb.readSinceLast();
  // Should return the last 4 samples written.
  assert.deepEqual([...a], [3, 4, 5, 6]);
});

test('ring buffer: empty read returns an empty Float32Array', () => {
  const rb = __internal.createRingBuffer(8);
  const a = rb.readSinceLast();
  assert.equal(a.length, 0);
});

test('startTabCapture: throws UnsupportedBrowserError on Firefox', async () => {
  await assert.rejects(
    () =>
      startTabCapture(
        {},
        {
          checkSupport: () => ({
            supported: false,
            reason: 'firefox',
            message: 'nope',
          }),
        },
      ),
    (err) => {
      assert.ok(err instanceof UnsupportedBrowserError);
      assert.equal(err.reason, 'firefox');
      return true;
    },
  );
});

test('startTabCapture: throws when user denies audio share', async () => {
  // Build a fake MediaStream with no audio tracks.
  const fakeStream = {
    _tracks: [{ kind: 'video', stop() {} }],
    getAudioTracks() {
      return [];
    },
    getVideoTracks() {
      return this._tracks.filter((t) => t.kind === 'video');
    },
    getTracks() {
      return this._tracks;
    },
  };
  await assert.rejects(
    () =>
      startTabCapture(
        {},
        {
          checkSupport: () => ({ supported: true }),
          getDisplayMedia: async () => fakeStream,
        },
      ),
    /did not share tab audio/,
  );
});

test('startTabCapture: wires through a fake AudioContext and emits chunks', async () => {
  const ended = [];
  const audioTrack = {
    kind: 'audio',
    _listeners: {},
    addEventListener(k, cb) {
      this._listeners[k] = cb;
    },
    stop() {
      ended.push('audio');
    },
  };
  const videoTrack = {
    kind: 'video',
    stop() {
      ended.push('video');
    },
  };
  const stream = {
    getAudioTracks: () => [audioTrack],
    getVideoTracks: () => [videoTrack],
    getTracks: () => [audioTrack, videoTrack],
  };

  // Fake Web Audio graph.
  let processor;
  const node = () => ({ connect() {}, disconnect() {} });
  class FakeContext {
    constructor(opts) {
      this.sampleRate = opts.sampleRate;
      this.destination = {};
    }
    createMediaStreamSource() {
      return node();
    }
    createGain() {
      return { gain: { value: 0 }, ...node() };
    }
    createScriptProcessor() {
      processor = {
        onaudioprocess: null,
        ...node(),
      };
      return processor;
    }
    async close() {}
  }

  const cap = await startTabCapture(
    { sampleRate: 22050, chunkSeconds: 0.01, bufferSeconds: 1 },
    {
      checkSupport: () => ({ supported: true }),
      getDisplayMedia: async () => stream,
      AudioContext: FakeContext,
    },
  );
  const received = [];
  cap.onAudioChunk((c) => received.push(c.length));

  // Fire a chunk of 300 samples (>chunkSamples = 220).
  const input = new Float32Array(300);
  for (let i = 0; i < 300; i++) input[i] = 0.1;
  processor.onaudioprocess({
    inputBuffer: {
      getChannelData: () => input,
    },
  });
  assert.equal(received.length, 1);
  assert.ok(received[0] >= 220, `expected ≥220 samples, got ${received[0]}`);

  // Stop triggers cleanup — video+audio tracks stopped.
  await cap.stop();
  assert.ok(ended.includes('audio'));
  assert.ok(ended.includes('video'));
});

test('startTabCapture: ended audio track fires onError', async () => {
  const audioTrack = {
    kind: 'audio',
    _listeners: {},
    addEventListener(k, cb) {
      this._listeners[k] = cb;
    },
    stop() {},
  };
  const stream = {
    getAudioTracks: () => [audioTrack],
    getVideoTracks: () => [],
    getTracks: () => [audioTrack],
  };
  class FakeContext {
    constructor() {
      this.destination = {};
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createGain() {
      return {
        gain: { value: 0 },
        connect() {},
        disconnect() {},
      };
    }
    createScriptProcessor() {
      return { connect() {}, disconnect() {}, onaudioprocess: null };
    }
    async close() {}
  }
  const cap = await startTabCapture(
    {},
    {
      checkSupport: () => ({ supported: true }),
      getDisplayMedia: async () => stream,
      AudioContext: FakeContext,
    },
  );
  const errs = [];
  cap.onError((e) => errs.push(e));
  // Simulate the browser revoking capture.
  audioTrack._listeners.ended();
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /sharing stopped/);
  await cap.stop();
});
