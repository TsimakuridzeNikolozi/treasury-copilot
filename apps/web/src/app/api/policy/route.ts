import { resolveActiveTreasury } from '@/lib/active-treasury';
import { db } from '@/lib/db';
import { verifyBearer } from '@/lib/privy';
import { getPolicy, upsertPolicy } from '@tc/db';
import { DEFAULT_POLICY } from '@tc/policy';
import { z } from 'zod';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user resolution via cookie isn't part of the cache key.
export const dynamic = 'force-dynamic';

// Decimal-USDC string: positive number with optional fractional part, no
// scientific notation. Mirrors the regex used in @tc/types for action amounts.
const decimalUsdc = z.string().regex(/^\d+(\.\d+)?$/, 'must be a positive decimal USDC string');

// Only the venues with real deposit/withdraw builders are accepted here;
// drift/marginfi gate-keep at the policy engine until their builders land.
// Letting them through would let operators set themselves up for runtime
// crashes.
const venue = z.enum(['kamino', 'save', 'jupiter']);

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
    // Optional until the policy editor surfaces this field. When omitted,
    // the existing DB value is preserved via DEFAULT_POLICY fallback.
    maxSingleTransferUsdc: decimalUsdc.optional(),
    maxAutoApprovedUsdcPer24h: decimalUsdc,
    allowedVenues: z.array(venue).min(1, 'must allow at least one venue'),
    // M4 PR 2 — address-book safety gate. Optional for forward-compat
    // with older clients; the DB column is NOT NULL with TRUE default,
    // and an undefined here preserves the row's existing value via the
    // read-existing-then-merge path below.
    requireAddressBookForTransfers: z.boolean().optional(),
    // Body-vs-cookie 409 contract for PATCH: client sends the treasuryId
    // it intended to write to; we reject if the active cookie has moved.
    treasuryId: z.string().uuid(),
  })
  // Cross-field invariant: an action above maxSingleActionUsdc is *denied*
  // by the policy engine, so requireApproval can never sit above it — that
  // configuration would auto-deny everything. Catch it at the boundary so
  // operators don't lock themselves out via a UI slip.
  .refine((p) => !gtAsDecimal(p.requireApprovalAboveUsdc, p.maxSingleActionUsdc), {
    message: 'requireApprovalAboveUsdc must be ≤ maxSingleActionUsdc',
    path: ['requireApprovalAboveUsdc'],
  })
  // Same invariant for the transfer cap. When omitted from the body the
  // effective cap falls back to DEFAULT_POLICY — validate against that same
  // value so the check matches what the upsert will actually persist.
  .refine(
    (p) =>
      !gtAsDecimal(
        p.requireApprovalAboveUsdc,
        p.maxSingleTransferUsdc ?? DEFAULT_POLICY.maxSingleTransferUsdc,
      ),
    {
      message: 'requireApprovalAboveUsdc must be ≤ maxSingleTransferUsdc',
      path: ['requireApprovalAboveUsdc'],
    },
  );

// 409 / Set-Cookie helpers (mirror the chat route's responses).
function noActiveTreasury(setCookieHeader?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (setCookieHeader) headers['set-cookie'] = setCookieHeader;
  return new Response(JSON.stringify({ error: 'no_active_treasury' }), {
    status: 409,
    headers,
  });
}

export async function GET(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const resolved = await resolveActiveTreasury(req, db, auth.userId);
  if ('onboardingRequired' in resolved) return noActiveTreasury(resolved.setCookieHeader);

  const policy = await getPolicy(db, resolved.treasury.id);
  const res = Response.json(policy);
  if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
  return res;
}

export async function PATCH(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = PolicyPatch.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const resolved = await resolveActiveTreasury(req, db, auth.userId);
  if ('onboardingRequired' in resolved) return noActiveTreasury(resolved.setCookieHeader);

  // Owner-only check. PR 2's CHECK constraint allows only 'owner' anyway,
  // but the runtime gate is wired now so PR-3+ role expansion doesn't
  // need to revisit every route.
  if (resolved.role !== 'owner') {
    return new Response('forbidden', { status: 403 });
  }

  // Body-vs-cookie 409: stale tab wrote with an out-of-date treasuryId.
  if (parsed.data.treasuryId !== resolved.treasury.id) {
    return Response.json({ error: 'active_treasury_changed' }, { status: 409 });
  }

  // Read existing for fields the form may not have submitted so a
  // legacy client that doesn't know about requireAddressBookForTransfers
  // doesn't accidentally reset the row to its default.
  const existing = await getPolicy(db, resolved.treasury.id);

  await upsertPolicy(db, {
    treasuryId: resolved.treasury.id,
    policy: {
      requireApprovalAboveUsdc: parsed.data.requireApprovalAboveUsdc,
      maxSingleActionUsdc: parsed.data.maxSingleActionUsdc,
      // Falls back to the existing DB value when the body omits this field
      // (current policy editor has no UI for it). Callers that do supply it win.
      maxSingleTransferUsdc:
        parsed.data.maxSingleTransferUsdc ?? existing.maxSingleTransferUsdc,
      maxAutoApprovedUsdcPer24h: parsed.data.maxAutoApprovedUsdcPer24h,
      allowedVenues: parsed.data.allowedVenues,
      requireAddressBookForTransfers:
        parsed.data.requireAddressBookForTransfers ?? existing.requireAddressBookForTransfers,
    },
    updatedBy: auth.userId,
  });

  const res = new Response(null, { status: 204 });
  if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
  return res;
}
