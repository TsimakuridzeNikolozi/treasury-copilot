import { resolveActiveTreasury } from '@/lib/active-treasury';
import { db } from '@/lib/db';
import { verifyBearer } from '@/lib/privy';
import { updateTelegramConfig } from '@tc/db';
import { z } from 'zod';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user resolution via cookie isn't part of the cache key.
export const dynamic = 'force-dynamic';

// Telegram chat id format. Numeric ids cover groups (negative) and 1:1 chats
// (positive). Public channels use @username — Telegram restricts those to
// 5-32 chars, must start with a letter, alphanumeric + underscore.
const chatIdSchema = z
  .string()
  .regex(
    /^(-?\d+|@[A-Za-z][A-Za-z0-9_]{4,31})$/,
    'must be a numeric Telegram chat id (e.g. -1001234567890) or @channel_username',
  );

// Telegram user ids are positive integers. Strings here for jsonb-friendly
// storage and to avoid JS number precision concerns at higher ranges.
const approverIdSchema = z
  .string()
  .regex(/^\d+$/, 'approver ids must be numeric Telegram user ids');

const TelegramConfigPatch = z.object({
  // Body-vs-cookie 409 contract: client sends the treasuryId it intended to
  // write to; we reject if the active cookie has moved (multi-tab safety).
  treasuryId: z.string().uuid(),
  telegramChatId: chatIdSchema.nullable(),
  // Cap of 50 prevents pathological bulk-paste; well above any realistic
  // approver list. The form trims/filters empty lines client-side.
  telegramApproverIds: z.array(approverIdSchema).max(50),
});

function noActiveTreasury(setCookieHeader?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (setCookieHeader) headers['set-cookie'] = setCookieHeader;
  return new Response(JSON.stringify({ error: 'no_active_treasury' }), {
    status: 409,
    headers,
  });
}

export async function PATCH(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = TelegramConfigPatch.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const resolved = await resolveActiveTreasury(req, db, auth.userId);
  if ('onboardingRequired' in resolved) return noActiveTreasury(resolved.setCookieHeader);

  // Owner-only. PR 2's role CHECK is currently 'owner' only, but the runtime
  // gate stays so PR-3+ role expansion doesn't need to revisit each route.
  if (resolved.role !== 'owner') {
    return new Response('forbidden', { status: 403 });
  }

  // Body-vs-cookie 409: stale tab wrote with an out-of-date treasuryId.
  if (parsed.data.treasuryId !== resolved.treasury.id) {
    return Response.json({ error: 'active_treasury_changed' }, { status: 409 });
  }

  // Atomic update + audit row (with before/after payload) is encapsulated in
  // updateTelegramConfig — see packages/db/src/queries/treasuries.ts. The
  // route stays a thin shim.
  await updateTelegramConfig(db, {
    treasuryId: resolved.treasury.id,
    chatId: parsed.data.telegramChatId,
    approverIds: parsed.data.telegramApproverIds,
    updatedBy: auth.userId,
  });

  const res = new Response(null, { status: 204 });
  if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
  return res;
}
