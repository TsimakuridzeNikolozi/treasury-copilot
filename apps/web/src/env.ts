import { createEnv } from '@t3-oss/env-nextjs';
import {
  anthropicApiKeySchema,
  anthropicModelSchema,
  databaseUrlSchema,
  logLevelSchema,
  modelProviderSchema,
  openaiApiKeySchema,
  openaiModelSchema,
  publicAppUrlSchema,
  solanaRpcUrlSchema,
} from '@tc/env';

export const env = createEnv({
  server: {
    DATABASE_URL: databaseUrlSchema,
    SOLANA_RPC_URL: solanaRpcUrlSchema,
    LOG_LEVEL: logLevelSchema,

    MODEL_PROVIDER: modelProviderSchema,
    ANTHROPIC_API_KEY: anthropicApiKeySchema,
    ANTHROPIC_MODEL: anthropicModelSchema,
    OPENAI_API_KEY: openaiApiKeySchema,
    OPENAI_MODEL: openaiModelSchema,
  },
  client: {
    NEXT_PUBLIC_APP_URL: publicAppUrlSchema,
  },
  experimental__runtimeEnv: {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },
  skipValidation: process.env.SKIP_ENV_VALIDATION === '1',
  emptyStringAsUndefined: true,
});
