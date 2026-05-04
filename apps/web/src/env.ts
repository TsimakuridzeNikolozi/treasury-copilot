import { createEnv } from '@t3-oss/env-nextjs';
import { databaseUrlSchema, logLevelSchema, publicAppUrlSchema, solanaRpcUrlSchema } from '@tc/env';

export const env = createEnv({
  server: {
    DATABASE_URL: databaseUrlSchema,
    SOLANA_RPC_URL: solanaRpcUrlSchema,
    LOG_LEVEL: logLevelSchema,
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
