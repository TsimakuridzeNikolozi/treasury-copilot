import { SolanaAddressSchema } from '@tc/types';
import { describe, expect, it, vi } from 'vitest';

// Hoisted mocks so vi.mock factories can reference them safely.
const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  resolveActiveTreasury: vi.fn(),
  insertAddressBookEntry: vi.fn(),
  listAddressBookEntries: vi.fn(),
  isAddressBookLabelConflict: vi.fn(() => false),
  isAddressBookAddressConflict: vi.fn(() => false),
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

vi.mock('@tc/db', () => ({
  insertAddressBookEntry: mocks.insertAddressBookEntry,
  listAddressBookEntries: mocks.listAddressBookEntries,
  isAddressBookLabelConflict: mocks.isAddressBookLabelConflict,
  isAddressBookAddressConflict: mocks.isAddressBookAddressConflict,
}));

const { GET, POST, SOLANA_ADDRESS_REGEX } = await import('./route');

const TREASURY_ID = '00000000-0000-4000-8000-000000000aaa';
const OTHER_TREASURY_ID = '00000000-0000-4000-8000-00000000bbbb';
const RECIPIENT = '9xQeWvG816bUx9EPa1xCkYJyXmcAfg7vRfBxbCw5N3rN';

const VALID_POST_BODY = {
  treasuryId: TREASURY_ID,
  label: 'Acme Corp',
  recipientAddress: RECIPIENT,
  preApproved: false,
};

// Minimal AddressBookEntryRow stand-in (the route only consumes the
// fields it forwards to the DTO).
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    treasuryId: TREASURY_ID,
    label: 'Acme Corp',
    recipientAddress: RECIPIENT,
    tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    notes: null,
    preApproved: false,
    createdBy: 'did:privy:x',
    createdAt: new Date('2026-01-15T12:00:00Z'),
    updatedAt: new Date('2026-01-15T12:00:00Z'),
    ...overrides,
  };
}

function getReq(): Request {
  return new Request('http://localhost/api/treasury/address-book', {
    method: 'GET',
    headers: { authorization: 'Bearer tok' },
  });
}

function postReq(body: unknown): Request {
  return new Request('http://localhost/api/treasury/address-book', {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

it('SOLANA_ADDRESS_REGEX matches the source regex in SolanaAddressSchema (@tc/types)', () => {
  const typesCheck = SolanaAddressSchema._def.checks.find(
    (c): c is { kind: 'regex'; regex: RegExp; message: string } => c.kind === 'regex',
  );
  expect(typesCheck).toBeDefined();
  expect(SOLANA_ADDRESS_REGEX.source).toBe(typesCheck?.regex.source);
  expect(SOLANA_ADDRESS_REGEX.flags).toBe(typesCheck?.regex.flags ?? '');
});

describe('GET /api/treasury/address-book', () => {
  it('401 on missing bearer', async () => {
    mocks.verifyBearer.mockResolvedValue(null);
    const res = await GET(getReq());
    expect(res.status).toBe(401);
  });

  it('409 no_active_treasury when resolver reports onboarding required', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({ onboardingRequired: true });
    const res = await GET(getReq());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('no_active_treasury');
  });

  it('200 + entries DTO array on happy path', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    mocks.listAddressBookEntries.mockResolvedValue([row()]);
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      label: 'Acme Corp',
      recipientAddress: RECIPIENT,
      preApproved: false,
    });
    // ISO timestamps round-trip through Response.json — assert shape.
    expect(typeof body.entries[0].createdAt).toBe('string');
    expect(typeof body.entries[0].updatedAt).toBe('string');
  });
});

describe('POST /api/treasury/address-book', () => {
  it('401 on missing bearer', async () => {
    mocks.verifyBearer.mockResolvedValue(null);
    const res = await POST(postReq(VALID_POST_BODY));
    expect(res.status).toBe(401);
  });

  it('400 on missing treasuryId', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const { treasuryId: _drop, ...rest } = VALID_POST_BODY;
    const res = await POST(postReq(rest));
    expect(res.status).toBe(400);
  });

  it('400 on empty label', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const res = await POST(postReq({ ...VALID_POST_BODY, label: '' }));
    expect(res.status).toBe(400);
  });

  it('400 on label > 64 chars', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const res = await POST(postReq({ ...VALID_POST_BODY, label: 'x'.repeat(65) }));
    expect(res.status).toBe(400);
  });

  it('400 on non-base58 recipient address', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const res = await POST(postReq({ ...VALID_POST_BODY, recipientAddress: 'not a base58' }));
    expect(res.status).toBe(400);
  });

  it('400 on notes > 500 chars', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const res = await POST(postReq({ ...VALID_POST_BODY, notes: 'x'.repeat(501) }));
    expect(res.status).toBe(400);
  });

  it('403 when role is not owner', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      // M2 CHECK is 'owner' only today, but the runtime gate is wired
      // so this test stays meaningful as M3 expands roles.
      role: 'approver',
    });
    const res = await POST(postReq(VALID_POST_BODY));
    expect(res.status).toBe(403);
  });

  it('409 active_treasury_changed when body treasuryId mismatches resolved', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: OTHER_TREASURY_ID },
      role: 'owner',
    });
    const res = await POST(postReq(VALID_POST_BODY));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('active_treasury_changed');
  });

  it('409 duplicate_label when the DB raises a label unique violation', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    const dupErr = Object.assign(new Error('dup'), { code: '23505' });
    mocks.insertAddressBookEntry.mockRejectedValueOnce(dupErr);
    mocks.isAddressBookLabelConflict.mockReturnValueOnce(true);
    const res = await POST(postReq(VALID_POST_BODY));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('duplicate_label');
    expect(body.field).toBe('label');
  });

  it('409 duplicate_address when the DB raises an address unique violation', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    const dupErr = Object.assign(new Error('dup'), { code: '23505' });
    mocks.insertAddressBookEntry.mockRejectedValueOnce(dupErr);
    mocks.isAddressBookLabelConflict.mockReturnValueOnce(false);
    mocks.isAddressBookAddressConflict.mockReturnValueOnce(true);
    const res = await POST(postReq(VALID_POST_BODY));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('duplicate_address');
    expect(body.field).toBe('recipientAddress');
  });

  it('500 propagates unknown DB errors', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    // Not a unique violation — neither helper recognizes it; the route
    // re-throws and the framework returns 500.
    mocks.insertAddressBookEntry.mockRejectedValueOnce(new Error('connection lost'));
    mocks.isAddressBookLabelConflict.mockReturnValue(false);
    mocks.isAddressBookAddressConflict.mockReturnValue(false);
    await expect(POST(postReq(VALID_POST_BODY))).rejects.toThrow('connection lost');
  });

  it('201 + DTO body on happy path; insert called with resolved treasury + actor', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    mocks.insertAddressBookEntry.mockResolvedValueOnce(row({ preApproved: true }));
    const res = await POST(postReq({ ...VALID_POST_BODY, preApproved: true }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.preApproved).toBe(true);
    expect(mocks.insertAddressBookEntry).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        treasuryId: TREASURY_ID,
        label: 'Acme Corp',
        recipientAddress: RECIPIENT,
        preApproved: true,
        createdBy: 'did:privy:x',
      }),
    );
  });
});
