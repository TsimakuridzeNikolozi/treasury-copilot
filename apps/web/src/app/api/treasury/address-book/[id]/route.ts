import { resolveActiveTreasury } from '@/lib/active-treasury';
import { db } from '@/lib/db';
import { addressBookEntryRowToDto } from '@/lib/dto/address-book';
import { verifyBearer } from '@/lib/privy';
import {
  AddressBookEntryNotFound,
  deleteAddressBookEntry,
  isAddressBookLabelConflict,
  updateAddressBookEntry,
} from '@tc/db';
import { z } from 'zod';

// postgres-js needs Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const labelSchema = z
  .string()
  .trim()
  .min(1, 'label is required')
  .max(64, 'label is at most 64 chars');
const notesSchema = z.string().trim().max(500, 'notes is at most 500 chars');

// Only the three editable fields are accepted. `recipientAddress` is
// intentionally not in this schema — a new address is a new entry, not
// a rename (keeps the (treasury_id, recipient_address) uniqueness
// contract simple and avoids "this entry used to be X" history rot).
//
// `notes` accepts an empty string as "clear the field", normalising
// to null at the DB layer. `undefined` would also clear it via the
// Zod default below.
const UpdateBody = z.object({
  treasuryId: z.string().uuid(),
  label: labelSchema,
  notes: notesSchema
    .nullable()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
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

// Next 15's typed route handlers pass `params` as a Promise (matches the
// dynamic-segment async resolution that landed in 15.x). The handler
// awaits it before validating.
type Ctx = { params: Promise<{ id: string }> };

const idSchema = z.string().uuid();

export async function PATCH(req: Request, ctx: Ctx) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const { id: rawId } = await ctx.params;
  const idCheck = idSchema.safeParse(rawId);
  if (!idCheck.success) return new Response('not found', { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = UpdateBody.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const resolved = await resolveActiveTreasury(req, db, auth.userId);
  if ('onboardingRequired' in resolved) return noActiveTreasury(resolved.setCookieHeader);

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
    const row = await updateAddressBookEntry(db, {
      id: idCheck.data,
      treasuryId: resolved.treasury.id,
      label: parsed.data.label,
      notes: parsed.data.notes,
      preApproved: parsed.data.preApproved,
      updatedBy: auth.userId,
    });
    const res = Response.json(addressBookEntryRowToDto(row));
    if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
    return res;
  } catch (e) {
    if (e instanceof AddressBookEntryNotFound) {
      return new Response('not found', { status: 404 });
    }
    if (isAddressBookLabelConflict(e)) {
      // Renamed to clash with another entry's label.
      return Response.json({ error: 'duplicate_label', field: 'label' }, { status: 409 });
    }
    throw e;
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const { id: rawId } = await ctx.params;
  const idCheck = idSchema.safeParse(rawId);
  if (!idCheck.success) return new Response('not found', { status: 404 });

  const resolved = await resolveActiveTreasury(req, db, auth.userId);
  if ('onboardingRequired' in resolved) return noActiveTreasury(resolved.setCookieHeader);

  if (resolved.role !== 'owner') {
    return new Response('forbidden', { status: 403 });
  }

  // DELETE has no body — the 409 body-vs-cookie contract doesn't apply
  // here. The path-segment id is the only client-supplied identifier,
  // and it's scoped to the resolved treasury inside the query (the
  // (id, treasuryId) WHERE clause refuses cross-treasury deletes).

  try {
    await deleteAddressBookEntry(db, {
      id: idCheck.data,
      treasuryId: resolved.treasury.id,
      deletedBy: auth.userId,
    });
    const res = new Response(null, { status: 204 });
    if (resolved.setCookieHeader) res.headers.append('set-cookie', resolved.setCookieHeader);
    return res;
  } catch (e) {
    if (e instanceof AddressBookEntryNotFound) {
      return new Response('not found', { status: 404 });
    }
    throw e;
  }
}
