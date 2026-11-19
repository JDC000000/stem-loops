import type { MetadataRoute } from 'next';

// Cost control (vercel-supabase-cost-control recipe, KIDS FUN Aug-Sep 2026 incident):
// production had NO robots.txt at all (confirmed 404 on stem-loops.com on 2026-09-24).
// On KIDS FUN, an undeclared AI crawler (GPTBot) walked every URL combination of a
// public page within 4 hours of the domain going live and drove ~$200 of Vercel
// on-demand charges in one cycle before anyone noticed. Stem Loops has a much smaller
// public surface (no filter/search pages), but the fix is cheap and the failure mode
// is expensive, so we block it site-wide as a default rather than wait for a spike.
//
// This blocks the AI-training/crawling bots listed in the recipe's Day-0 checklist.
// It intentionally does NOT block Googlebot/Bingbot (organic search) or generic link
// previews.
//
// SL15 (Jon, 2026-10-31, "allow search bots"): OAI-SearchBot and PerplexityBot index
// the public landing page for AI search answers (they do not train models), so they are
// allowed on "/" but kept off the API and per-job pages (the cost-control reason for this
// file: no crawler walking dynamic routes). Training/fetch crawlers stay fully blocked.
// test/robots.test.mjs fails if a training crawler is allowed or a search bot is blocked.
//
// QA-55: /demo/<slug> is deliberately crawlable by everyone allowed on the site, search bots
// included, even though it is a dynamic player page: it is the public demo (signed out since
// #302), listed in sitemap.xml and llms.txt. Only the 3 catalog slugs resolve, an off-catalog slug
// is a 404 with no DB call, and catalog slugs read a 60 s cached list. test/sitemap.test.mjs pins it.
export const SEARCH_BOT_USER_AGENTS = ['OAI-SearchBot', 'PerplexityBot'];
export const BLOCKED_AI_USER_AGENTS = [
  'GPTBot',
  'ChatGPT-User',
  'ClaudeBot',
  'anthropic-ai',
  'CCBot',
  'Google-Extended',
  'Bytespider',
  'Amazonbot',
  'Applebot-Extended',
  'meta-externalagent',
];
export const SEARCH_BOT_DISALLOW = ['/api/', '/jobs/'];

export default function robots(): MetadataRoute.Robots {
  return {
    sitemap: 'https://stem-loops.com/sitemap.xml',
    rules: [
      { userAgent: '*', allow: '/' },
      ...SEARCH_BOT_USER_AGENTS.map((userAgent) => ({
        userAgent,
        allow: '/',
        disallow: SEARCH_BOT_DISALLOW,
      })),
      ...BLOCKED_AI_USER_AGENTS.map((userAgent) => ({ userAgent, disallow: '/' })),
    ],
  };
}
