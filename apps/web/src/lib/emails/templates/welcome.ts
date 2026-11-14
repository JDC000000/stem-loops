// Welcome email — V3-M1 (TSD §M).
// Trigger: first-time customer completing Checkout (mode=subscription), sent
// from the billing webhook. See V3-M-emails.md for why we don't send on auth
// signup in Phase 1a.

import { shell, type RenderedEmail } from './shared';

export interface WelcomeVars {
  // Nothing variable in the copy yet; keep the shape so future variants can
  // thread in e.g. a first name without a template churn.
  siteBase?: string;
}

export function renderWelcome(vars: WelcomeVars = {}): RenderedEmail {
  const base = (vars.siteBase ?? 'https://stem-loops.com').replace(/\/+$/, '');
  const subject = 'Welcome to stem-loops';
  const html = shell(
    `
      <h1 style="font-size:20px;margin:0 0 12px;">Welcome to stem-loops</h1>
      <p style="font-size:15px;line-height:1.5;margin:0 0 16px;">
        Thanks for subscribing. Upload a song and it opens in the player: six
        stems on faders, with a chord track to play along to.
      </p>
      <p style="font-size:15px;line-height:1.5;margin:0 0 20px;">
        Your plan and monthly allowance are on your account page. To start,
        upload a song on the stem-loops.com home page.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${base}/account"
           style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;margin-right:8px;">
          Go to your account
        </a>
        <a href="${base}/pricing"
           style="display:inline-block;background:#f0f0f0;color:#111;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;">
          See pricing
        </a>
      </p>
      <p style="font-size:14px;color:#555;line-height:1.5;margin:0;">
        Reply to this email if anything goes sideways &mdash; a human reads it.
      </p>
    `,
    'Welcome to stem-loops. Upload a song to open it in the player.',
  );
  return { subject, html };
}
