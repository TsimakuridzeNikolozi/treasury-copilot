import { createEnv } from '@t3-oss/env-nextjs';
import {
  anthropicApiKeySchema,
  anthropicModelSchema,
  databaseUrlSchema,
  logLevelSchema,
  modelProviderSchema,
  openaiApiKeySchema,
  openaiModelSchema,
  privyAppSecretSchema,
  publicAppUrlSchema,
  publicPrivyAppIdSchema,
  seedTreasuryIdSchema,
  signerBackendSchema,
  solanaRpcUrlSchema,
  treasuryPubkeyBase58Schema,
  turnkeyBaseUrlSchema,
  turnkeyParentApiPrivateKeySchema,
  turnkeyParentApiPublicKeySchema,
  turnkeyParentOrganizationIdSchema,
} from '@tc/env';
import { z } from 'zod';

export const env = createEnv({
  server: {
    DATABASE_URL: databaseUrlSchema,
    SOLANA_RPC_URL: solanaRpcUrlSchema,
    // M2 PR 1: still the canonical pivot for read tools (snapshot wallet
    // address). PR 2 swaps this for the active treasury's wallet_address;
    // PR 4 removes it entirely from web env.
    TREASURY_PUBKEY_BASE58: treasuryPubkeyBase58Schema,
    // M2 PR 2: only consumer is local-mode /api/me/bootstrap stage 3
    // (attaches new dev users to the seed treasury). chat/policy/settings
    // all read via getActiveTreasuryAndRole now. Removed from web env in
    // PR 4 once invitations cover the dev-onboarding shortcut.
    SEED_TREASURY_ID: seedTreasuryIdSchema,
    LOG_LEVEL: logLevelSchema,

    MODEL_PROVIDER: modelProviderSchema,
    ANTHROPIC_API_KEY: anthropicApiKeySchema,
    ANTHROPIC_MODEL: anthropicModelSchema,
    OPENAI_API_KEY: openaiApiKeySchema,
    OPENAI_MODEL: openaiModelSchema,

    PRIVY_APP_SECRET: privyAppSecretSchema,

    // Mirrors the worker's discriminator. Web doesn't sign anything itself;
    // it consults this only to branch /api/me/bootstrap stage 2 — turnkey
    // mode mints a sub-org via @tc/turnkey-admin, local mode skips and
    // attaches to the seed treasury instead. Defaults to `local` so a
    // fresh dev clone boots without Turnkey credentials.
    SIGNER_BACKEND: signerBackendSchema,

    // Parent-org admin credentials for @tc/turnkey-admin. Required when
    // SIGNER_BACKEND=turnkey (cross-field refinement below); optional when
    // local. Distinct from the runtime per-org TURNKEY_* keys the worker
    // uses today: those sign transactions for one wallet; these mint new
    // sub-orgs underneath the parent.
    TURNKEY_PARENT_ORG_ID: turnkeyParentOrganizationIdSchema.optional(),
    TURNKEY_PARENT_API_PUBLIC_KEY: turnkeyParentApiPublicKeySchema.optional(),
    TURNKEY_PARENT_API_PRIVATE_KEY: turnkeyParentApiPrivateKeySchema.optional(),
    TURNKEY_PARENT_BASE_URL: turnkeyBaseUrlSchema.optional(),
  },
  client: {
    NEXT_PUBLIC_APP_URL: publicAppUrlSchema,
    NEXT_PUBLIC_PRIVY_APP_ID: publicPrivyAppIdSchema,
  },
  experimental__runtimeEnv: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
  },
  // `skipValidation` is the documented escape hatch for build contexts that
  // can't supply env (e.g., baking a CI Docker image where secrets are
  // injected at runtime). Setting `SKIP_ENV_VALIDATION=1` bypasses the Zod
  // gate so `next build` doesn't fail at static collection. Never set this
  // for `next dev` or in deployed runtime — a missing var will then surface
  // as an opaque crash deep in a route handler instead of a clear startup
  // failure.
  skipValidation: process.env.SKIP_ENV_VALIDATION === '1',
  emptyStringAsUndefined: true,
});

// Cross-field refinement: when SIGNER_BACKEND=turnkey, all three
// TURNKEY_PARENT_* must be present. We can't express this inside
// createEnv's per-field schemas because they're independent — so we
// validate after construction and crash loudly at first read.
//
// Server-only: this file is imported by some client components (Privy
// provider etc.) and t3-env's Proxy throws "Attempted to access a
// server-side environment variable on the client" if we touch
// SIGNER_BACKEND from a browser bundle. Gate on `typeof window` so the
// refinement runs once per server process and is a no-op in the client
// bundle (the values aren't available there anyway).
//
// Also bypassed via SKIP_ENV_VALIDATION=1 (CI image bake).
if (typeof window === 'undefined' && process.env.SKIP_ENV_VALIDATION !== '1') {
  const turnkeyParentRefinement = z
    .object({
      SIGNER_BACKEND: signerBackendSchema,
      TURNKEY_PARENT_ORG_ID: z.string().optional(),
      TURNKEY_PARENT_API_PUBLIC_KEY: z.string().optional(),
      TURNKEY_PARENT_API_PRIVATE_KEY: z.string().optional(),
    })
    .refine(
      (e) =>
        e.SIGNER_BACKEND !== 'turnkey' ||
        Boolean(
          e.TURNKEY_PARENT_ORG_ID &&
            e.TURNKEY_PARENT_API_PUBLIC_KEY &&
            e.TURNKEY_PARENT_API_PRIVATE_KEY,
        ),
      {
        message:
          'TURNKEY_PARENT_ORG_ID, TURNKEY_PARENT_API_PUBLIC_KEY, and TURNKEY_PARENT_API_PRIVATE_KEY are required when SIGNER_BACKEND=turnkey',
      },
    );
  const parsed = turnkeyParentRefinement.safeParse({
    SIGNER_BACKEND: env.SIGNER_BACKEND,
    TURNKEY_PARENT_ORG_ID: env.TURNKEY_PARENT_ORG_ID,
    TURNKEY_PARENT_API_PUBLIC_KEY: env.TURNKEY_PARENT_API_PUBLIC_KEY,
    TURNKEY_PARENT_API_PRIVATE_KEY: env.TURNKEY_PARENT_API_PRIVATE_KEY,
  });
  if (!parsed.success) {
    throw new Error(`Invalid web env: ${parsed.error.errors.map((e) => e.message).join('; ')}`);
  }
}
