import {
  databaseUrlSchema,
  logLevelSchema,
  signerSignTimeoutMsSchema,
  solanaRpcUrlSchema,
  turnkeyApiPrivateKeySchema,
  turnkeyApiPublicKeySchema,
  turnkeyBaseUrlSchema,
} from '@tc/env';
import { z } from 'zod';

// Fields shared by every backend variant. Kept as a plain object so we can
// `.merge` it into each discriminated-union member without repeating.
//
// PR 3 removed:
//   - SEED_TREASURY_ID (the executor's per-treasury guard is gone now that
//     the per-treasury signer factory ships).
//   - TELEGRAM_APPROVAL_CHAT_ID + APPROVER_TELEGRAM_IDS (per-treasury
//     routing is now driven by treasuries.telegram_chat_id +
//     telegram_approver_ids; the bot reads them per-call).
//   - TURNKEY_ORGANIZATION_ID + TURNKEY_SIGN_WITH (per-treasury values now
//     come from treasuries.turnkey_sub_org_id + wallet_address).
const baseEnv = z.object({
  DATABASE_URL: databaseUrlSchema,
  SOLANA_RPC_URL: solanaRpcUrlSchema,
  LOG_LEVEL: logLevelSchema,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),

  ACTION_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  EXECUTOR_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),

  // M3 PR 1 — hourly APY snapshot collector for the cross-treasury
  // apy_snapshots table. Downstream M3 jobs (yield drift, idle nudge,
  // weekly digest) read this series instead of fanning out live SDK
  // reads. ±5min jitter to avoid synchronized RPC bursts.
  APY_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  APY_SNAPSHOT_JITTER_MS: z.coerce.number().int().nonnegative().default(300_000),

  // M3 PR 2 — yield-drift check cadence. 6h base + 30min jitter is the
  // plan default: drift signals are slow-moving so anything faster just
  // burns RPC budget, and the cooldown window in the subscription config
  // (24h by default) prevents user-visible spam regardless.
  YIELD_DRIFT_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(21_600_000),
  YIELD_DRIFT_CHECK_JITTER_MS: z.coerce.number().int().nonnegative().default(1_800_000),

  // M3 PR 3 — idle-capital nudge cadence. Daily (24h) + 1h jitter per
  // plan. The dwell window (default 72h) is much wider than the check
  // cadence so the signal is stable across ticks.
  IDLE_CAPITAL_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),
  IDLE_CAPITAL_CHECK_JITTER_MS: z.coerce.number().int().nonnegative().default(3_600_000),

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
    // Parent Turnkey API creds. Per-treasury organizationId + signWith come
    // from the treasuries row at signer-build time (PR 3 onward).
    TURNKEY_API_PUBLIC_KEY: turnkeyApiPublicKeySchema,
    TURNKEY_API_PRIVATE_KEY: turnkeyApiPrivateKeySchema,
    TURNKEY_BASE_URL: turnkeyBaseUrlSchema,
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
