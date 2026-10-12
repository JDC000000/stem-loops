// Waveform colours for canvas renderers (WaveSurfer). A canvas fillStyle cannot resolve CSS
// custom properties: handed 'var(--x, #fff)' it ignores the value and keeps its default, black,
// which is how the results waveforms drew black on #0e0e0e. So the colours are resolved here,
// in the page, to plain rgb() strings, and re-resolved when the tokens can change.

/** Normalise a computed CSS colour to a string a canvas accepts, or null. */
export function toCanvasColor(computed: string | null | undefined): string | null {
  const s = (computed ?? '').trim();
  if (!s || /var\(/i.test(s)) return null;
  if (/^rgba?\(/i.test(s) || /^#[0-9a-f]{3,8}$/i.test(s)) return s;
  // color-mix() and friends compute to color(srgb r g b [/ a]) in Chromium
  const m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i.exec(s);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map((v) => Math.round(Math.min(1, Math.max(0, Number(v))) * 255));
    return m[4] !== undefined ? `rgba(${r}, ${g}, ${b}, ${Number(m[4])})` : `rgb(${r}, ${g}, ${b})`;
  }
  return null;
}

/**
 * Resolve a custom property (e.g. '--wf-idle') to an rgb() string as it applies inside `scope`.
 * Reading the custom property itself returns its raw text ('var(--wf-idle-bass)', 'CanvasText'),
 * so a probe takes it as its `color` and the browser does the resolving. forced-color-adjust
 * keeps the UA from overriding the probe in forced-colours mode (the CSS sets system colours).
 */
export function resolveCssColor(scope: Element, prop: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = `position:absolute;width:0;height:0;overflow:hidden;forced-color-adjust:none;color:var(${prop})`;
  scope.appendChild(probe);
  try {
    return toCanvasColor(getComputedStyle(probe).color) ?? fallback;
  } finally {
    probe.remove();
  }
}

export type WaveColors = { waveColor: string; progressColor: string };

/** The two waveform colours a LoopCard draws with (see loop-card.css). */
export function resolveWaveColors(scope: Element): WaveColors {
  return {
    waveColor: resolveCssColor(scope, '--wf-idle', '#696969'),
    progressColor: resolveCssColor(scope, '--wf-played', '#e0e0e0'),
  };
}

/**
 * Call `cb` whenever the resolved colours could change: forced colours / contrast / scheme
 * toggles, or a class, style or data-theme change on <html> or <body>. Returns the unsubscribe.
 */
export function onWaveTokensChange(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const queries = ['(forced-colors: active)', '(prefers-contrast: more)', '(prefers-color-scheme: dark)'].map((q) =>
    window.matchMedia(q),
  );
  queries.forEach((q) => q.addEventListener('change', cb));
  const mo = new MutationObserver(cb);
  const opts = { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] };
  mo.observe(document.documentElement, opts);
  if (document.body) mo.observe(document.body, opts);
  return () => {
    queries.forEach((q) => q.removeEventListener('change', cb));
    mo.disconnect();
  };
}
