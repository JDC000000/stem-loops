const { withSentryConfig } = require('@sentry/nextjs');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transpile workspace packages
  transpilePackages: ['@stem-loops/types'],

  // Server actions enabled by default in Next 14
  experimental: {},

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
