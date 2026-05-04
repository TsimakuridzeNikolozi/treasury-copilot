import { databaseUrlSchema, logLevelSchema, solanaRpcUrlSchema } from '@tc/env';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: databaseUrlSchema,
  SOLANA_RPC_URL: solanaRpcUrlSchema,
  LOG_LEVEL: logLevelSchema,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid worker env:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
