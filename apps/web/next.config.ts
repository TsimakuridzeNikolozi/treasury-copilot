import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  transpilePackages: [
    '@tc/agent-tools',
    '@tc/db',
    '@tc/env',
    '@tc/policy',
    '@tc/protocols',
    '@tc/types',
  ],
  experimental: {
    typedEnv: true,
  },
};

export default config;
