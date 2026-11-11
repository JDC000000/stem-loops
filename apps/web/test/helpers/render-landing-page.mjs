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
const ENTRY = join(SRC, 'app/(landing)/page.tsx');

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
function build(outDir) {
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
  return { entry: emit(ENTRY), count: emitted.size };
}

// React emits NBSP as a literal U+00A0 and, on this page, no entities at all — but decode the
// handful it can emit anyway, AFTER tags are gone so a decoded `<` is never read as a tag.
const decode = (s) => s
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;|&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const collapse = (s) => s.replace(/[\s   ]+/g, ' ').trim();
const toText = (html, joiner) => collapse(decode(
  html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, joiner),
));

let loaded;
/**
 * `{ html, textSpaced, textTight, modules }` for the landing page, rendered once per process.
 * `html` is the markup; the two texts are the normalisations described above.
 */
export async function landingPage() {
  if (loaded) return loaded;
  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const { entry, count } = build(mkdtempSync(join(cache, 'landing-page-')));

  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const Page = (await import(pathToFileURL(entry).href)).default;
  const html = renderToStaticMarkup(React.createElement(Page));
  loaded = { html, textSpaced: toText(html, ' '), textTight: toText(html, ''), modules: count };
  return loaded;
}
