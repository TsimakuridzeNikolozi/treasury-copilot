import { and, desc, eq, gte } from 'drizzle-orm';
import type { Db, DbOrTx } from '../client';
import { type NewNotificationRow, type NotificationRow, notifications } from '../schema';

export interface EnqueueNotificationInput {
  treasuryId: string;
  kind: string;
  payload?: Record<string, unknown>;
  channel?: 'telegram';
  dedupeKey?: string;
}

// Insert a `queued` row. The caller (worker's notification dispatcher) flips
// it to `sent` / `failed` / `skipped` after the channel call settles.
//
// `payload` is free-form; it carries the data the renderer needs to format
// the message body. Keep it small — this column is not a queue.
export async function enqueueNotification(
  db: DbOrTx,
  input: EnqueueNotificationInput,
): Promise<NotificationRow> {
  const insert: NewNotificationRow = {
    treasuryId: input.treasuryId,
    kind: input.kind,
    payload: input.payload ?? null,
    channel: input.channel ?? 'telegram',
    dedupeKey: input.dedupeKey ?? null,
  };
  const [row] = await db.insert(notifications).values(insert).returning();
  if (!row) throw new Error('enqueueNotification: insert returned no row');
  return row;
}

export interface MarkSentInput {
  id: string;
  telegramChatId?: string;
  telegramMessageId?: number;
}

// Compare-and-set: only flips `queued → sent`. Returning the row lets the
// caller assert the transition succeeded.
export async function markNotificationSent(
  db: DbOrTx,
  input: MarkSentInput,
): Promise<NotificationRow | null> {
  const [row] = await db
    .update(notifications)
    .set({
      status: 'sent',
      sentAt: new Date(),
      telegramChatId: input.telegramChatId ?? null,
      telegramMessageId: input.telegramMessageId ?? null,
    })
    .where(and(eq(notifications.id, input.id), eq(notifications.status, 'queued')))
    .returning();
  return row ?? null;
}

export interface MarkFailedInput {
  id: string;
  error: string;
}

export async function markNotificationFailed(
  db: DbOrTx,
  input: MarkFailedInput,
): Promise<NotificationRow | null> {
  const [row] = await db
    .update(notifications)
    .set({ status: 'failed', lastError: input.error })
    .where(and(eq(notifications.id, input.id), eq(notifications.status, 'queued')))
    .returning();
  return row ?? null;
}

export async function markNotificationSkipped(
  db: DbOrTx,
  id: string,
  reason: string,
): Promise<NotificationRow | null> {
  const [row] = await db
    .update(notifications)
    .set({ status: 'skipped', lastError: reason })
    .where(and(eq(notifications.id, id), eq(notifications.status, 'queued')))
    .returning();
  return row ?? null;
}

// Returns the most recent SUCCESSFULLY SENT notification for (treasury,
// dedupeKey) within the time window, or null. Used by the dispatcher to
// enforce per-kind cooldowns (e.g. yield_drift fires at most once per 24h
// per venue pair).
//
// Filters on status='sent' deliberately:
//   - `sent`     → real delivery; suppress re-sends within the window.
//   - `failed`   → transient delivery failure (e.g. Telegram 429); MUST NOT
//                  suppress — the next tick should retry.
//   - `skipped`  → bookkeeping (no_chat configured, or dedupe hit itself);
//                  MUST NOT suppress, otherwise the cooldown self-
//                  perpetuates. Without this filter, a dedupe hit at t=23h
//                  writes a `skipped` row that itself extends the window
//                  past t=24h+1h, and the cooldown never terminates.
//   - `queued`   → in-flight, hasn't completed yet; treat as "no recent
//                  delivery" since we don't know the outcome.
//
// Concurrency caveat: the dispatcher's check-then-write pattern
// (findRecentByDedupeKey + enqueueNotification) is non-atomic. Two
// concurrent calls with the same (treasury_id, dedupe_key) in the same
// process tick can both pass the check and both enqueue. In practice
// dedupeKeys are feature-scoped (kind:venue:wallet) so collisions are
// unlikely, and the inFlight guard in scheduled-jobs.ts serialises
// dispatches within a single job. Cross-job races (e.g. yield-drift and
// idle-capital firing simultaneously) are bounded by per-job cadence
// (≥6h). When N grows, replace with a partial unique index keyed on
// (treasury_id, dedupe_key) bucketed by `date_trunc('hour', created_at)`
// + ON CONFLICT DO NOTHING.
export async function findRecentByDedupeKey(
  db: Db,
  treasuryId: string,
  dedupeKey: string,
  withinMs: number,
): Promise<NotificationRow | null> {
  const since = new Date(Date.now() - withinMs);
  const [row] = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.treasuryId, treasuryId),
        eq(notifications.dedupeKey, dedupeKey),
        eq(notifications.status, 'sent'),
        gte(notifications.createdAt, since),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  return row ?? null;
}
