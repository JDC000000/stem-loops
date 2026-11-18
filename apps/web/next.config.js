const { withSentryConfig } = require('@sentry/nextjs');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transpile workspace packages
  transpilePackages: ['@stem-loops/types'],

  // Server actions enabled by default in Next 14
  experimental: {},

  // QA track B, B-02: the app renders no next/image (history/page.tsx uses <img> on
  // purpose), yet /_next/image answered 200 on prod, and Next 14.2.x carries image-
  // optimizer advisories (GHSA-2xp9-vwfh-vxw4, GHSA-2464-fhr4-w9xw; fixed only in 15.x).
  // `unoptimized` turns the optimizer endpoint off (`next start` answers 404). Pinned by
  // test/next-config.test.mjs. This is the ONLY Next config file: Next loads
  // next.config.js before next.config.mjs, so a second file is dead code that looks live.
  images: { unoptimized: true },

  // Environment variables available server-side only (never expose to browser)
  env: {},

  // Public env vars (safe to expose)
  // NEXT_PUBLIC_* vars go here if needed
};

// withSentryConfig is safe to apply unconditionally — it only uploads source maps
// (via sentry-cli) when SENTRY_AUTH_TOKEN is present at build time, and silently
// skips that step otherwise. Doesn't require the DSN itself to be set.
module.exports = withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Don't fail the build if source-map upload isn't configured yet.
  disableLogger: true,
  automaticVercelMonitors: false,
});
