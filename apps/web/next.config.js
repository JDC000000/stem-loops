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

module.exports = nextConfig;
