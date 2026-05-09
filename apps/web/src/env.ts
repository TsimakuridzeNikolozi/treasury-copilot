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
  solanaRpcUrlSchema,
  treasuryPubkeyBase58Schema,
} from '@tc/env';

export const env = createEnv({
  server: {
    DATABASE_URL: databaseUrlSchema,
    SOLANA_RPC_URL: solanaRpcUrlSchema,
    TREASURY_PUBKEY_BASE58: treasuryPubkeyBase58Schema,
    LOG_LEVEL: logLevelSchema,

    MODEL_PROVIDER: modelProviderSchema,
    ANTHROPIC_API_KEY: anthropicApiKeySchema,
    ANTHROPIC_MODEL: anthropicModelSchema,
    OPENAI_API_KEY: openaiApiKeySchema,
    OPENAI_MODEL: openaiModelSchema,

    PRIVY_APP_SECRET: privyAppSecretSchema,
  },
  client: {
    NEXT_PUBLIC_APP_URL: publicAppUrlSchema,
    NEXT_PUBLIC_PRIVY_APP_ID: publicPrivyAppIdSchema,
  },
  experimental__runtimeEnv: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_PRIVY_APP_ID: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
  },
  skipValidation: process.env.SKIP_ENV_VALIDATION === '1',
  emptyStringAsUndefined: true,
});
