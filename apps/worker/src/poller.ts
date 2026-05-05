import { findPendingForTelegram, setTelegramMessageId } from '@tc/db';
import { postApprovalCard } from './bot';
import { db } from './db';
import { env } from './env';

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

// One scan: find pending actions that haven't been posted, post each, write
// back the resulting Telegram message id so the next tick skips them.
//
// `inFlight` prevents overlapping ticks if a post takes longer than the
// interval — without it a slow Telegram API would queue calls and we'd
// double-post on recovery.
async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const pending = await findPendingForTelegram(db);
    for (const row of pending) {
      try {
        const messageId = await postApprovalCard(row);
        await setTelegramMessageId(db, row.id, messageId);
      } catch (err) {
        // Per-action failure shouldn't kill the whole tick. The row stays
        // pending with no telegramMessageId, so it's eligible again next tick.
        // Risk: if postApprovalCard succeeded but setTelegramMessageId failed
        // (rare — single UPDATE with no joins), we'll repost on retry.
        // Acceptable for phase-1; revisit when load demands.
        console.error(`[poller] failed to post action ${row.id}:`, err);
      }
    }
  } catch (err) {
    console.error('[poller] tick failed:', err);
  } finally {
    inFlight = false;
  }
}

export function startActionPoller(): () => void {
  console.log(`[poller] starting (interval=${env.ACTION_POLL_INTERVAL_MS}ms)`);
  // Immediate tick so the first action doesn't wait one full interval.
  void tick();
  timer = setInterval(() => void tick(), env.ACTION_POLL_INTERVAL_MS);
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
