// CLI shim for the M3-3 idle-capital check. Runs one pass and exits.
//
// Operator flow for end-to-end smoke:
//   1. Enable idle_capital for one treasury via /settings → Alerts.
//   2. Either (a) wait minDwellHours since the treasury's last deposit/
//      transfer/rebalance OR (b) backdate the most recent qualifying
//      action's executed_at to "long ago":
//        UPDATE proposed_actions
//        SET executed_at = NOW() - INTERVAL '5 days'
//        WHERE treasury_id = '<uuid>'
//          AND status = 'executed'
//          AND payload->>'kind' IN ('deposit', 'transfer', 'rebalance')
//        ORDER BY executed_at DESC LIMIT 1;
//      (Or skip backdating entirely if the treasury has zero outflows —
//      the job uses MAX(treasury.created_at, lastOutflowAt), and a
//      treasury older than minDwellHours qualifies on its own.)
//   3. Make sure the wallet's USDC balance ≥ minIdleUsdc (default $5k).
//      For dev: set a low minIdleUsdc in /settings → Alerts before
//      running, since real dev wallets rarely hold $5k.
//   4. pnpm --filter @tc/worker smoke:idle-capital
//   5. Expect Telegram message + a notifications row of kind=idle_capital.
//   6. Re-run: expect dedupe skip (48h cooldown by default).
//
// Cleanup:
//   DELETE FROM notifications WHERE kind = 'idle_capital';
//   (and re-set any backdated executed_at if you want)

import { bot } from '../bot';
import { checkIdleCapital } from '../jobs/check-idle-capital';

// Load-bearing import side effect: forces apps/worker/src/env.ts to parse
// the worker env at module load so the script fails fast on a missing
// TELEGRAM_BOT_TOKEN.
void bot;

async function main(): Promise<void> {
  console.log('[smoke:idle-capital] running one check pass…');
  await checkIdleCapital();
  console.log('[smoke:idle-capital] done.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[smoke:idle-capital] failed:', err);
    process.exit(1);
  });
