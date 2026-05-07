import { z } from 'zod';

// Reusable server-only env schema fragments. Each app composes these in its own
// `env.ts` via `@t3-oss/env-nextjs` (web) or a direct `parse()` (worker).
// Never import this file from a client component.

export const databaseUrlSchema = z.string().url().describe('Postgres connection string');

export const solanaRpcUrlSchema = z
  .string()
  .url()
  .describe('Solana JSON-RPC endpoint (Helius/Triton/etc.)');

// Base58-encoded Solana pubkey (32-byte address, 32–44 chars in base58 with
// the "no 0/O/I/l" alphabet). Validated by regex here; runtime PublicKey
// construction at first use will catch the rare subtle case the regex misses.
export const solanaPubkeyBase58Schema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a base58-encoded Solana pubkey');

export const treasuryPubkeyBase58Schema = solanaPubkeyBase58Schema.describe(
  "Treasury wallet's base58 pubkey — used as the default address for read tools (positions, APYs).",
);

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
