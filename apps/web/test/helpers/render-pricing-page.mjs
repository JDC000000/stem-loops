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
  // B-8w "P": the REAL switch; it reads process.env.BILLING_CHECKOUT_ENABLED per render.
  const checkoutSwitch = put('checkout-switch.mjs', toJs(read('src/lib/billing/checkout-switch.ts')));
  const hcaptcha = put('hcaptcha.mjs', 'export default function HCaptcha() { return null; }');
  // The DB stub also answers lib/billing/pricing-plan-state.ts's read (R2-2) from
  // `subs` (subscriptions rows: { provider, status }) and `entPlan` (entitlements.plan_code,
  // null = no row), honouring the query's own parameters ($2 provider, $3 live statuses).
  const db = put('db.mjs', `
    export const db = {
      query: async (text, params = []) => {
        const cfg = globalThis.__pricingRender;
        if (/public\\.plans/.test(text)) return { rows: cfg.plans };
        if (/public\\.credit_packs/.test(text)) return { rows: cfg.packs };
        if (/FROM subscriptions/.test(text)) {
          if (cfg.subsThrow) throw new Error('subscriptions down');
          const [, provider, statuses] = params;
          // Each EXISTS is evaluated by its own WHERE clause: a clause that drops
          // "provider = $2" really does count another provider's rows.
          const clauses = {};
          for (const m of text.matchAll(/FROM subscriptions\\s+WHERE ([\\s\\S]*?)\\)\\s+AS (\\w+)/g)) clauses[m[2]] = m[1];
          const where = (alias) => clauses[alias] ?? '';
          const rows = (alias) => (cfg.subs ?? []).filter((r) => !/provider = \\$2/.test(where(alias)) || r.provider === provider);
          return { rows: [{
            live: rows('live').some((r) => !/status = ANY\\(\\$3/.test(where('live')) || statuses.includes(r.status)),
            any_sub: rows('any_sub').length > 0,
            paid_row: cfg.entPlan != null && cfg.entPlan !== 'free',
          }] };
        }
        return { rows: [] };
      },
    };`);
  const auth = put('auth.mjs', 'export const getUser = async () => globalThis.__pricingRender.user;');
  // QA A-10: the viewer's plan (the entitlement snapshot's plan_code), 'free' unless a test says otherwise.
  // plan: null makes the read FAIL (the page must still render, with no "Start free").
  const ents = put('entitlements.mjs', 'export const getEntitlementSnapshot = async () => { const p = globalThis.__pricingRender.plan; if (p === null) throw new Error("entitlements down"); return { plan_code: p ?? "free" }; };');

  const portal = put('portal-eligibility.mjs', toJs(read('src/lib/billing/portal-eligibility.ts'))
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${db}'`));
  const planState = put('pricing-plan-state.mjs', toJs(read('src/lib/billing/pricing-plan-state.ts'))
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${db}'`)
    .replace(/from ['"]@\/lib\/billing\/portal-eligibility['"]/g, `from '${portal}'`));

  const billing = put('BillingButton.mjs', toJs(read('src/components/BillingButton.tsx'), true)
    .replace(/from ['"]@hcaptcha\/react-hcaptcha['"]/g, `from '${hcaptcha}'`)
    .replace(/from ['"]@\/lib\/ui\/form-styles['"]/g, `from '${formStyles}'`));
  const page = put('page.mjs', toJs(read('src/app/pricing/page.tsx'), true)
    .replace(/from ['"]@\/lib\/db['"]/g, `from '${db}'`)
    .replace(/from ['"]@\/lib\/auth\/supabase['"]/g, `from '${auth}'`)
    .replace(/from ['"]@\/lib\/billing\/entitlements['"]/g, `from '${ents}'`)
    .replace(/from ['"]@\/lib\/billing\/pricing-plan-state['"]/g, `from '${planState}'`)
    .replace(/from ['"]@\/components\/BillingButton['"]/g, `from '${billing}'`)
    .replace(/from ['"]@\/lib\/billing\/checkout-switch['"]/g, `from '${checkoutSwitch}'`)
    .replace(/from ['"]@\/lib\/pricing-copy['"]/g, `from '${pricingCopy}'`));

  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const Page = (await import(pathToFileURL(join(dir, 'page.mjs')).href)).default;
  const Billing = await import(pathToFileURL(join(dir, 'BillingButton.mjs')).href);
  built = { React, renderToStaticMarkup, Page, Billing };
  return built;
}

/** Render /pricing for `user` (null = signed out) against the given catalog rows. */
export async function renderPricingPage({ user, plans, packs, plan = 'free', subs = [], entPlan = null, subsThrow = false }) {
  const { renderToStaticMarkup, Page } = await build();
  globalThis.__pricingRender = { user, plans, packs, plan, subs, entPlan, subsThrow };
  // The page is an async server component: resolve it, then render the client tree it returns.
  return renderToStaticMarkup(await Page());
}

/** The page's React element tree, unrendered: client components (BillingButton,
 *  PackBuyButton) appear as elements with the props the page passed them. */
export async function pricingPageTree({ user, plans, packs, plan = 'free', subs = [], entPlan = null, subsThrow = false }) {
  const { Page } = await build();
  globalThis.__pricingRender = { user, plans, packs, plan, subs, entPlan, subsThrow };
  return Page();
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
