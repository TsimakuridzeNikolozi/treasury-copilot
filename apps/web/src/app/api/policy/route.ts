import { env } from '@/env';
import { verifyBearer } from '@/lib/privy';
import { createDb, getPolicy, upsertPolicy } from '@tc/db';
import { z } from 'zod';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';

const db = createDb(env.DATABASE_URL);

// Decimal-USDC string: positive number with optional fractional part, no
// scientific notation. Mirrors the regex used in @tc/types for action amounts.
const decimalUsdc = z.string().regex(/^\d+(\.\d+)?$/, 'must be a positive decimal USDC string');

// M1 only allows kamino + save; drift/marginfi gate-keep at the policy
// engine until 2E builders land. Letting them through here would let
// operators set themselves up for runtime crashes.
const venue = z.enum(['kamino', 'save']);

const PolicyPatch = z.object({
  requireApprovalAboveUsdc: decimalUsdc,
  maxSingleActionUsdc: decimalUsdc,
  maxAutoApprovedUsdcPer24h: decimalUsdc,
  allowedVenues: z.array(venue).min(1, 'must allow at least one venue'),
});

export async function GET(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });
  const policy = await getPolicy(db);
  return Response.json(policy);
}

export async function PATCH(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = PolicyPatch.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  await upsertPolicy(db, { policy: parsed.data, updatedBy: auth.userId });
  return new Response(null, { status: 204 });
}
