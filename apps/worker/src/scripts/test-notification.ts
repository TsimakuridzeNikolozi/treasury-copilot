// Smoke test for the M3-1 notification dispatcher. Backend-agnostic:
// works whether you're running local-mode (single seed treasury) or
// turnkey-mode (one row per Privy user).
//
// What it does:
//   1. Resolves a target treasury (see selection rules below).
//   2. Sends a test Telegram message via sendTelegramNotification.
//   3. Sends a second identical message immediately — expected to be
//      suppressed by dedupe.
//   4. Prints both results and exits.
//
// Treasury selection:
//   - Pass `--treasury <uuid>` to target an explicit row.
//   - Otherwise the script finds all treasuries with telegram_chat_id
//     configured. If exactly 1 → uses it. If 0 → error with instructions
//     to set chat id in /settings → Telegram. If >1 → error listing them
//     all so you can re-run with --treasury <uuid>.
//
// What it requires:
//   - apps/worker/.env populated (DATABASE_URL, TELEGRAM_BOT_TOKEN, etc.).
//   - At least one treasury in the DB with a Telegram chat id set
//     (configure via the web app's /settings → Telegram).
//
// Usage:
//   pnpm --filter @tc/worker smoke:notify
//   pnpm --filter @tc/worker smoke:notify -- --treasury <uuid>
//
// After running, verify the rows landed:
//   docker exec treasury-copilot-postgres psql -U copilot -d treasury \
//     -c "SELECT id, kind, status, dedupe_key, last_error, created_at \
//         FROM notifications ORDER BY created_at DESC LIMIT 5;"

import { type TreasuryRow, getTreasuryById, schema } from '@tc/db';
import { bot } from '../bot';
import { db } from '../db';
import { sendTelegramNotification } from '../notifications';

const DEDUPE_KEY = 'smoke_test:m3_pr_1';
const DEDUPE_WINDOW_MS = 60_000;

function parseTreasuryArg(): string | null {
  const idx = process.argv.indexOf('--treasury');
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  if (!value) {
    throw new Error('--treasury requires a UUID argument');
  }
  return value;
}

async function resolveTreasury(): Promise<TreasuryRow> {
  const explicit = parseTreasuryArg();
  if (explicit) {
    const row = await getTreasuryById(db, explicit);
    if (!row) throw new Error(`No treasury found with id=${explicit}`);
    return row;
  }

  // Treasuries table stays tiny (one row per Privy user in turnkey mode,
  // exactly one in local mode), so an in-memory filter is fine and keeps
  // the worker from needing a direct drizzle-orm dep.
  const all = await db.select().from(schema.treasuries);
  const candidates = all.filter((t) => t.telegramChatId !== null);

  if (candidates.length === 0) {
    throw new Error(
      'No treasuries have a telegram_chat_id configured. Open the web app, sign in, ' +
        'go to /settings → Telegram, set the chat id (and your approver Telegram user id), ' +
        'then re-run this script.',
    );
  }
  if (candidates.length > 1) {
    const listing = candidates
      .map((t) => `  - ${t.id}  (${t.signerBackend}, chat=${t.telegramChatId})`)
      .join('\n');
    throw new Error(
      `Found ${candidates.length} treasuries with Telegram configured. Pick one explicitly:\n${listing}\n\nRe-run with: pnpm --filter @tc/worker smoke:notify -- --treasury <uuid>`,
    );
  }
  // biome-ignore lint/style/noNonNullAssertion: length checked above
  return candidates[0]!;
}

async function main(): Promise<void> {
  const treasury = await resolveTreasury();
  console.log(`[smoke] target treasury:   ${treasury.id}`);
  console.log(`[smoke] signer_backend:    ${treasury.signerBackend}`);
  console.log(`[smoke] wallet:            ${treasury.walletAddress}`);
  console.log(`[smoke] telegram_chat_id:  ${treasury.telegramChatId ?? '(not configured)'}`);

  if (!treasury.telegramChatId) {
    console.log(
      '[smoke] No chat configured for this treasury. Both calls will return ' +
        'skipped/no_chat. Set chat id via /settings → Telegram first if you want a real message.',
    );
  }

  console.log('\n[smoke] call 1 — should send (or skip with no_chat)');
  const first = await sendTelegramNotification({
    treasuryId: treasury.id,
    kind: 'smoke_test',
    body: '<b>M3-1 smoke test</b>\nIf you see this, the notification dispatcher works end-to-end.',
    dedupeKey: DEDUPE_KEY,
    dedupeWindowMs: DEDUPE_WINDOW_MS,
  });
  console.log('[smoke] result:', first);

  console.log('\n[smoke] call 2 — should be skipped by dedupe (or no_chat again)');
  const second = await sendTelegramNotification({
    treasuryId: treasury.id,
    kind: 'smoke_test',
    body: 'This second message should be suppressed by the dedupe window.',
    dedupeKey: DEDUPE_KEY,
    dedupeWindowMs: DEDUPE_WINDOW_MS,
  });
  console.log('[smoke] result:', second);

  // Brief grace period so any pending gRPC/HTTP responses settle before we
  // hand control back to the bot teardown.
  await new Promise((r) => setTimeout(r, 250));
}

main()
  .then(async () => {
    // bot is imported at module load (the Bot instance opens nothing until
    // bot.start() is called), but grammy keeps a reference that prevents
    // clean exit. Explicit process.exit lets the script terminate without
    // a hanging socket pool from postgres-js.
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[smoke] failed:', err);
    process.exit(1);
  })
  .finally(() => {
    // Silence biome unused-import warning on `bot` while keeping the
    // import — its module-load side effect (env validation) is the point.
    void bot;
  });
