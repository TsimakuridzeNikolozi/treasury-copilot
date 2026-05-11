import { resolveActiveTreasury } from '@/lib/active-treasury';
import { db } from '@/lib/db';
import { verifyBearer } from '@/lib/privy';
import {
  type AlertKind,
  YIELD_DRIFT_DEFAULT_CONFIG,
  ensureSubscriptionsForTreasury,
  listSubscriptions,
  upsertSubscription,
} from '@tc/db';
import { z } from 'zod';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Per-kind config schemas. Mirrored client-side in the form so users see
// validation feedback before the round-trip. Server is still the source
// of truth — Zod parsing rejects junk regardless of UI bypass.
const yieldDriftConfigSchema = z.object({
  // 1bp..100% (=10000bp). Drift below 1bp is sub-noise; above 100% is
  // physically impossible and almost certainly a paste-error.
  minDriftBps: z.number().int().min(1).max(10_000),
  // $0..$1B/mo. Lower bound 0 is allowed (alert on any drift); upper
  // bound is a sanity ceiling.
  minOpportunityUsdcPerMonth: z.number().min(0).max(1_000_000_000),
  // 1h..168h (=1wk). Below 1h we don't have enough samples; above a week
  // the sustain window outruns the cooldown's usefulness.
  sustainHours: z.number().int().min(1).max(168),
  // 1h..168h. Same range as sustain. Plan default = 24h.
  cooldownHours: z.number().int().min(1).max(168),
});

// Discriminated union by kind so adding M3-3/M3-5/M5-1/M5-2 schemas is
// a single new variant + a new union member (no other code changes).
const AlertPatch = z.discriminatedUnion('kind', [
  z.object({
    treasuryId: z.string().uuid(),
    kind: z.literal('yield_drift'),
    enabled: z.boolean(),
    config: yieldDriftConfigSchema,
  }),
  // Other kinds are toggle-only in this PR — their config schemas land
  // with their respective worker jobs (M3-3 idle, M3-5 anomaly, M5-1
  // concentration, M5-2 protocol_health). Until then a user can still
  // enable/disable them with an empty config; the worker ignores them
  // until the corresponding job ships.
  z.object({
    treasuryId: z.string().uuid(),
    kind: z.enum(['idle_capital', 'anomaly', 'concentration', 'protocol_health']),
    enabled: z.boolean(),
    config: z.record(z.string(), z.unknown()).default({}),
  }),
]);

function noActiveTreasury(setCookieHeader?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (setCookieHeader) headers['set-cookie'] = setCookieHeader;
  return new Response(JSON.stringify({ error: 'no_active_treasury' }), {
    status: 409,
    headers,
  });
}

// Shape returned by `GET /api/alerts`. Intentionally duplicated as
// `AlertSubscriptionDto` in apps/web/src/components/alert-subscriptions-form.tsx
// — keeping the client component off the server-only @tc/db import keeps
// the RSC boundary clean. The two must stay structurally identical;
// changes here need a mirror edit in the form's `AlertSubscriptionDto`.
interface SubscriptionDto {
  kind: AlertKind;
  enabled: boolean;
  config: Record<string, unknown>;
  updatedAt: string | null;
  updatedBy: string | null;
}

// Bake the default config into the dto when a row is missing — clients
// shouldn't have to know which kinds are pre-seeded vs lazy-created.
// `ensureSubscriptionsForTreasury` runs first to seed the rows in the
// DB (idempotent), which is the cheaper path going forward; but we
// still defensively fill defaults here in case the seed call raced
// with a delete.
function defaultsFor(kind: AlertKind): Record<string, unknown> {
  if (kind === 'yield_drift') return { ...YIELD_DRIFT_DEFAULT_CONFIG };
  return {};
}

export async function GET(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const resolved = await resolveActiveTreasury(req, db, auth.userId);
  if ('onboardingRequired' in resolved) return noActiveTreasury(resolved.setCookieHeader);

  // Idempotent seed for treasuries that joined after the 0010 migration.
  // No-op for everyone else.
  await ensureSubscriptionsForTreasury(db, resolved.treasury.id);
  const rows = await listSubscriptions(db, resolved.treasury.id);

  const dto: SubscriptionDto[] = rows.map((r) => ({
    kind: r.kind as AlertKind,
    enabled: r.enabled,
    config:
      Object.keys((r.config ?? {}) as Record<string, unknown>).length > 0
        ? (r.config as Record<string, unknown>)
        : defaultsFor(r.kind as AlertKind),
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    updatedBy: r.updatedBy ?? null,
  }));

  const res = Response.json({ subscriptions: dto });
  if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
  return res;
}

export async function PATCH(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = AlertPatch.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const resolved = await resolveActiveTreasury(req, db, auth.userId);
  if ('onboardingRequired' in resolved) return noActiveTreasury(resolved.setCookieHeader);

  if (resolved.role !== 'owner') {
    return new Response('forbidden', { status: 403 });
  }

  if (parsed.data.treasuryId !== resolved.treasury.id) {
    return Response.json({ error: 'active_treasury_changed' }, { status: 409 });
  }

  await upsertSubscription(db, {
    treasuryId: resolved.treasury.id,
    kind: parsed.data.kind,
    enabled: parsed.data.enabled,
    config: parsed.data.config as Record<string, unknown>,
    updatedBy: auth.userId,
  });

  const res = new Response(null, { status: 204 });
  if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
  return res;
}
