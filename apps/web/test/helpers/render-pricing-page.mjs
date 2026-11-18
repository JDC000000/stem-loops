// Server-render the WHOLE /pricing page to static HTML with the REAL BillingButton.tsx
// (CreditPackCheckout, PackBuyButton, BillingButton) and the real form-styles.ts and
// pricing-copy.ts. Only the I/O edges are stubbed: the DB (catalog rows), the session
// (getUser) and the hCaptcha widget (browser-only; it is not rendered until a pack is picked).
//
// Why a real render: test/pricing-credit-packs.test.mjs stubs BillingButton to read props,
// which proves what the page ASKS for (primary / variant) but not what the component PAINTS.
// A lime fill is an inline style inside BillingButton.tsx, so the brand gate (one lime
// primary per view, A5) has to read the rendered markup to see it.
//
// renderToStaticMarkup runs no effects and no handlers, so nothing here can reach a fetch,
// a checkout route or Stripe.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(WEB, p), 'utf8');
const toJs = (src, jsx = false) =>
  ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
      ...(jsx ? { jsx: ts.JsxEmit.ReactJSX } : {}),
    },
  }).outputText;

let built;
async function build() {
  if (built) return built;
  const cache = join(WEB, 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, 'pricing-page-'));
  const put = (name, code) => { writeFileSync(join(dir, name), code); return './' + name; };

  const formStyles = put('form-styles.mjs', toJs(read('src/lib/ui/form-styles.ts')));
  const pricingCopy = put('pricing-copy.mjs', toJs(read('src/lib/pricing-copy.ts')));
  const hcaptcha = put('hcaptcha.mjs', 'export default function HCaptcha() { return null; }');
  const db = put('db.mjs', `
    export const db = {
      query: async (text) => {
        const cfg = globalThis.__pricingRender;
        if (/public\\.plans/.test(text)) return { rows: cfg.plans };
        if (/public\\.credit_packs/.test(text)) return { rows: cfg.packs };
        return { rows: [] };
      },
    };`);
  const auth = put('auth.mjs', 'export const getUser = async () => globalThis.__pricingRender.user;');

  const billing = put('BillingButton.mjs', toJs(read('src/components/BillingButton.tsx'), true)
    .replace(/from ['"]@hcaptcha\/react-hcaptcha['"]/g, `from '${hcaptcha}'`)
    .replace(/from ['"]@\/lib\/ui\/form-styles['"]/g, `from '${formStyles}'`));
  const page = put('page.mjs', toJs(read('src/app/pricing/page.tsx'), true)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${db}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${auth}'`)
    .replace(/from ['"]@\/components\/BillingButton['"]/g, `from '${billing}'`)
    .replace(/from ['"]@\/lib\/pricing-copy['"]/g, `from '${pricingCopy}'`));

  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const Page = (await import(pathToFileURL(join(dir, 'page.mjs')).href)).default;
  const Billing = await import(pathToFileURL(join(dir, 'BillingButton.mjs')).href);
  built = { React, renderToStaticMarkup, Page, Billing };
  return built;
}

/** Render /pricing for `user` (null = signed out) against the given catalog rows. */
export async function renderPricingPage({ user, plans, packs }) {
  const { renderToStaticMarkup, Page } = await build();
  globalThis.__pricingRender = { user, plans, packs };
  // The page is an async server component: resolve it, then render the client tree it returns.
  return renderToStaticMarkup(await Page());
}

/** The real BillingButton module exports, plus React and the renderer, for component tests. */
export async function loadBillingButton() {
  const { React, renderToStaticMarkup, Billing } = await build();
  return { React, renderToStaticMarkup, ...Billing };
}

/**
 * Every element on the page whose fill is lime, as "<tag> <text>". Two ways a fill is lime:
 * the .jp-primary class (stem-color.css, the shared primary), or an inline background that
 * reads the primary/accent token (BillingButton's primary style).
 */
export function limeFills(html) {
  const out = [];
  for (const m of html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const [, tag, attrs, inner] = m;
    const cls = attrs.match(/class="([^"]*)"/)?.[1] ?? '';
    const style = attrs.match(/style="([^"]*)"/)?.[1] ?? '';
    const lime = /\bjp-primary\b/.test(cls)
      || /background(?:-color)?:\s*var\(--(?:btn-primary-bg|accent)\b/.test(style)
      || /#a3e635/i.test(style);
    if (lime) out.push(`${tag} ${inner.replace(/<[^>]*>/g, '').trim()}`);
  }
  return out;
}
