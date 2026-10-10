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
// previews. Revisit if a real integration needs one of these bots allowed.
const AI_CRAWLER_USER_AGENTS = [
  'GPTBot',
  'ChatGPT-User',
  'OAI-SearchBot',
  'ClaudeBot',
  'anthropic-ai',
  'CCBot',
  'PerplexityBot',
  'Google-Extended',
  'Bytespider',
  'Amazonbot',
  'Applebot-Extended',
  'meta-externalagent',
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/' },
      ...AI_CRAWLER_USER_AGENTS.map((userAgent) => ({ userAgent, disallow: '/' })),
    ],
  };
}
