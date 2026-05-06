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

// AI provider — pick one at runtime. Per-provider keys/URLs are validated at
// runtime in modelFor(); making them all optional here keeps `t3-env` simple
// (encoding "the chosen provider's key is required" as a Zod refinement is
// awkward and the error surface is worse).
export const modelProviderSchema = z
  .enum(['anthropic', 'openai'])
  .default('anthropic')
  .describe('Active AI provider');

export const anthropicApiKeySchema = z.string().min(1).optional();
export const anthropicModelSchema = z.string().min(1).default('claude-sonnet-4-6');

export const openaiApiKeySchema = z.string().min(1).optional();
export const openaiModelSchema = z.string().min(1).default('gpt-5.4-mini');

// TODO(phase-1): add Privy/Turnkey/Telegram/Helius schemas as integrations land.
