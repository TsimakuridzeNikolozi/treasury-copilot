import { db } from '@/lib/db';
import { verifyBearer } from '@/lib/privy';
import { getPolicy, upsertPolicy } from '@tc/db';
import { z } from 'zod';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';

// Decimal-USDC string: positive number with optional fractional part, no
// scientific notation. Mirrors the regex used in @tc/types for action amounts.
const decimalUsdc = z.string().regex(/^\d+(\.\d+)?$/, 'must be a positive decimal USDC string');

// M1 only allows kamino + save; drift/marginfi gate-keep at the policy
// engine until 2E builders land. Letting them through here would let
// operators set themselves up for runtime crashes.
const venue = z.enum(['kamino', 'save']);

// Decimal-USDC strings have arbitrary precision (numeric(20, 6) on the
// column). Number() parses fine for the magnitudes we accept (cap is well
// under 2^53) but compare via string-aware decimal in case someone sends
// scientific or very large values in the future.
function gtAsDecimal(a: string, b: string): boolean {
  return Number.parseFloat(a) > Number.parseFloat(b);
}

const PolicyPatch = z
  .object({
    requireApprovalAboveUsdc: decimalUsdc,
    maxSingleActionUsdc: decimalUsdc,
    maxAutoApprovedUsdcPer24h: decimalUsdc,
    allowedVenues: z.array(venue).min(1, 'must allow at least one venue'),
  })
  // Cross-field invariant: an action above maxSingleActionUsdc is *denied*
  // by the policy engine, so requireApproval can never sit above it — that
  // configuration would auto-deny everything. Catch it at the boundary so
  // operators don't lock themselves out via a UI slip.
  .refine((p) => !gtAsDecimal(p.requireApprovalAboveUsdc, p.maxSingleActionUsdc), {
    message: 'requireApprovalAboveUsdc must be ≤ maxSingleActionUsdc',
    path: ['requireApprovalAboveUsdc'],
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
