import { z } from 'zod';

// Reusable server-only env schema fragments. Each app composes these in its own
// `env.ts` via `@t3-oss/env-nextjs` (web) or a direct `parse()` (worker).
// Never import this file from a client component.

export const databaseUrlSchema = z.string().url().describe('Postgres connection string');

export const solanaRpcUrlSchema = z
  .string()
  .url()
  .describe('Solana JSON-RPC endpoint (Helius/Triton/etc.)');

export const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');

export const logLevelSchema = z
  .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  .default('info');

// TODO(phase-1): add Privy/Turnkey/Telegram/Helius schemas as integrations land.
