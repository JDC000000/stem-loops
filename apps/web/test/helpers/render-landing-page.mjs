// Server-render the WHOLE landing page to static HTML, and reduce it to the text a human
// actually reads. No jsdom: the page is a sync server component whose every use of `window`
// and `document` sits inside an event handler or a useEffect body, neither of which
// renderToStaticMarkup runs.
//
// WHY THIS EXISTS — a source-text ban list is UNSOUND, in BOTH of its forms.
//
// Round 2 moved the ban lists from comment-stripped source onto RAW source, with this
// argument written into the test file: "stripping can only ever REMOVE text from a ban
// list's view, so a ban list that strips can only be weakened; run raw, the worst case is a
// false RED." THAT ARGUMENT IS FALSE, and it was believed by two reviewers before it was
// caught. It assumes raw source is a superset of rendered text. It is not: JSX text is
// COMPILED, not copied.
//
// Measured on this PR (adversarial sweep round 3, 2026-11-11). Changing the hero's
// `.audience` copy to
//
//     No&nbsp;account needed — start a job straight&nbsp;away.
//
// renders the exact sentence the gate forbids, while the RAW SOURCE contains neither
// `no account` nor `straight away` — the entity sits where the space would be. Both ban
// regexes returned false and the suite was unchanged at 926/906/0/20. The same class also
// defeats a raw ban list through Prettier wrapping a phrase across two lines, through
// `No <strong>account</strong> needed`, and through a const or a template.
//
// So raw has its own false-green direction, a DIFFERENT one from the stripped form:
// stripped misses what it deletes, raw misses what the compiler produces. Neither is sound
// alone. The sound reading is the rendered one, and that is what this module produces.
//
// AND THE DOM IS NOT THE ONLY CHANNEL. `export const metadata` never reaches the DOM at all,
// and it is the most-read copy on the site: the <meta name="description"> and the Open Graph
// card, read in search results and link previews BEFORE anyone visits the page. A single
// literal U+00A0 typed into the description template — what happens whenever copy is pasted
// out of a design doc — put this on the built, served page:
//
//   <meta name="description" content="… No account needed — start a job straight away.">
//
// while the raw backstop saw `No account`, which `/no account/i` does not match. Suite
// unchanged at 926/906/0/20 (adversarial sweep round 4, 2026-11-11). So `metadata` is
// flattened and returned here too — which also covers OG_TITLE, OG_DESC and OG_ALT, the same
// blind spot.
//
// WHAT IS STILL NOT COVERED, stated plainly because it is the root cause of this whole class:
// these gates read DOM TEXT and RAW SOURCE, and NEITHER OF THOSE IS WHAT THE READER READS.
// The render pass closed the largest channel, the metadata pass the second, and the attribute
// capture above the third. THREE CHANNELS REMAIN. An earlier version of this comment said
// TWO, which was an overclaim of coverage in the one file whose whole purpose is to stop
// overclaiming — the same defect as the raw-backstop sentence. It is corrected here rather
// than quietly dropped, because a quiet edit is how a false claim survives.
//
//   1. COPY ON A BRANCH THE DEFAULT RENDER DOES NOT TAKE. Error states, and anything behind a
//      handler. DemoProvider sets `no-data` in a useEffect and renderToStaticMarkup runs no
//      effects, so that whole mode goes unrendered here.
//   2. CSS-GENERATED CONTENT. `.audience::after { content: " No account needed — start a job
//      straight away."; }` is not in the DOM, so both normalisations are blind, and the NBSP
//      walks past the raw ban list on the .css file — yet Chrome paints it in the hero,
//      directly under the H1. Demonstrated in Chrome.
//   3. ATTRIBUTE TEXT OTHER THAN `aria-label`, `alt` AND `title` — `placeholder` or
//      `aria-description`, say. This page renders none of those today, and the three that
//      carry an accessible name are captured above, but the tag strip still discards the rest.
//
// Raw source remains a weak backstop over all three: it catches UNOBFUSCATED text only, and
// any entity, wrap, markup or indirection walks straight past it.
//
// THE ENUMERATION IS BELIEVED COMPLETE. Walking the pipeline for a fourth channel finds none:
// the render covers DOM text, the metadata pass covers the head, the capture above covers the
// attributes that carry an accessible name, and anything left is one of (a) not rendered at
// all, (b) not in the DOM, or (c) in the DOM but discarded by the normaliser. That is the
// whole surface. All three are NAMED RESIDUE, not covered cases — no gate can cover every
// rendering channel, and the point of naming them is that the next person need not rediscover
// which ones are open.
//
// Two normalisations are returned, because evading one tends to walk into the other:
//   textSpaced — every tag becomes a space. This is the human reading, and it is what kills
//                `No&nbsp;account` and a phrase wrapped across lines.
//   textTight  — every tag becomes nothing. This kills `no<span> </span>account`, where
//                markup is used to break a banned phrase apart.
// A ban list asserts against both. Either matching is a failure. Both over-match slightly
// at element boundaries, which can only ever produce a false RED.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(WEB, 'src');
// The landing page's entry, kept as a named constant so `landingPage()` below behaves
// exactly as it did before this module was generalised. Any page under src/ can now be
// rendered by passing its src-relative path to `renderPage()`; nothing about the landing
// path, the transpile, the normalisations or the metadata pass changed.
const LANDING_ENTRY = 'app/(landing)/page.tsx';

/** Resolve an import specifier the way the bundler's `@/` alias and extension search do. */
const resolveSrc = (p) => {
  for (const c of [p, `${p}.tsx`, `${p}.ts`, join(p, 'index.tsx'), join(p, 'index.ts')]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
};

/**
 * Transpile the module graph reachable from the page into a temp mirror, rewriting every
 * `@/…` and relative specifier to the absolute file URL of its emitted twin. The TypeScript
 * COMPILER does the compiling; this only walks imports and rewrites specifiers. Bare
 * specifiers (react, next) are left alone so Node resolves them normally.
 */
function build(outDir, entryAbs) {
  const emitted = new Map();
  const emit = (abs) => {
    if (emitted.has(abs)) return emitted.get(abs);
    const out = join(outDir, relative(SRC, abs).replace(/\.tsx?$/, '.mjs'));
    emitted.set(abs, out);
    const js = ts.transpileModule(readFileSync(abs, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
        ...(abs.endsWith('.tsx') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
      },
    }).outputText.replace(/(\bfrom\s*|\bimport\s*)(['"])([^'"]+)\2/g, (whole, kw, q, spec) => {
      const target = spec.startsWith('@/') ? resolveSrc(join(SRC, spec.slice(2)))
        : spec.startsWith('.') ? resolveSrc(join(dirname(abs), spec))
        : null;
      return target ? `${kw}${q}${pathToFileURL(emit(target)).href}${q}` : whole;
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, js);
    return out;
  };
  return { entry: emit(entryAbs), count: emitted.size };
}

// React emits NBSP as a literal U+00A0 and, on this page, no entities at all — but decode the
// handful it can emit anyway, AFTER tags are gone so a decoded `<` is never read as a tag.
const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;|&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const collapse = (s) => s.replace(/[\s   ]+/g, ' ').trim();
const toText = (html, joiner) => collapse(decode(
  html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // Attribute text is text. The tag strip below throws the WHOLE tag away, attributes and
    // all, so an `aria-label` reached neither normalisation — and an `aria-label` OVERRIDES
    // the element's text, so it is what a screen-reader user hears INSTEAD of the link.
    // An `aria-label="sign-in page — no account needed, start a job straight away"` on the
    // scope sheet's sign-in link announced the forbidden claim with this suite green at
    // 926/906/0/20 (adversarial sweep round 5, 2026-11-11). Pulled out here, ahead of the
    // strip. `alt` and `title` are included as the same kind of text; this page renders
    // neither today.
    .replace(/<[^>]*?\s(?:aria-label|alt|title)="([^"]*)"[^>]*>/gi, (_, v) => `${joiner}${v}${joiner}`)
    .replace(/<[^>]*>/g, joiner),
));

/** Every string anywhere in the page's exported `metadata`, however deeply nested. */
const metaStrings = (v, out = []) => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) metaStrings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) metaStrings(x, out);
  return out;
};

/** One rendered result per entry path, so a file asserting many times pays the cost once. */
const cache = new Map();

/**
 * `{ html, textSpaced, textTight, metaSpaced, metaTight, modules }` for ANY page under
 * `src/`, named by its src-relative path (e.g. `app/(landing)/terms/page.tsx`), rendered
 * once per process per path.
 *
 * `html` is the markup, the two texts are the normalisations described at the top of this
 * file, and the two meta* strings are those same normalisations applied to every string in
 * the page's exported `metadata` — joined with a pilcrow, so a banned phrase cannot be
 * assembled across two unrelated fields.
 *
 * GENERALISED, NOT CHANGED. Before this, the entry was a module-level const and the only
 * export was `landingPage()`. The entry is now an argument and `landingPage()` passes the
 * same path it always used, so that function's behaviour — and `landing-copy.test.mjs`,
 * which is the only caller and is being edited on another branch — is untouched. Every
 * caveat in the header comment (the three uncovered rendering channels, the fail-open
 * normalisations, metadata being unreachable from the markup) applies here unchanged,
 * because this is the same code path with a different first module.
 *
 * REQUIREMENT ON THE PAGE: it must render under `renderToStaticMarkup`, i.e. be a sync
 * component. An `async` server component returns a promise React cannot render, and a page
 * that reads cookies or the database (`/pricing`, `/account`, `/jobs/[id]`) cannot be
 * rendered here at all. Both legal pages are sync and read nothing, which is why they can
 * be gated this way and those pages cannot.
 */
export async function renderPage(relPath) {
  const hit = cache.get(relPath);
  if (hit) return hit;
  const outRoot = join(WEB, 'node_modules/.cache');
  mkdirSync(outRoot, { recursive: true });
  const { entry, count } = build(mkdtempSync(join(outRoot, 'render-page-')), join(SRC, relPath));

  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const mod = await import(pathToFileURL(entry).href);
  const html = renderToStaticMarkup(React.createElement(mod.default));
  // `metadata` is a plain exported const on the module just imported. It is never rendered, so
  // it has to be read off the module — it cannot be scraped out of the markup.
  const meta = metaStrings(mod.metadata).join(' \u00b6 ');
  const out = {
    html, textSpaced: toText(html, ' '), textTight: toText(html, ''),
    metaSpaced: toText(meta, ' '), metaTight: toText(meta, ''), modules: count,
  };
  cache.set(relPath, out);
  return out;
}

/** The landing page. Unchanged in behaviour; see `renderPage`. */
export async function landingPage() {
  return renderPage(LANDING_ENTRY);
}
