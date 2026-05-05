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
        const stamped = await setTelegramMessageId(db, row.id, messageId);
        if (!stamped) {
          console.warn(
            `[poller] action ${row.id} already had a telegramMessageId; possible duplicate post`,
          );
        }
      } catch (err) {
        // Per-action failure shouldn't kill the whole tick. The row stays
        // pending with no telegramMessageId, so it's eligible again next tick.
        //
        // TODO(phase-2): post → write race can produce duplicate cards.
        // If postApprovalCard() succeeds but setTelegramMessageId() fails
        // (network blip, DB hiccup), the row stays pending with no message id
        // and we'll repost on the next tick. The compare-and-set guard in
        // setTelegramMessageId only protects against double-stamping the id —
        // it doesn't prevent the duplicate Telegram message itself.
        //
        // Proper fix: reserve a send slot before posting (atomic UPDATE that
        // sets a `telegram_send_pending_at` sentinel and excludes such rows
        // from findPendingForTelegram), or move to an outbox table with a
        // dedupe key derived from row.id. Both require a schema migration in
        // packages/db, so deferred until load makes the race observable.
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
  if (timer) {
    console.log('[poller] already running, ignoring duplicate start');
    return () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }
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
