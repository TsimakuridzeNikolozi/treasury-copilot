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
  // Keep heavy Node-only libs out of the Next bundle. Bundling
  // @solana/web3.js polyfills `fetch` with a node-fetch v2 shim whose response
  // streams don't implement WebStream's `pipeThrough` — that breaks the
  // Anthropic AI SDK's streaming response handling. The Solana protocol SDKs
  // ride along (they ship CJS + heavy deps that don't gain from bundling).
  serverExternalPackages: [
    '@solana/web3.js',
    '@kamino-finance/klend-sdk',
    '@solendprotocol/solend-sdk',
    '@solendprotocol/token2022-wrapper-sdk',
    'qrcode-svg',
  ],
  webpack(config) {
    // @farcaster/mini-app-solana is an optional peer dep of @privy-io/react-auth
    // that isn't installed — stub it out so webpack doesn't fail on the import.
    config.resolve.alias['@farcaster/mini-app-solana'] = false;
    return config;
  },
  experimental: {
    typedEnv: true,
  },
};

export default config;
