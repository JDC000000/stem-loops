// C1 perf harness: the REAL engine (wt-c1-slowdown) + the REAL SoundTouch provider.
import { WebAudioPlayEngine } from '../../../wt-c1-slowdown/apps/web/src/lib/play/engine.ts';
import { soundTouchStretch } from '../../../wt-c1-slowdown/apps/web/src/lib/play/stretch.ts';
import { SoundTouchNode } from '@soundtouchjs/audio-worklet';

const STEMS = ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other'] as const;
const W = window as any;
W.onsets = [] as number[][];
W.anchors = [] as any[];
W.log = [] as string[];

async function fetchStems() {
  return Promise.all(STEMS.map(async (name) => ({ name, bytes: await (await fetch(`/audio/${name}.ogg`)).arrayBuffer() })));
}

function attachProbe(ctx: BaseAudioContext, taps: AudioNode[]) {
  const merger = ctx.createChannelMerger(6);
  taps.forEach((n, i) => n.connect(merger, 0, i));
  const probe = new AudioWorkletNode(ctx, 'sl-probe', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 6, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
  probe.port.onmessage = (e) => { for (const o of e.data) W.onsets.push([o[0], o[1] / ctx.sampleRate]); };
  merger.connect(probe);
  const sink = (ctx as any).createGain(); sink.gain.value = 0; probe.connect(sink); sink.connect(ctx.destination);
}

W.setupEngine = async (sr: number) => {
  const t0 = performance.now();
  let ctxRef: AudioContext | null = null;
  const created: any[] = [];
  const base = soundTouchStretch('/soundtouch-processor.js');
  const provider = { ...base, create: (c: AudioContext) => { const n = base.create(c); created.push(n); return n; } };
  const engine = new WebAudioPlayEngine({
    decodeSampleRate: sr,
    createAudioContext: (o) => (ctxRef = new AudioContext({ sampleRate: o.sampleRate })),
    stretch: provider,
  });
  (engine as any).ctx = (engine as any).openContext();
  ctxRef = (engine as any).ctx;
  (engine as any).output = ctxRef!.destination;
  await ctxRef!.audioWorklet.addModule('/probe-processor.js');
  await engine.load((await fetchStems()) as any);
  attachProbe(ctxRef!, STEMS.map((n) => (engine as any).gains.get(n)));
  W.engine = engine; W.ctx = ctxRef; W.created = created;
  W.log.push(`engine load ms=${Math.round(performance.now() - t0)}`);
  return engine.getSnapshot().status;
};

W.anchor = (label: string) => {
  const e = W.engine;
  const a = { label, t: W.ctx.currentTime, startCtxTime: e.startCtxTime, startOffset: e.startOffset, rate: e.rate, status: e.status, loop: e.loop ? { ...e.loop } : null, nodes: W.created.length };
  W.anchors.push(a);
  return a;
};

/** Ask for a rate and wait until it plays. Returns call ms and ms until applied. */
W.setRate = async (rate: number) => {
  const e = W.engine;
  const c0 = performance.now();
  e.setPlaybackRate(rate);
  const callMs = performance.now() - c0;
  while (e.getSnapshot().playbackRate !== rate) await new Promise((r) => setTimeout(r, 5));
  const appliedMs = performance.now() - c0;
  W.anchor(`rate ${rate}`);
  return { callMs, appliedMs, T: W.ctx.currentTime };
};
W.act = (what: string, arg?: number) => {
  const e = W.engine;
  if (what === 'seek') e.seek(arg);
  else if (what === 'pause') e.pause();
  else if (what === 'play') e.play();
  else if (what === 'loopOn') { const p = e.getSnapshot().positionSec; e.setLoop({ startSec: Math.floor(p / 5) * 5, endSec: Math.floor(p / 5) * 5 + 12.5 }); }
  else if (what === 'loopOff') e.setLoop(null);
  return W.anchor(what + (arg != null ? ' ' + arg : ''));
};

// ── offline latency: a running node (fed silence for 1 s), then a source ──
function burstBuffer(ctx: BaseAudioContext, sr: number, sec: number, at: number[]) {
  const b = ctx.createBuffer(1, Math.ceil(sec * sr), sr); const d = b.getChannelData(0); const n = Math.round(0.004 * sr);
  for (const a of at) { const s = Math.round(a * sr); for (let i = 0; i < n; i++) d[s + i] = Math.sin(2 * Math.PI * 3000 * i / sr) * 0.5 * (1 - Math.cos(2 * Math.PI * i / n)); }
  return b;
}
W.offlineLatency = async (sr: number, rate: number, feed: boolean) => {
  const len = sr * 6; const T0 = 1.0; const marks = [0.5, 1.0, 1.5, 2.0];
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: len, sampleRate: sr });
  await SoundTouchNode.register(ctx, '/soundtouch-processor.js');
  const merger = ctx.createChannelMerger(2); merger.connect(ctx.destination);
  const st = new SoundTouchNode({ context: ctx, outputChannelCount: 1 }); st.playbackRate.value = rate; st.connect(merger, 0, 1);
  if (feed) { const c = ctx.createConstantSource(); c.offset.value = 0; c.connect(st); c.start(0); }
  const buf = burstBuffer(ctx, sr, 3, marks);
  const a = ctx.createBufferSource(); a.buffer = buf; a.playbackRate.value = rate; a.connect(merger, 0, 0); a.start(T0);
  const b = ctx.createBufferSource(); b.buffer = buf; b.playbackRate.value = rate; b.connect(st); b.start(T0);
  const r = await ctx.startRendering();
  const on = (c: number) => { const x = r.getChannelData(c); const out: number[] = []; let last = -1e9; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.1 && i - last > sr * 0.2) { out.push(i / sr); last = i; } else if (Math.abs(x[i]) > 0.1) last = i; return out; };
  const d = on(0), s = on(1);
  return { sr, rate, feed, direct: d, stretched: s, latencyMs: s.map((t, i) => (d[i] != null ? +((t - d[i]) * 1000).toFixed(2) : null)) };
};
W.heap = () => (performance as any).memory?.usedJSHeapSize ?? null;
