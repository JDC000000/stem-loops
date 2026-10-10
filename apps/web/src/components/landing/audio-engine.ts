// One Web Audio engine for the landing's example. Two "owners" share it: the hero lanes
// ('hero') and the before/after compare ('ab'); starting one stops the other. Ported from
// the reviewed prototype (prototype/js/app.js) — the behaviour, not just the look:
//  • stems in a set loop in phase (they share one t0),
//  • loops use the pipeline's sample count, never the mp3 container duration,
//  • a request counter drops stale loads, so quick taps before audio arrives don't race,
//  • a failed fetch names the stem and retry re-requests only what failed.
import { type DemoData, type SetKey, loopLen, stemOf } from './demo-data';

export type Owner = 'hero' | 'ab';

export interface EngineSnapshot {
  owner: Owner | null;
  playing: readonly string[];
  /** hero stems still loading (lanes pulse while their audio arrives) */
  loading: readonly string[];
  /** whole seconds into the current loop, for the hero readout */
  posSec: number;
  heroError: { fails: readonly string[]; partial: boolean } | null;
  abError: boolean;
}

export const IDLE_SNAPSHOT: EngineSnapshot = Object.freeze({
  owner: null,
  playing: [],
  loading: [],
  posSec: 0,
  heroError: null,
  abError: false,
});

interface Voice {
  src: AudioBufferSourceNode;
  g: GainNode;
}

export class DemoAudioEngine {
  private ctx: AudioContext | null = null;
  private bufs = new Map<string, AudioBuffer>();
  private inflight = new Map<string, Promise<void>>();
  private voices = new Map<string, Voice>();
  private t0 = 0;
  private owner: Owner | null = null;
  private setKey: SetKey | null = null;
  private raf = 0;
  private pending: string[] | null = null;
  private loadingNames: string[] = [];
  private req = 0;
  private posSec = 0;
  private heroError: EngineSnapshot['heroError'] = null;
  private abError = false;
  private retryArgs: [Owner, SetKey, string[]] | null = null;
  private data: DemoData | null = null;
  private base = '';
  private listeners = new Set<() => void>();
  private snap: EngineSnapshot = IDLE_SNAPSHOT;

  setData(data: DemoData | null, base: string) {
    this.data = data;
    this.base = base;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;

  private emit() {
    this.snap = {
      owner: this.owner,
      playing: Array.from(this.voices.keys()),
      loading: this.loadingNames,
      posSec: this.posSec,
      heroError: this.heroError,
      abError: this.abError,
    };
    this.listeners.forEach((fn) => fn());
  }

  isOn(owner: Owner) {
    return this.owner === owner && this.voices.size > 0;
  }

  /** what the hero is playing OR still loading (so a second tap merges instead of dropping) */
  heroActive(): string[] {
    if (this.owner !== 'hero') return [];
    return Array.from(new Set(Array.from(this.voices.keys()).concat(this.pending ?? [])));
  }

  playingNames(): string[] {
    return Array.from(this.voices.keys());
  }

  private fileFor(key: SetKey, n: string) {
    if (!this.data) return undefined;
    return n === 'before' ? this.data.loops.sets[key].before.file : stemOf(this.data, key, n)?.file;
  }

  private async ensure(key: SetKey, names: string[]): Promise<string[]> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const ctx = this.ctx;
    const fails: string[] = [];
    await Promise.all(
      names.map(async (n) => {
        const id = `${key}/${n}`;
        const f = this.fileFor(key, n);
        if (!f || this.bufs.has(id)) return;
        if (!this.inflight.has(id)) {
          this.inflight.set(
            id,
            (async () => {
              const r = await fetch(this.base + f);
              if (!r.ok) throw new Error(`${f} ${r.status}`);
              this.bufs.set(id, await ctx.decodeAudioData(await r.arrayBuffer()));
            })(),
          );
        }
        try {
          await this.inflight.get(id);
        } catch (e) {
          this.inflight.delete(id);
          fails.push(n);
          console.warn('[demo audio]', e instanceof Error ? e.message : e);
        }
      }),
    );
    return fails;
  }

  private startVoice(key: SetKey, name: string) {
    const buf = this.bufs.get(`${key}/${name}`);
    if (!buf || !this.ctx || !this.data) return;
    const ctx = this.ctx;
    const L = loopLen(this.data, key);
    const want = Math.round(L * buf.sampleRate);
    if (Math.abs(buf.length - want) > 2)
      console.warn(`[demo audio] decoded ${key}/${name}: ${buf.length} samples, expected ${want} (gapless tag not honoured?)`);
    if (!this.voices.size) this.t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = Math.min(L, buf.duration);
    const g = ctx.createGain();
    src.connect(g).connect(ctx.destination);
    src.start(0, (ctx.currentTime - this.t0) % L);
    this.voices.set(name, { src, g });
  }

  private stopVoice(name: string) {
    const v = this.voices.get(name);
    if (!v || !this.ctx) return;
    try {
      v.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
      v.src.stop(this.ctx.currentTime + 0.05);
    } catch {
      /* already stopped */
    }
    this.voices.delete(name);
  }

  private stopVoices() {
    Array.from(this.voices.keys()).forEach((n) => this.stopVoice(n));
  }

  stop() {
    this.stopVoices();
    this.pending = null;
    this.loadingNames = [];
    this.posSec = 0;
    this.emit();
  }

  async play(owner: Owner, key: SetKey, names: string[]) {
    if (!this.data) return;
    if (this.owner !== owner || this.setKey !== key) {
      this.stopVoices();
      this.owner = owner;
      this.setKey = key;
    }
    this.pending = names;
    const myReq = ++this.req;
    this.loadingNames = owner === 'hero' ? names.filter((n) => !this.bufs.has(`${key}/${n}`)) : [];
    if (owner === 'hero') this.heroError = null;
    else this.abError = false;
    this.emit();
    const fails = await this.ensure(key, names);
    if (this.owner !== owner || this.setKey !== key || myReq !== this.req) return;
    this.pending = null;
    this.loadingNames = [];
    if (fails.length) {
      this.retryArgs = [owner, key, names];
      if (owner === 'hero') this.heroError = { fails, partial: fails.length < names.length };
      else this.abError = true;
    }
    const want = new Set(names.filter((n) => this.bufs.has(`${key}/${n}`)));
    Array.from(this.voices.keys()).forEach((n) => {
      if (!want.has(n)) this.stopVoice(n);
    });
    want.forEach((n) => {
      if (!this.voices.has(n)) this.startVoice(key, n);
    });
    this.emit();
    this.tick();
  }

  retry() {
    if (this.retryArgs) void this.play(...this.retryArgs);
  }

  // Playhead: a CSS variable on <html> updated per frame (no React render per frame); the
  // readout only re-renders when the whole second changes.
  private tick() {
    cancelAnimationFrame(this.raf);
    const root = document.documentElement;
    const step = () => {
      if (!this.voices.size || !this.ctx || !this.data || !this.setKey) {
        root.style.setProperty('--ph', '0');
        return;
      }
      const L = loopLen(this.data, this.setKey);
      const pos = (this.ctx.currentTime - this.t0) % L;
      root.style.setProperty('--ph', String(pos / L));
      const sec = Math.floor(pos);
      if (this.owner === 'hero' && sec !== this.posSec) {
        this.posSec = sec;
        this.emit();
      }
      this.raf = requestAnimationFrame(step);
    };
    step();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.stopVoices();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.listeners.clear();
  }
}
