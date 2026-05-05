import { databaseUrlSchema, logLevelSchema, solanaRpcUrlSchema } from '@tc/env';
import { z } from 'zod';

// Comma-separated list of Telegram user ids allowed to approve/deny.
// Stored as a string in env, parsed to a Set on boot in `bot.ts`.
const approverIdsSchema = z
  .string()
  .min(1, 'APPROVER_TELEGRAM_IDS must list at least one user id')
  .regex(/^\d+(,\d+)*$/, 'APPROVER_TELEGRAM_IDS must be comma-separated numeric ids');

const schema = z.object({
  DATABASE_URL: databaseUrlSchema,
  SOLANA_RPC_URL: solanaRpcUrlSchema,
  LOG_LEVEL: logLevelSchema,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_APPROVAL_CHAT_ID: z
    .string()
    .min(1, 'TELEGRAM_APPROVAL_CHAT_ID is required (chat where approval cards are posted)'),
  APPROVER_TELEGRAM_IDS: approverIdsSchema,

  ACTION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid worker env:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
