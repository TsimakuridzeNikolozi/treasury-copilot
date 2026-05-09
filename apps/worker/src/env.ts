import {
  databaseUrlSchema,
  logLevelSchema,
  signerSignTimeoutMsSchema,
  solanaRpcUrlSchema,
  turnkeyApiPrivateKeySchema,
  turnkeyApiPublicKeySchema,
  turnkeyBaseUrlSchema,
  turnkeyOrganizationIdSchema,
  turnkeySignWithSchema,
} from '@tc/env';
import { z } from 'zod';

// Comma-separated list of Telegram user ids allowed to approve/deny.
// Stored as a string in env, parsed to a Set on boot in `bot.ts`.
const approverIdsSchema = z
  .string()
  .min(1, 'APPROVER_TELEGRAM_IDS must list at least one user id')
  .regex(/^\d+(,\d+)*$/, 'APPROVER_TELEGRAM_IDS must be comma-separated numeric ids');

// Fields shared by every backend variant. Kept as a plain object so we can
// `.merge` it into each discriminated-union member without repeating.
const baseEnv = z.object({
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
  EXECUTOR_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),

  SIGNER_COMMITMENT: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),
  SIGNER_CONFIRM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // Per-call signing timeout. Bounds the Turnkey API call separately from
  // `SIGNER_CONFIRM_TIMEOUT_MS` (post-broadcast confirmation only). Local
  // backend ignores it but having the field on every variant keeps the
  // executor's switch trivial.
  SIGNER_SIGN_TIMEOUT_MS: signerSignTimeoutMsSchema,
});

// Discriminated union on SIGNER_BACKEND so the per-backend required vars
// produce precise field-level errors ("TURNKEY_API_PRIVATE_KEY is required")
// instead of a generic refinement failure. The default of `local` keeps
// dev-machine boots zero-config.
const schema = z.discriminatedUnion('SIGNER_BACKEND', [
  baseEnv.extend({
    SIGNER_BACKEND: z.literal('local'),
    // Path to the treasury keypair file (Solana CLI format). Required only
    // for the local backend.
    SOLANA_KEYPAIR_PATH: z.string().min(1, 'SOLANA_KEYPAIR_PATH is required'),
  }),
  baseEnv.extend({
    SIGNER_BACKEND: z.literal('turnkey'),
    // Optional under turnkey — operators may keep their old keypair around
    // for emergency rollback to the local backend without re-editing env.
    SOLANA_KEYPAIR_PATH: z.string().optional(),
    TURNKEY_API_PUBLIC_KEY: turnkeyApiPublicKeySchema,
    TURNKEY_API_PRIVATE_KEY: turnkeyApiPrivateKeySchema,
    TURNKEY_ORGANIZATION_ID: turnkeyOrganizationIdSchema,
    TURNKEY_BASE_URL: turnkeyBaseUrlSchema,
    TURNKEY_SIGN_WITH: turnkeySignWithSchema,
  }),
]);

// Default to `local` when SIGNER_BACKEND is unset so existing dev clones keep
// booting without changes. The discriminated union itself can't carry the
// default, so we patch the env before parsing.
const rawEnv = { SIGNER_BACKEND: 'local', ...process.env };
const parsed = schema.safeParse(rawEnv);
if (!parsed.success) {
  console.error('Invalid worker env:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
