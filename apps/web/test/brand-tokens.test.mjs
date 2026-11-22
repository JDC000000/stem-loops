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
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-full', '--chord-now',
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
const SURFACES = ['--bg-page', '--bg-nav', '--bg-surface', '--bg-card', '--bg-elevated', '--bg-selected'];

test('A9: --text-label passes 4.5:1 on every surface; --text-subtle is never small text', () => {
  for (const bg of SURFACES) {
    assert.ok(ratio(tok('--text-label'), tok(bg)) >= 4.5, `--text-label on ${bg} ${ratio(tok('--text-label'), tok(bg)).toFixed(2)}:1`);
  }
  assert.ok(ratio(tok('--text-subtle'), tok('--bg-page')) < 4.5, 'if --text-subtle ever passes, this rule can relax');
  for (const f of CODE_FILES) {
    const src = uncomment(readFileSync(f, 'utf8'));
    assert.doesNotMatch(src, /color:\s*['"]?var\(--text-subtle/, `${relative(WEB, f)} sets text in --text-subtle (large text only)`);
  }
});

test('M20: --border-control is >= 3:1 on every surface a control sits on, and controls use it', () => {
  for (const bg of SURFACES) {
    assert.ok(ratio(tok('--border-control'), tok(bg)) >= 3, `--border-control on ${bg} ${ratio(tok('--border-control'), tok(bg)).toFixed(2)}:1`);
  }
  for (const weak of ['--border-strong', '--border-default']) assert.ok(ratio(tok(weak), tok('--bg-page')) < 3, `${weak} is not a control edge`);
  // Slice 1a: the section strip's chips are the approved mockup's pills, edged
  // with a control colour. D2 (2026-11-21): the edge is the chip's SECTION
  // colour (--sec), which defaults to the control colour; the section colours
  // themselves are checked below (>= 3:1 too).
  const section = uncomment(read('src/components/play/SectionLoop.module.css'));
  assert.match(section, /\.chip\s*\{[^}]*--sec:\s*var\(--border-control\)/);
  assert.match(section, /\.chip\s*\{[^}]*border:\s*1px solid var\(--sec\)/);
  for (const f of ['Transport', 'Presets', 'MixSheet']) {
    const css = uncomment(read(`src/components/play/${f}.module.css`));
    assert.match(css, /border:\s*1(\.5)?px solid var\(--border-control\)/, `${f}: controls take the control edge`);
    assert.doesNotMatch(css, /border[\w-]*:[^;]*var\(--border-(default|strong)\)[^;]*;[^}]*cursor:\s*pointer/, `${f}: a 1.35-1.71:1 control edge`);
  }
  const nav = uncomment(read('src/styles/signed-in-nav.css'));
  assert.match(nav, /\.sin-item\.sin-outlined\s*\{[^}]*border-color:\s*var\(--border-control\)/);
  // A4 (2026-11-21): the phone menu toggle is gone (three items inline), and with it its edge.
  assert.doesNotMatch(nav, /\.sin-toggle\b/);
  assert.match(uncomment(read('src/components/play/Player.module.css')), /\.retry\s*\{[^}]*border:\s*1\.5px solid var\(--border-control\)/);
});

test('D2: section colours (chip edge, dot, seek-line tick) are the --section-* tokens, >= 3:1 on the page, the selected fill and the rail', () => {
  // Story 4.8 / Jon 2026-11-21: "I like the colour separations". Review H2 on
  // #330: NOT the stem hues (each one means its stem, and the "my part" pills
  // sit right above the strip), never lime (--accent) or amber (--chord-now).
  // They must read as UI (1.4.11, >= 3:1) where a chip sits (the page), on the
  // selected chip (#222, where the dot carries it) and on the seek rail.
  const section = uncomment(read('src/components/play/SectionLoop.module.css'));
  const ticks = uncomment(read('src/components/play/Transport.module.css'));
  const tones = [...section.matchAll(/\.chip\[data-tone='(\d)'\]\s*\{\s*--sec:\s*var\((--[\w-]+)\)/g)].map((m) => [m[1], m[2]]);
  assert.ok(tones.length >= 3, `section tones found: ${tones.length}`);
  for (const [i, t] of tones) {
    assert.match(t, /^--section-[a-z]$/, `tone ${i} is a section token`);
    const hex = tok(t).toLowerCase();
    for (const other of ['--stem-drums', '--stem-bass', '--stem-guitar', '--stem-keys', '--stem-vocals', '--stem-other', '--accent', '--chord-now', '--status-expiry'])
      assert.notEqual(hex, (hexTokens[other] ?? '').toLowerCase(), `${t} reuses ${other}`);
    for (const bg of ['--bg-page', '--bg-selected', '--border-strong']) {
      const r = ratio(tok(t), tok(bg));
      assert.ok(r >= 3, `${t} on ${bg} is ${r.toFixed(2)}:1`);
    }
    assert.match(ticks, new RegExp(`\\.tick\\[data-tone='${i}'\\]\\s*\\{\\s*background:\\s*var\\(${t}\\)`), `tick tone ${i} matches its chip`);
  }
  assert.doesNotMatch(section + ticks, /--sec:\s*var\(--(accent|chord-now|status-expiry)/);
});

// the body of one exported style object in form-styles.ts
const FORM_STYLES = uncomment(read('src/lib/ui/form-styles.ts')).replace(/\/\/.*$/gm, '');
const styleObj = (name) => {
  const m = FORM_STYLES.match(new RegExp(`export const ${name}: CSSProperties = \\{([^}]*)\\}`));
  assert.ok(m, `form-styles.ts exports ${name}`);
  return m[1];
};

test('M27: the auth and account forms share one 48px field on --bg-elevated with a control edge', () => {
  const field = styleObj('fieldStyle');
  assert.match(field, /minHeight:\s*'var\(--h-field\)'/);
  assert.match(field, /border:\s*'1\.5px solid var\(--border-control\)'/, 'the field edge is the 1.5px control edge');
  assert.match(field, /background:\s*'var\(--bg-elevated\)'/);
  assert.match(field, /borderRadius:\s*'var\(--radius-md\)'/);
  assert.doesNotMatch(field, /outline/, 'the field keeps the global focus ring');
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
  assert.doesNotMatch(pressed, /accent|chord-now/, 'the pressed section chip is neutral');
  // Selected/pressed is NEUTRAL everywhere on the player: #222 + a 2px white edge.
  assert.match(pressed, /background:\s*var\(--bg-selected\)/);
  assert.match(pressed, /border:\s*2px solid var\(--text-primary\)/);
  const transport = uncomment(read('src/components/play/Transport.module.css'));
  assert.doesNotMatch(transport.match(/\.fill\s*\{([^}]*)\}/)[1], /accent/, 'the seek fill is not lime');
  assert.doesNotMatch(transport.match(/\.thumb\s*\{([^}]*)\}/)[1], /accent/, 'the seek thumb is not lime');
  assert.doesNotMatch(transport.match(/\.band\s*\{([^}]*)\}/)[1], /accent|chord-now/, 'the loop band is neutral');
  assert.doesNotMatch(transport.match(/\.loop\[data-state='on'\]\s*\{([^}]*)\}/)[1], /accent|chord-now/, 'the pressed loop button is neutral');
  const presets = uncomment(read('src/components/play/Presets.module.css'));
  assert.doesNotMatch(presets.match(/\.preset\[aria-pressed='true'\],\s*\.part\[aria-pressed='true'\]\s*\{([^}]*)\}/)[1], /accent|chord-now/, 'the pressed preset is neutral');
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
    'src/components/JobProgress.tsx': /const STEM_ORDER = \[([^\]]*)\]/,
    'src/components/LoopResults.tsx': /const STEM_ORDER = \[([^\]]*)\]/,
  };
  for (const [file, re] of Object.entries(lists)) {
    const order = [...read(file).match(re)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
    assert.deepEqual(order, playable, `${file} lists stems out of order`);
  }
  const strip = TOKENS.match(/--sl-stem-strip:\s*linear-gradient\(([\s\S]*?)\);/)[1];
  assert.deepEqual([...strip.matchAll(/--stem-(\w+)/g)].map((m) => m[1]), playable, 'the stem key');
  // A4: the home form takes its stem list from PLAYABLE_STEMS itself (the phone options key and
  // the landing demo's own STEM_ORDER copy are gone).
  assert.match(read('src/components/landing/ToolForm.tsx'), /const STEM_ORDER: readonly string\[\] = PLAYABLE_STEMS;/);
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

// ── Review follow-ups (PR #275): button hierarchy, lime in CSS, nav current, touch tokens ──
test('A5/§7.1: one lime button; secondaries have a control edge; the sign-up step is emphasised without lime', () => {
  assert.match(styleObj('primaryButton'), /background:\s*'var\(--accent\)'/);
  const secondary = styleObj('secondaryButton');
  assert.match(secondary, /border:\s*'1\.5px solid var\(--border-control\)'/, 'secondary edge is --border-control');
  assert.match(secondary, /fontWeight:\s*500/, 'secondary buttons are weight 500 (§5)');
  const emph = styleObj('secondaryEmphasisButton');
  const edge = emph.match(/border:\s*'1\.5px solid var\((--[\w-]+)\)'/);
  assert.ok(edge, 'the emphasised secondary has a 1.5px token edge');
  assert.ok(ratio(tok(edge[1]), tok('--bg-page')) > ratio(tok('--border-control'), tok('--bg-page')),
    'the emphasised edge is stronger than the secondary edge');
  assert.match(emph, /fontWeight:\s*600/, 'and heavier than the secondary');
  for (const name of ['secondaryButton', 'secondaryEmphasisButton', 'fieldStyle', 'textButton']) {
    assert.doesNotMatch(styleObj(name), /accent/, `${name} is not lime`);
  }
  const login = read('src/components/LoginForm.tsx');
  assert.match(login, /secondaryEmphasisButton \}\}>\s*New here\? Create account/, '"Create account" is the emphasised secondary');
  // A4 (2026-11-21): two spreads, mutually exclusive on `emailOpen`: Google while the email options
  // are folded, the email form's submit once they are open. Rendered both ways in
  // test/a4-home-link.test.mjs ("one lime action" in each state).
  assert.equal(uncomment(login).match(/\bprimaryButton\b/g).length, 3, 'the import and two lime uses, one per state');
  assert.match(login, /\.\.\.\(emailOpen \? secondaryButton : primaryButton\)/, 'Google: lime only while email is folded');
  assert.match(login, /\.\.\.\(emailOpen \? primaryButton : secondaryButton\)/, 'email submit: lime only while email is open');
  for (const f of CODE_FILES.filter((p) => /\.tsx?$/.test(p))) {
    assert.doesNotMatch(uncomment(readFileSync(f, 'utf8')), /\bborder\w*:\s*['`][^'`]*var\(--accent/, `${relative(WEB, f)}: lime edge`);
  }
});

test('A5: in CSS, lime is only a focus outline, a primary fill or the wordmark dash', () => {
  const LIME = /var\(--accent(-hover|-active)?\s*[,)]|#a3e635/i;
  const PRIMARY = /^\.(play|btn-primary|jp-primary)\b/;
  const DASH = /^\.(wm-dash|sin-dash)$/;
  for (const f of CSS_FILES.filter((p) => !p.endsWith('design-tokens.css'))) {
    const css = uncomment(readFileSync(f, 'utf8')).replace(/var\(--stem,\s*var\(--accent\)\)/g, 'var(--stem)');
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = sel.trim().replace(/\s+/g, ' ');
      for (const decl of body.split(';')) {
        const m = decl.match(/^\s*([\w-]+)\s*:(.*)$/s);
        if (!m || !LIME.test(m[2])) continue;
        const prop = m[1];
        const ok = (prop.startsWith('outline') && selector.includes(':focus-visible'))
          || (prop.startsWith('background') && PRIMARY.test(selector))
          || (prop === 'color' && DASH.test(selector));
        assert.ok(ok, `${relative(WEB, f)}: "${selector} { ${prop} }" is lime (A5: focus, primary fill, wordmark dash only)`);
      }
    }
  }
});

test('F1: the current nav item has a >= 3:1 edge and weight, plus aria-current', () => {
  const nav = uncomment(read('src/styles/signed-in-nav.css'));
  const rules = [...nav.matchAll(/\.sin-item\.sin-current\s*\{([^}]*)\}/g)].map((m) => m[1]).join(';');
  const edge = rules.match(/border-color:\s*var\((--[\w-]+)\)/);
  assert.ok(edge, 'the current item draws an edge');
  for (const bg of ['--bg-page', '--bg-selected']) {
    assert.ok(ratio(tok(edge[1]), tok(bg)) >= 3, `current edge on ${bg} ${ratio(tok(edge[1]), tok(bg)).toFixed(2)}:1`);
  }
  assert.match(rules, /font-weight:\s*var\(--weight-semibold\)/);
  // the current rule comes after .sin-outlined, so the outlined Account item takes it too
  assert.ok(nav.lastIndexOf('.sin-item.sin-current') > nav.indexOf('.sin-item.sin-outlined'));
  assert.match(read('src/components/chrome/SignedInNav.tsx'), /'aria-current':\s*'page'/);
});

test('M25: touch tokens are >= 44px (fields 48px) and the dismiss uses them', () => {
  const px = (name) => { const m = TOKENS.match(new RegExp(`${name}:\\s*(\\d+)px`)); assert.ok(m, `${name} in px`); return +m[1]; };
  assert.ok(px('--touch-min') >= 44, '--touch-min');
  assert.ok(px('--h-control') >= 44, '--h-control');
  assert.ok(px('--h-field') >= 48, '--h-field');
  const dismiss = read('src/components/FlashBanner.tsx');
  assert.match(dismiss, /minHeight:\s*'var\(--touch-min\)'/);
  assert.match(dismiss, /minWidth:\s*'var\(--touch-min\)'/);
  assert.match(styleObj('buttonBase'), /minHeight:\s*'var\(--h-control\)'/);
});

test('M12: loop-card buttons take the button radius', () => {
  const card = uncomment(read('src/styles/loop-card.css'));
  const btns = card.match(/\.play-btn,\s*\.btn-download-wav,\s*\.action-row button,\s*\.action-row a\s*\{([^}]*)\}/)[1];
  assert.match(btns, /border-radius:\s*var\(--radius-md\)/);
});

// ── Slice 1a (design v1.4; Jon 2026-11-17): the current chord is amber, and amber has ONE job ──
const PLAYER_CODE = [
  ...walk(join(SRC, 'components/play')),
  join(SRC, 'components/ChordOverlay.tsx'),
  join(SRC, 'components/ChordPhone.helpers.ts'),
  ...walk(join(SRC, 'app/jobs')),
].filter((p) => /\.(tsx?|css)$/.test(p) && !/\.test\./.test(p));

test('--chord-now is Amber Gold, a NEW section-1 token; the archived ACCENT B block stays inactive', () => {
  assert.equal(tok('--chord-now'), '#f59e0b');
  const raw = read(TOKENS_REL);
  const section1 = raw.slice(raw.indexOf('1. BASE'), raw.indexOf('2. ACCENT A'));
  assert.match(uncomment(section1), /--chord-now:\s*#f59e0b;/, '--chord-now is declared in section 1');
  // Its comment gives it exactly one job, says so in those words, carries the
  // figures below and Jon's approval (the lime token carries a LOCKED note too).
  const note = section1.slice(section1.lastIndexOf('/*', section1.indexOf('--chord-now:')), section1.indexOf('--chord-now:'));
  assert.match(note, /ONE job: the CURRENT chord, at the playhead/);
  assert.match(note, /stays\s+amber while paused/);
  assert.match(note, /approved by Jon 2026-11-17/);
  for (const fig of ['9.05:1 on #0d0d0d', '8.43:1 on #161616', '7.41:1 on #222222']) assert.ok(note.replace(/\s+/g, ' ').includes(fig), fig);
  assert.match(raw, /CHORD-NOW: Amber Gold #f59e0b — LOCKED \(approved by Jon 2026-11-17\)/);
  // ACCENT B is still a comment (amber is not an accent), with a note that its hex is reused.
  const b = raw.slice(raw.indexOf('3. ACCENT B'), raw.indexOf('4. ACCENT C'));
  assert.match(b, /its hex is reused by --chord-now/);
  assert.doesNotMatch(uncomment(b), /--accent\s*:/, 'ACCENT B must stay commented out');
  assert.equal(tok('--accent'), '#a3e635', 'lime is still THE accent');
});

test('--chord-now reads as text >= 7:1 on the page, a card and the selected bar (and the comment is right)', () => {
  const want = { '--bg-page': 9.05, '--bg-card': 8.43, '--bg-selected': 7.41 };
  for (const [bg, fig] of Object.entries(want)) {
    const r = ratio(tok('--chord-now'), tok(bg));
    assert.ok(r >= 7, `--chord-now on ${bg} ${r.toFixed(2)}:1`);
    assert.equal(Number(r.toFixed(2)), fig, `the token comment's figure for ${bg}`);
  }
});

test('amber keeps its ONE job: var(--chord-now) / #f59e0b only colour the current chord', () => {
  const AMBER = /var\(--chord-now|#f59e0b/i;
  // CSS: only the Mix sheet header's chord, as a text colour.
  for (const f of CSS_FILES.filter((p) => !p.endsWith('design-tokens.css'))) {
    const css = uncomment(readFileSync(f, 'utf8'));
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const decl of body.split(';')) {
        const m = decl.match(/^\s*([\w-]+)\s*:(.*)$/s);
        if (!m || !AMBER.test(m[2])) continue;
        const ok = relative(WEB, f) === 'src/components/play/MixSheet.module.css' && sel.trim() === '.now' && m[1] === 'color';
        assert.ok(ok, `${relative(WEB, f)}: "${sel.trim()} { ${m[1]} }" is amber (its one job is the current chord)`);
      }
    }
  }
  // TS/TSX: only ChordOverlay's stage, through ONE constant.
  for (const f of CODE_FILES.filter((p) => /\.tsx?$/.test(p))) {
    const src = uncomment(readFileSync(f, 'utf8')).replace(/\/\/.*$/gm, '');
    if (!AMBER.test(src)) continue;
    assert.equal(relative(WEB, f), 'src/components/ChordOverlay.tsx', `${relative(WEB, f)} uses amber`);
    assert.equal((src.match(/var\(--chord-now/g) ?? []).length, 1, 'one CHORD_NOW constant');
    assert.match(src, /const CHORD_NOW = 'var\(--chord-now, #f59e0b\)';/);
    // Every use of the constant is the current chord: the Now name (data-testid
    // playhead-now-name), the current bar's edge (outline, drawn inside the bar
    // so the chords in it do not move) and the current chord's text.
    const uses = [...src.matchAll(/^.*CHORD_NOW.*$/gm)].map((m) => m[0].trim()).filter((l) => !l.startsWith('const CHORD_NOW'));
    assert.ok(uses.length >= 3, uses.join('\n'));
    for (const u of uses) {
      assert.match(u, /^(color: isCurSlot \? CHORD_NOW|outline: isCur \? `2px solid \$\{CHORD_NOW\}`|style=\{\{ fontSize: fit\.px, [^}]*color: CHORD_NOW)/, `CHORD_NOW used outside the current chord: ${u}`);
    }
  }
});

test('the expiry orange never appears on /jobs/[id] (it reads as the chord-now amber to colour-blind users)', () => {
  for (const f of PLAYER_CODE) {
    const src = uncomment(readFileSync(f, 'utf8')).replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /--status-expiry|#fb923c/i, `${relative(WEB, f)} uses the expiry orange on the player`);
  }
  // The player's "deleted in …" line is neutral Song info text.
  const info = uncomment(read('src/components/play/Player.module.css')).match(/\.info\s*\{([^}]*)\}/)[1];
  assert.match(info, /color:\s*var\(--text-secondary\)/);
  // And JobView hands that line to the player, it does not style it.
  assert.match(read('src/app/jobs/[id]/JobView.tsx'), /songInfo=\{songInfoLines\(job\)\}/);
});

test('A5: lime is ONE primary fill per player view: the Play button', () => {
  const LIME_FILL = /background[\w-]*:\s*var\(--accent(-hover|-active)?\s*[,)]|background[\w-]*:\s*#a3e635/i;
  const fills = [];
  for (const f of PLAYER_CODE) {
    const css = uncomment(readFileSync(f, 'utf8'));
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (LIME_FILL.test(body)) fills.push(`${relative(WEB, f)} ${sel.trim()}`);
    }
    if (/\.tsx?$/.test(f)) assert.doesNotMatch(css, /background\w*:\s*['`]var\(--accent/, `${relative(WEB, f)}: an inline lime fill`);
  }
  assert.deepEqual(fills, [
    'src/components/play/Transport.module.css .play',
    'src/components/play/Transport.module.css .play:hover:not(:disabled)',
  ]);
});

test('A5: lime is ONE primary fill on /pricing, signed in or out: Get Pro', async () => {
  // Rendered with the real BillingButton.tsx (helpers/render-pricing-page.mjs): the plan and
  // credit-pack buttons paint their fill inline, so the CSS scans above cannot see it.
  const { renderPricingPage, limeFills } = await import('./helpers/render-pricing-page.mjs');
  const plan = (code, name, cents) => ({ code, display_name: name, price_cad_cents: cents, monthly_job_quota: 5, services: ['youtube'], export_stems: false, export_wav24: false });
  const plans = [plan('free', 'Free', 0), plan('pro', 'Pro', 499), plan('studio', 'Studio', 1200)];
  const packs = [20, 60, 180].map((n) => ({ pack_code: `credits_${n}`, credits: n, price_cad_cents: n * 25 }));
  const signedOut = await renderPricingPage({ user: null, plans, packs });
  assert.deepEqual(limeFills(signedOut), ['a Get Pro'], 'signed out');
  const signedIn = await renderPricingPage({ user: { user_id: '22222222-2222-2222-2222-222222222222', email: 'u@x.co' }, plans, packs });
  assert.deepEqual(limeFills(signedIn), ['button Get Pro'], 'signed in');
});

test('A16 (amended, approved by Jon 2026-11-17): section chips are 22px pills, and the token file says so', () => {
  const raw = read(TOKENS_REL);
  assert.match(raw, /Brand book A16, AMENDED \(approved by Jon 2026-11-17\)/);
  const chip = uncomment(read('src/components/play/SectionLoop.module.css')).match(/\.chip\s*\{([^}]*)\}/)[1];
  assert.match(chip, /border-radius:\s*22px;/);
  assert.match(chip, /height:\s*var\(--touch-min, 44px\)/);
});

test('the chord countdown is neutral (review of #333, H-1): #e0e0e0 lit, #737373 unlit, never amber', () => {
  const src = readFileSync(join(WEB, 'src/components/ChordOverlay.tsx'), 'utf8');
  assert.match(src, /const COUNTDOWN_ON = 'var\(--text-secondary, #e0e0e0\)';/);
  assert.match(src, /const COUNTDOWN_OFF = 'var\(--border-control, #737373\)';/);
  const block = src.slice(src.indexOf('const Countdown: FC'), src.indexOf('const PhoneChords: FC'));
  assert.ok(block.length > 100);
  assert.doesNotMatch(block, /CHORD_NOW|chord-now|f59e0b/i);
  // Contrast: lit 15.4:1, unlit 4.10:1 on the page (>= 3:1 for UI, WCAG 1.4.11).
  assert.ok(ratio(tok('--text-secondary'), tok('--bg-page')) >= 3);
  assert.ok(ratio(tok('--border-control'), tok('--bg-page')) >= 3);
});
