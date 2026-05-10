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

// Signer backend selector. `local` reads a Solana CLI keypair off disk; only
// fit for dev. `turnkey` delegates signing to Turnkey's HSM-backed API. The
// worker env is shaped as a discriminated union on this so the per-backend
// required vars live in one schema with precise per-field error messages.
export const signerBackendSchema = z.enum(['local', 'turnkey']).default('local');

// Strip an optional `0x` prefix before validating hex — operators tend to copy
// keys directly out of the Turnkey console which sometimes preserves it.
const hex = (length: number, label: string) =>
  z
    .string()
    .transform((s) => s.replace(/^0x/, ''))
    .pipe(
      z
        .string()
        .regex(new RegExp(`^[0-9a-fA-F]{${length}}$`), `${label} must be ${length} hex chars`),
    );

// Turnkey's API uses P-256 ECDSA stamps. Public keys are 33-byte compressed
// (66 hex chars); private keys are 32-byte scalars (64 hex chars).
export const turnkeyApiPublicKeySchema = hex(66, 'TURNKEY_API_PUBLIC_KEY');
export const turnkeyApiPrivateKeySchema = hex(64, 'TURNKEY_API_PRIVATE_KEY');
export const turnkeyOrganizationIdSchema = z.string().uuid();
export const turnkeyBaseUrlSchema = z.string().url().default('https://api.turnkey.com');
// `signWith` accepts a wallet account address, private key address, or
// private key id — for our Solana flow it's the wallet account's base58
// address. We validate as a Solana pubkey (no other id format would pass).
export const turnkeySignWithSchema = solanaPubkeyBase58Schema.describe(
  'Turnkey wallet account address (base58 Solana pubkey) — passed as `signWith` on every sign request.',
);

// Per-call signing timeout. Bounds Turnkey API latency separately from the
// post-broadcast confirmation budget (`SIGNER_CONFIRM_TIMEOUT_MS`); without
// this, a stalled Turnkey API would pin an executor tick indefinitely. Local
// backend ignores it.
export const signerSignTimeoutMsSchema = z.coerce.number().int().positive().default(10_000);

// Privy app secret — server-only. Paired with the public app id (client) to
// instantiate `PrivyClient` in API routes / server pages and verify the
// Bearer JWT the chat client sends. Visible once on app creation in the
// Privy dashboard; rotating it requires re-issuing in dashboard.
export const privyAppSecretSchema = z.string().min(1).describe('Privy app secret');

// Parent-org Turnkey admin credentials. Used by @tc/turnkey-admin to mint
// per-user sub-orgs and Solana wallets at first sign-in. Server-only.
// Required at runtime when SIGNER_BACKEND=turnkey (web env validates that
// refinement); optional when local because dev clones never call Turnkey.
//
// The same hex schemas as the per-org turnkey* schemas (P-256 ECDSA) — see
// turnkeyApiPublicKeySchema for the full why. Re-exported under distinct
// names so the parent-vs-runtime distinction is visible at the call site.
export const turnkeyParentApiPublicKeySchema = turnkeyApiPublicKeySchema.describe(
  'Parent-org admin API public key (P-256). Used to mint sub-orgs.',
);
export const turnkeyParentApiPrivateKeySchema = turnkeyApiPrivateKeySchema.describe(
  'Parent-org admin API private key (P-256). Server-only.',
);
export const turnkeyParentOrganizationIdSchema = turnkeyOrganizationIdSchema.describe(
  'Parent organization UUID — sub-orgs are created underneath it.',
);
