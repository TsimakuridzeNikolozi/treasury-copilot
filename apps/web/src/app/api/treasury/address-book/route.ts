import { resolveActiveTreasury } from '@/lib/active-treasury';
import { db } from '@/lib/db';
import { addressBookEntryRowToDto } from '@/lib/dto/address-book';
import { verifyBearer } from '@/lib/privy';
import {
  insertAddressBookEntry,
  isAddressBookAddressConflict,
  isAddressBookLabelConflict,
  listAddressBookEntries,
} from '@tc/db';
import { z } from 'zod';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
// Per-user resolution via cookie isn't part of Next 15's URL-based cache key.
export const dynamic = 'force-dynamic';

// Same base58 regex shape as @tc/types SolanaAddressSchema. Re-declared
// here rather than imported because @tc/types is a heavy zod-export
// surface for a single regex, and the boundary contract is the regex
// itself (a divergence here would surface in tests). 32..44 chars covers
// every legal Solana base58 address.
export const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Label is a human pointer; 64 chars is generous for "Acme Corp - Q1
// payroll" style entries while preventing pathological lengths from
// blowing out the Telegram approval card formatting.
//
// Notes is free-form context for the approver. 500 chars caps it well
// below jsonb-bloat territory and any realistic chat-card snippet.
const labelSchema = z
  .string()
  .trim()
  .min(1, 'label is required')
  .max(64, 'label is at most 64 chars');
const notesSchema = z.string().trim().max(500, 'notes is at most 500 chars');

const CreateBody = z.object({
  // Body-vs-cookie 409 contract: client sends the treasuryId it intended
  // to write to; we reject if the active cookie has moved.
  treasuryId: z.string().uuid(),
  label: labelSchema,
  recipientAddress: z.string().regex(SOLANA_ADDRESS_REGEX, 'must be a base58 Solana address'),
  // Optional. null (from the form when empty) and empty strings both
  // collapse to undefined so the DB column stays at its default.
  notes: notesSchema
    .nullable()
    .optional()
    .transform((s) => (s && s.length > 0 ? s : undefined)),
  preApproved: z.boolean(),
});

function noActiveTreasury(setCookieHeader?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (setCookieHeader) headers['set-cookie'] = setCookieHeader;
  return new Response(JSON.stringify({ error: 'no_active_treasury' }), {
    status: 409,
    headers,
  });
}

// Wire shape + row→DTO helper now live in `@/lib/dto/address-book` so the
// type has a single source of truth (the [id] route, the settings page,
// and the client component all import it). This file consumes the
// helper directly; the previous in-file `toDto` alias was removed to
// keep the route a clean leaf consumer (not a utility module).

export async function GET(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const resolved = await resolveActiveTreasury(req, db, auth.userId);
  if ('onboardingRequired' in resolved) return noActiveTreasury(resolved.setCookieHeader);

  const rows = await listAddressBookEntries(db, resolved.treasury.id);
  const res = Response.json({ entries: rows.map(addressBookEntryRowToDto) });
  if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
  return res;
}

export async function POST(req: Request) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const resolved = await resolveActiveTreasury(req, db, auth.userId);
  if ('onboardingRequired' in resolved) return noActiveTreasury(resolved.setCookieHeader);

  // Owner-only. PR 2's role CHECK is currently 'owner' only, but the
  // runtime gate stays so PR-3+ role expansion doesn't need to revisit
  // each route.
  if (resolved.role !== 'owner') {
    return new Response('forbidden', { status: 403 });
  }

  if (parsed.data.treasuryId !== resolved.treasury.id) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (resolved.setCookieHeader) headers['set-cookie'] = resolved.setCookieHeader;
    return new Response(JSON.stringify({ error: 'active_treasury_changed' }), {
      status: 409,
      headers,
    });
  }

  try {
    const row = await insertAddressBookEntry(db, {
      treasuryId: resolved.treasury.id,
      label: parsed.data.label,
      recipientAddress: parsed.data.recipientAddress,
      ...(parsed.data.notes !== undefined && { notes: parsed.data.notes }),
      preApproved: parsed.data.preApproved,
      createdBy: auth.userId,
    });
    const res = Response.json(addressBookEntryRowToDto(row), { status: 201 });
    if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
    return res;
  } catch (e) {
    // Map the two unique-index violations to typed 409s so the form can
    // highlight the right field. Any other DB error bubbles to 500.
    if (isAddressBookLabelConflict(e)) {
      return Response.json({ error: 'duplicate_label', field: 'label' }, { status: 409 });
    }
    if (isAddressBookAddressConflict(e)) {
      return Response.json(
        { error: 'duplicate_address', field: 'recipientAddress' },
        { status: 409 },
      );
    }
    throw e;
  }
}
