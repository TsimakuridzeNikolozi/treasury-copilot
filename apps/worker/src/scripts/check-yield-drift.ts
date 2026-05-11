// CLI shim for the M3-2 yield-drift check. Runs `checkYieldDrift` once
// against the current DB + RPC, then exits. Useful for:
//   - Reproducing an alert after seeding fake APY history.
//   - Smoke-testing the per-treasury fan-out without waiting 6h.
//
// Operator flow for end-to-end smoke:
//   1. Enable yield_drift for one treasury via /settings → Alerts.
//   2. Insert fake apy_snapshots rows showing Save above Kamino for 30h:
//      INSERT INTO apy_snapshots (venue, apy_decimal, captured_at)
//      SELECT 'save', 0.08, NOW() - (i || ' hours')::interval
//      FROM generate_series(0, 30) i;
//      (repeat with 'kamino', 0.05)
//   3. Make sure your treasury has a non-zero Kamino position.
//   4. pnpm --filter @tc/worker smoke:yield-drift
//   5. Expect Telegram message + a new notifications row of kind=yield_drift.
//   6. Re-run: expect dedupe skip (24h cooldown by default).
//
// Cleanup:
//   DELETE FROM apy_snapshots WHERE captured_at >= NOW() - INTERVAL '40 hours';
//   DELETE FROM notifications WHERE kind = 'yield_drift';

import { bot } from '../bot';
import { checkYieldDrift } from '../jobs/check-yield-drift';

// The `bot` import is the load-bearing side effect: it forces apps/worker/src/env.ts
// to parse the worker env so the script fails fast on a missing TELEGRAM_BOT_TOKEN
// instead of crashing partway through a check. The reference below pins the
// import past biome's unused-import sweep — putting it inside the promise chain's
// .finally would not work because process.exit() runs synchronously inside the
// .then/.catch handlers and the finally would never execute.
void bot;

async function main(): Promise<void> {
  console.log('[smoke:yield-drift] running one check pass…');
  await checkYieldDrift();
  console.log('[smoke:yield-drift] done.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[smoke:yield-drift] failed:', err);
    process.exit(1);
  });
