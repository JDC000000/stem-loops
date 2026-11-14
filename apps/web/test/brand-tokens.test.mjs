// Brand book v2.2 gate: the one token file, its contrast floors, and the decisions Jon
// accepted (A3-A9) plus the code mismatches fixed with them (M3, M12, M13, M18-M20, M22-M27).
// Each test names the book's row it pins, so a failure says which rule broke.
//
// Static on purpose, like waveform-colors.test.mjs: it reads the stylesheets and sources from
// disk and computes WCAG 2.x ratios on the 8-bit hex values (brand book Appendix C formula).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(WEB, 'src');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const uncomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const TOKENS_REL = 'src/styles/design-tokens.css';
const TOKENS = uncomment(read(TOKENS_REL));
const CSS_FILES = walk(SRC).filter((p) => p.endsWith('.css'));
const CODE_FILES = walk(SRC).filter((p) => /\.(tsx?|css)$/.test(p) && !/\.test\./.test(p));

// first declaration of each custom property in the token file's :root blocks
const hexTokens = Object.fromEntries(
  [...TOKENS.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].reverse().map((m) => [m[1], m[2].toLowerCase()]),
);
const tok = (name) => { const v = hexTokens[name]; assert.ok(v, `${name} is not a hex token in ${TOKENS_REL}`); return v; };

const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (h) => { const [r, g, b] = rgb(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// alpha-composite an rgba tint over a solid background, rounded half-up as Chrome renders it
const over = ([r, g, b, a], bg) => '#' + rgb(bg).map((c, i) => Math.floor(c + ([r, g, b][i] - c) * a + 0.5).toString(16).padStart(2, '0')).join('');

// ── M22: one token file ─────────────────────────────────────────────────────────
// The brand tokens the book names. Each is declared in design-tokens.css and nowhere else.
const BRAND_TOKENS = [
  '--accent', '--bg-page', '--bg-card', '--bg-elevated', '--bg-selected', '--text-primary', '--text-secondary',
  '--text-muted', '--text-label', '--text-subtle', '--border-default', '--border-strong', '--border-control',
  '--status-failed', '--status-failed-bg', '--stem-drums', '--stem-bass', '--stem-guitar', '--stem-keys',
  '--stem-vocals', '--stem-other', '--sl-stem-strip', '--font-sans', '--font-mono', '--text-12', '--text-h2',
  '--text-display', '--text-min', '--text-min-mono', '--h-control', '--h-field', '--touch-min', '--sl-container',
  '--sl-reading', '--sl-section', '--sl-gutter', '--sl-ease', '--sl-dur-1', '--sl-dur-2', '--sl-grid',
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-full',
];

test('M22: every brand token is declared in design-tokens.css and in no other stylesheet', () => {
  for (const name of BRAND_TOKENS) {
    assert.match(TOKENS, new RegExp(`${name}\\s*:`), `${name} missing from ${TOKENS_REL}`);
    for (const f of CSS_FILES) {
      if (f.endsWith('design-tokens.css')) continue;
      assert.doesNotMatch(uncomment(readFileSync(f, 'utf8')), new RegExp(`(^|[;{\\s])${name}\\s*:`),
        `${relative(WEB, f)} redeclares ${name}; tokens live in ${TOKENS_REL} only`);
    }
  }
});

test('M22: no stylesheet but the token file declares custom properties on :root (bar the demo state)', () => {
  for (const f of CSS_FILES) {
    if (f.endsWith('design-tokens.css')) continue;
    const css = uncomment(readFileSync(f, 'utf8'));
    for (const m of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
      const names = [...m[1].matchAll(/(--[\w-]+)\s*:/g)].map((x) => x[1]);
      const allowed = f.endsWith('styles/landing.css') ? new Set(['--region', '--ph']) : new Set();
      for (const n of names) assert.ok(allowed.has(n), `${relative(WEB, f)} declares ${n} on :root`);
    }
  }
});

test('globals.css loads the token file on every route', () => {
  assert.match(uncomment(read('src/app/globals.css')), /@import\s+['"]\.\.\/styles\/design-tokens\.css['"]/);
  assert.match(read('src/app/layout.tsx'), /import ['"]\.\/globals\.css['"]/);
});

// ── M18 / A8: dead reference CSS and the retired focus-ring token ────────────────
test('M18: the unused .sl-* component classes are gone from the token file', () => {
  assert.doesNotMatch(TOKENS, /^\s*\.sl-[\w-]+\s*[,{]/m);
});

test('A8: --focus-ring is retired; the focus ring is the solid 2px lime outline', () => {
  for (const f of CODE_FILES) assert.doesNotMatch(uncomment(readFileSync(f, 'utf8')), /--focus-ring/, relative(WEB, f));
  assert.match(uncomment(read('src/styles/stem-color.css')), /:focus-visible\s*\{\s*outline:\s*2px solid var\(--accent\);\s*outline-offset:\s*2px;/);
  for (const bg of ['--bg-page', '--bg-surface', '--bg-card', '--bg-nav']) {
    assert.ok(ratio(tok('--accent'), tok(bg)) >= 3, `focus ring on ${bg} ${ratio(tok('--accent'), tok(bg)).toFixed(2)}:1`);
  }
});

// ── A4 / M21: the failed red and its tint ───────────────────────────────────────
test('A4/M21: --status-failed is #ff5f5f and its tint is the same hue', () => {
  assert.equal(tok('--status-failed'), '#ff5f5f');
  const m = TOKENS.match(/--status-failed-bg:\s*rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/);
  assert.ok(m, '--status-failed-bg is an rgba() tint');
  assert.deepEqual([+m[1], +m[2], +m[3]], rgb('#ff5f5f'), 'the tint follows the hue (M21)');
  const tint = over([+m[1], +m[2], +m[3], +m[4]], tok('--bg-page'));
  assert.ok(ratio('#ff5f5f', tint) >= 4.5, `failed text on its tint ${ratio('#ff5f5f', tint).toFixed(2)}:1`);
  for (const bg of ['--bg-page', '--bg-card']) assert.ok(ratio('#ff5f5f', tok(bg)) >= 4.5, `failed on ${bg}`);
  assert.ok(ratio(tok('--text-inverse'), '#ff5f5f') >= 4.5, 'dark text on a failed fill');
});

// ── A9 / M5 / M20: small text and control edges meet their floors ───────────────
test('A9: --text-label passes 4.5:1 on every surface; --text-subtle is never small text', () => {
  for (const bg of ['--bg-page', '--bg-surface', '--bg-card', '--bg-elevated']) {
    assert.ok(ratio(tok('--text-label'), tok(bg)) >= 4.5, `--text-label on ${bg} ${ratio(tok('--text-label'), tok(bg)).toFixed(2)}:1`);
  }
  assert.ok(ratio(tok('--text-subtle'), tok('--bg-page')) < 4.5, 'if --text-subtle ever passes, this rule can relax');
  for (const f of CODE_FILES) {
    const src = uncomment(readFileSync(f, 'utf8'));
    assert.doesNotMatch(src, /color:\s*['"]?var\(--text-subtle/, `${relative(WEB, f)} sets text in --text-subtle (large text only)`);
  }
});

test('M20: --border-control is >= 3:1 on every surface a control sits on, and controls use it', () => {
  for (const bg of ['--bg-page', '--bg-surface', '--bg-card', '--bg-elevated']) {
    assert.ok(ratio(tok('--border-control'), tok(bg)) >= 3, `--border-control on ${bg} ${ratio(tok('--border-control'), tok(bg)).toFixed(2)}:1`);
  }
  for (const weak of ['--border-strong', '--border-default']) assert.ok(ratio(tok(weak), tok('--bg-page')) < 3, `${weak} is not a control edge`);
  const section = uncomment(read('src/components/play/SectionLoop.module.css'));
  assert.match(section, /\.chip,\s*\.clear\s*\{[^}]*border:\s*1\.5px solid var\(--border-control\)/);
  assert.match(section, /\.time\s*\{[^}]*color:\s*var\(--text-label\)/);
  const nav = uncomment(read('src/styles/signed-in-nav.css'));
  assert.match(nav, /\.sin-item\.sin-outlined\s*\{[^}]*border-color:\s*var\(--border-control\)/);
  assert.match(nav, /\.sin-toggle\s*\{[^}]*border:\s*1px solid var\(--border-control\)/);
  assert.match(uncomment(read('src/components/play/Player.module.css')), /\.retry\s*\{[^}]*border:\s*1\.5px solid var\(--border-control\)/);
});

test('M27: the auth and account forms share one 48px field on --bg-elevated with a control edge', () => {
  const s = read('src/lib/ui/form-styles.ts');
  assert.match(s, /minHeight:\s*'var\(--h-field\)'/);
  assert.match(s, /border:\s*'1\.5px solid var\(--border-control\)'/);
  assert.match(s, /background:\s*'var\(--bg-elevated\)'/);
  assert.match(s, /borderRadius:\s*'var\(--radius-md\)'/);
  for (const f of ['LoginForm', 'ResetPasswordRequestForm', 'ResetPasswordSetForm', 'DeleteAccountForm']) {
    const src = read(`src/components/${f}.tsx`);
    assert.match(src, /from '@\/lib\/ui\/form-styles'/, `${f} uses the shared field`);
    assert.doesNotMatch(src, /border-default/, `${f} still draws a 1.35:1 control edge`);
  }
});

// ── A5 / M3 / M8 / M19: lime keeps its three jobs ───────────────────────────────
test('A5/M19: no link, selected state or progress is lime', () => {
  const globals = uncomment(read('src/app/globals.css'));
  const a = globals.match(/(^|\n)\s*a\s*\{([^}]*)\}/);
  assert.ok(a, 'globals.css styles links');
  assert.doesNotMatch(a[2], /--accent/, 'the global link colour is not lime (M19)');
  // Billing pages are out of this PR's scope (they need Jon's approval by number), so their
  // lime text links are a named exception until a [billing] PR moves them.
  const BILLING_DEFERRED = new Set(['src/app/success/page.tsx']);
  for (const f of CODE_FILES.filter((p) => p.endsWith('.tsx') && !BILLING_DEFERRED.has(relative(WEB, p)))) {
    assert.doesNotMatch(uncomment(readFileSync(f, 'utf8')), /\bcolor:\s*'var\(--accent\)'/, `${relative(WEB, f)}: lime text`);
  }
  const section = uncomment(read('src/components/play/SectionLoop.module.css'));
  const pressed = section.match(/\.chip\[aria-pressed='true'\]\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(pressed, /accent/, 'the pressed section chip is neutral');
  assert.doesNotMatch(section.match(/\.badge\s*\{([^}]*)\}/)[1], /accent/, 'the Looping badge is neutral');
  const transport = uncomment(read('src/components/play/Transport.module.css'));
  assert.doesNotMatch(transport.match(/\.fill\s*\{([^}]*)\}/)[1], /accent/, 'the seek fill is not lime');
  assert.doesNotMatch(transport.match(/\.thumb\s*\{([^}]*)\}/)[1], /accent/, 'the seek thumb is not lime');
  const nav = uncomment(read('src/styles/signed-in-nav.css'));
  assert.doesNotMatch(nav.match(/\.sin-item\.sin-current\s*\{([^}]*)\}/)[1], /accent|#1c1c1f/, 'current nav item is white on --bg-selected');
});

test('M3: the signed-in wordmark is the §2 wordmark: sans, 20px, bold, only the dash lime', () => {
  const nav = uncomment(read('src/styles/signed-in-nav.css'));
  const wm = nav.match(/\.sin-wordmark\s*\{([^}]*)\}/)[1];
  assert.match(wm, /font-family:\s*var\(--font-sans\)/);
  assert.match(wm, /font-size:\s*var\(--text-xl\)/);
  assert.match(wm, /font-weight:\s*var\(--weight-bold\)/);
  assert.match(nav.match(/\.sin-dash\s*\{([^}]*)\}/)[1], /color:\s*var\(--accent\)/);
  assert.doesNotMatch(nav.match(/\.sin-loops\s*\{([^}]*)\}/)[1], /accent/);
  // landing.css says the same thing once: "loops" white
  assert.doesNotMatch(uncomment(read('src/styles/landing.css')), /\.wm-loops\s*\{[^}]*accent/);
});

// ── A3: one stem order everywhere ───────────────────────────────────────────────
test('A3: every stem list, key and strip uses the mixer order (Story 2.1)', () => {
  const types = read('src/lib/play/types.ts');
  const playable = [...types.match(/export const PLAYABLE_STEMS = \[([\s\S]*?)\]/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(playable, ['drums', 'bass', 'guitar', 'keys', 'vocals', 'other']);
  const lists = {
    'src/components/landing/demo-data.ts': /export const STEM_ORDER = \[([^\]]*)\]/,
    'src/components/JobProgress.tsx': /const STEM_ORDER = \[([^\]]*)\]/,
    'src/components/LoopResults.tsx': /const STEM_ORDER = \[([^\]]*)\]/,
  };
  for (const [file, re] of Object.entries(lists)) {
    const order = [...read(file).match(re)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
    assert.deepEqual(order, playable, `${file} lists stems out of order`);
  }
  const strip = TOKENS.match(/--sl-stem-strip:\s*linear-gradient\(([\s\S]*?)\);/)[1];
  assert.deepEqual([...strip.matchAll(/--stem-(\w+)/g)].map((m) => m[1]), playable, 'the stem key');
  const phone = uncomment(read('src/styles/landing-color.css')).match(/#options-toggle\s*\{[^}]*linear-gradient\(([\s\S]*?)\);/)[1];
  assert.deepEqual([...phone.matchAll(/--k-(\w+)/g)].map((m) => m[1]), playable, 'the phone options key');
  // prose on the landing names them in the same order
  const page = read('src/app/(landing)/page.tsx');
  assert.doesNotMatch(page, /drums, bass, vocals, guitar/);
});

// ── A15 / M13: type ─────────────────────────────────────────────────────────────
test('A15: the minimum text size is a token (11px readable, 12px mono labels)', () => {
  assert.match(TOKENS, /--text-sm:\s*11px/);
  assert.match(TOKENS, /--text-12:\s*12px/);
  assert.match(TOKENS, /--text-min:\s*var\(--text-sm\)/);
  assert.match(TOKENS, /--text-min-mono:\s*var\(--text-12\)/);
});

test('M13: the body uses --font-sans, and JetBrains Mono loads on every route', () => {
  assert.match(uncomment(read('src/app/globals.css')), /font-family:\s*var\(--font-sans\)/);
  assert.doesNotMatch(uncomment(read('src/app/globals.css')), /Roboto/);
  assert.match(TOKENS, /--font-mono:\s*var\(--font-jbm/);
  const layout = read('src/app/layout.tsx');
  assert.match(layout, /localFont\(\{[\s\S]*variable:\s*'--font-jbm'/);
  assert.match(layout, /<html[^>]*className=\{jetbrainsMono\.variable\}/);
});

// ── M12 / M23 / M24 / M25: off-scale values ─────────────────────────────────────
test('M12/M23/M24/M25: no off-palette reds, no capitalised stem names, 44px dismiss target', () => {
  assert.doesNotMatch(read('src/components/LoopResults.tsx'), /--danger|#e5484d|textTransform:\s*'capitalize'/);
  assert.doesNotMatch(read('src/components/DeleteAccountForm.tsx'), /#c62828/);
  assert.doesNotMatch(uncomment(read('src/styles/loop-card.css')), /capitalize/);
  assert.doesNotMatch(read('src/components/FlashBanner.tsx'), /minHeight:\s*32|minWidth:\s*32/);
  assert.doesNotMatch(uncomment(read('src/styles/stem-color.css')), /border-radius:\s*10px/);
  assert.doesNotMatch(uncomment(read('src/styles/signed-in-nav.css')), /border-radius:\s*(10|22)px/);
});
