import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  resolveActiveTreasury: vi.fn(),
  updateAddressBookEntry: vi.fn(),
  deleteAddressBookEntry: vi.fn(),
  isAddressBookLabelConflict: vi.fn(() => false),
}));

vi.mock('@/lib/privy', () => ({
  verifyBearer: mocks.verifyBearer,
  privy: {},
  PRIVY_COOKIE: 'privy-token',
}));

vi.mock('@/lib/active-treasury', () => ({
  resolveActiveTreasury: mocks.resolveActiveTreasury,
}));

vi.mock('@/lib/db', () => ({
  db: {},
}));

// `AddressBookEntryNotFound` is referenced as a value (route uses
// `instanceof`). Mock it with a real class so identity-based checks work.
class MockAddressBookEntryNotFound extends Error {
  constructor(public readonly id: string) {
    super(`address book entry ${id} not found`);
    this.name = 'AddressBookEntryNotFound';
  }
}

vi.mock('@tc/db', () => ({
  AddressBookEntryNotFound: MockAddressBookEntryNotFound,
  updateAddressBookEntry: mocks.updateAddressBookEntry,
  deleteAddressBookEntry: mocks.deleteAddressBookEntry,
  isAddressBookLabelConflict: mocks.isAddressBookLabelConflict,
}));

const { PATCH, DELETE } = await import('./route');

const TREASURY_ID = '00000000-0000-4000-8000-000000000aaa';
const OTHER_TREASURY_ID = '00000000-0000-4000-8000-00000000bbbb';
const ENTRY_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT = '9xQeWvG816bUx9EPa1xCkYJyXmcAfg7vRfBxbCw5N3rN';

const VALID_PATCH_BODY = {
  treasuryId: TREASURY_ID,
  label: 'Acme Corp v2',
  notes: 'updated',
  preApproved: true,
};

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ENTRY_ID,
    treasuryId: TREASURY_ID,
    label: 'Acme Corp v2',
    recipientAddress: RECIPIENT,
    tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    notes: 'updated',
    preApproved: true,
    createdBy: 'did:privy:x',
    createdAt: new Date('2026-01-15T12:00:00Z'),
    updatedAt: new Date('2026-01-15T12:05:00Z'),
    ...overrides,
  };
}

// Next 15's typed route handlers pass `params` as a Promise. Match the
// production signature so the cast in the route handler resolves.
function patchReq(
  id: string,
  body: unknown,
): { req: Request; ctx: { params: Promise<{ id: string }> } } {
  return {
    req: new Request(`http://localhost/api/treasury/address-book/${id}`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

function deleteReq(id: string): { req: Request; ctx: { params: Promise<{ id: string }> } } {
  return {
    req: new Request(`http://localhost/api/treasury/address-book/${id}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer tok' },
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

describe('PATCH /api/treasury/address-book/[id]', () => {
  it('401 on missing bearer', async () => {
    mocks.verifyBearer.mockResolvedValue(null);
    const { req, ctx } = patchReq(ENTRY_ID, VALID_PATCH_BODY);
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(401);
  });

  it('404 on non-uuid id', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const { req, ctx } = patchReq('not-a-uuid', VALID_PATCH_BODY);
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(404);
  });

  it('400 on missing treasuryId in body', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const { treasuryId: _drop, ...rest } = VALID_PATCH_BODY;
    const { req, ctx } = patchReq(ENTRY_ID, rest);
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(400);
  });

  it('400 on empty label', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const { req, ctx } = patchReq(ENTRY_ID, { ...VALID_PATCH_BODY, label: '' });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(400);
  });

  it('403 when role is not owner', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'approver',
    });
    const { req, ctx } = patchReq(ENTRY_ID, VALID_PATCH_BODY);
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(403);
  });

  it('409 active_treasury_changed when body treasuryId mismatches resolved', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: OTHER_TREASURY_ID },
      role: 'owner',
    });
    const { req, ctx } = patchReq(ENTRY_ID, VALID_PATCH_BODY);
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('active_treasury_changed');
  });

  it('404 when the entry id is unknown or belongs to a different treasury', async () => {
    // Cross-treasury guard runs at the DB layer (the (id, treasuryId)
    // WHERE clause inside the query refuses the mutation), which throws
    // AddressBookEntryNotFound — same surface as a deleted/missing row.
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    mocks.updateAddressBookEntry.mockRejectedValueOnce(new MockAddressBookEntryNotFound(ENTRY_ID));
    const { req, ctx } = patchReq(ENTRY_ID, VALID_PATCH_BODY);
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(404);
  });

  it('409 duplicate_label when the rename clashes with another entry', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    const dupErr = Object.assign(new Error('dup'), { code: '23505' });
    mocks.updateAddressBookEntry.mockRejectedValueOnce(dupErr);
    mocks.isAddressBookLabelConflict.mockReturnValueOnce(true);
    const { req, ctx } = patchReq(ENTRY_ID, VALID_PATCH_BODY);
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('duplicate_label');
    expect(body.field).toBe('label');
  });

  it('200 + DTO body on happy path; update called with resolved treasury + actor', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    mocks.updateAddressBookEntry.mockResolvedValueOnce(row());
    const { req, ctx } = patchReq(ENTRY_ID, VALID_PATCH_BODY);
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.label).toBe('Acme Corp v2');
    expect(body.preApproved).toBe(true);
    expect(mocks.updateAddressBookEntry).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        id: ENTRY_ID,
        treasuryId: TREASURY_ID,
        label: 'Acme Corp v2',
        notes: 'updated',
        preApproved: true,
        updatedBy: 'did:privy:x',
      }),
    );
  });
});

describe('DELETE /api/treasury/address-book/[id]', () => {
  it('401 on missing bearer', async () => {
    mocks.verifyBearer.mockResolvedValue(null);
    const { req, ctx } = deleteReq(ENTRY_ID);
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(401);
  });

  it('404 on non-uuid id', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const { req, ctx } = deleteReq('not-a-uuid');
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(404);
  });

  it('403 when role is not owner', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'approver',
    });
    const { req, ctx } = deleteReq(ENTRY_ID);
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(403);
  });

  it('404 when the entry id is unknown (or cross-treasury)', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    mocks.deleteAddressBookEntry.mockRejectedValueOnce(new MockAddressBookEntryNotFound(ENTRY_ID));
    const { req, ctx } = deleteReq(ENTRY_ID);
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(404);
  });

  it('204 on happy path; delete called with resolved treasury + actor', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    mocks.deleteAddressBookEntry.mockResolvedValueOnce(row());
    const { req, ctx } = deleteReq(ENTRY_ID);
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(204);
    expect(mocks.deleteAddressBookEntry).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        id: ENTRY_ID,
        treasuryId: TREASURY_ID,
        deletedBy: 'did:privy:x',
      }),
    );
  });
});
