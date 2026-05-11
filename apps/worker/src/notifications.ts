import {
  enqueueNotification,
  findRecentByDedupeKey,
  getTreasuryForRouting,
  markNotificationFailed,
  markNotificationSent,
  markNotificationSkipped,
} from '@tc/db';
import { sendPlainMessage } from './bot';
import { db } from './db';

export interface SendTelegramNotificationInput {
  treasuryId: string;
  kind: string;
  // HTML-formatted message body (matches approval-card style).
  body: string;
  payload?: Record<string, unknown>;
  // When set, suppress send if any notification with the same dedupeKey
  // exists for this treasury within `dedupeWindowMs`. The skip is itself
  // recorded as a `skipped` row so the cooldown contract is self-evident
  // in the notifications table.
  dedupeKey?: string;
  dedupeWindowMs?: number;
}

export type SendTelegramNotificationResult =
  | { status: 'sent'; notificationId: string; messageId: number; chatId: string }
  | { status: 'skipped'; reason: 'dedupe' | 'no_chat'; notificationId: string }
  | { status: 'failed'; reason: string; notificationId: string };

// End-to-end dispatcher: dedupe check → enqueue row → look up treasury chat
// → post to Telegram → mark sent/failed. Every outcome leaves exactly one
// notifications row behind, so the table doubles as an audit trail.
//
// Failure modes are deliberately swallowed (no throw) so a periodic job
// looping over treasuries doesn't abort the whole tick on one bad row. The
// caller logs the result if it cares.
export async function sendTelegramNotification(
  input: SendTelegramNotificationInput,
): Promise<SendTelegramNotificationResult> {
  // Dedupe check first, before any DB writes. Cheap index-only read.
  if (input.dedupeKey && input.dedupeWindowMs && input.dedupeWindowMs > 0) {
    const recent = await findRecentByDedupeKey(
      db,
      input.treasuryId,
      input.dedupeKey,
      input.dedupeWindowMs,
    );
    if (recent) {
      // Record the skipped attempt for visibility — operators investigating
      // "why didn't this fire" can see the cooldown match without diffing
      // logs.
      const row = await enqueueNotification(db, {
        treasuryId: input.treasuryId,
        kind: input.kind,
        ...(input.payload ? { payload: input.payload } : {}),
        ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
      });
      await markNotificationSkipped(db, row.id, `dedupe: ${recent.id}`);
      return { status: 'skipped', reason: 'dedupe', notificationId: row.id };
    }
  }

  // Enqueue first so a crash between send and persist still leaves a record.
  const row = await enqueueNotification(db, {
    treasuryId: input.treasuryId,
    kind: input.kind,
    ...(input.payload ? { payload: input.payload } : {}),
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
  });

  const cfg = await getTreasuryForRouting(db, input.treasuryId);
  const chatId = cfg?.telegramChatId ?? null;
  if (!chatId) {
    await markNotificationSkipped(db, row.id, 'no_chat');
    return { status: 'skipped', reason: 'no_chat', notificationId: row.id };
  }

  try {
    const posted = await sendPlainMessage(chatId, input.body);
    await markNotificationSent(db, {
      id: row.id,
      telegramChatId: posted.chatId,
      telegramMessageId: posted.messageId,
    });
    return {
      status: 'sent',
      notificationId: row.id,
      messageId: posted.messageId,
      chatId: posted.chatId,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await markNotificationFailed(db, { id: row.id, error: reason });
    return { status: 'failed', reason, notificationId: row.id };
  }
}
