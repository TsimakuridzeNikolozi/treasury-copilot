import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  resolveActiveTreasury: vi.fn(),
  listTransactionHistory: vi.fn(),
  listAddressBookEntries: vi.fn(async () => []),
  getFailureReasons: vi.fn(async () => new Map()),
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
  listTransactionHistory: mocks.listTransactionHistory,
  listAddressBookEntries: mocks.listAddressBookEntries,
  getFailureReasons: mocks.getFailureReasons,
}));

const { GET } = await import('./route');

const TREASURY_ID = '00000000-0000-4000-8000-000000000aaa';

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    treasuryId: TREASURY_ID,
    payload: {
      kind: 'deposit',
      treasuryId: TREASURY_ID,
      venue: 'kamino',
      amountUsdc: '1000',
      sourceWallet: 'So11111111111111111111111111111111111111112',
    },
    status: 'executed',
    amountUsdc: '1000.000000',
    venue: 'kamino',
    proposedBy: 'agent',
    policyDecision: { kind: 'allow' },
    telegramMessageId: null,
    telegramChatId: null,
    txSignature: 'sig123',
    rebalanceIntermediateSignature: null,
    createdAt: new Date('2026-04-01T10:00:00Z'),
    executedAt: new Date('2026-04-01T10:00:30Z'),
    ...overrides,
  };
}

function getReq(url: string): Request {
  return new Request(url, {
    method: 'GET',
    headers: { authorization: 'Bearer tok' },
  });
}

describe('GET /api/treasury/history', () => {
  it('401 on missing bearer', async () => {
    mocks.verifyBearer.mockResolvedValue(null);
    const res = await GET(getReq('http://localhost/api/treasury/history'));
    expect(res.status).toBe(401);
  });

  it('400 on bad limit param', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const res = await GET(getReq('http://localhost/api/treasury/history?limit=9999'));
    expect(res.status).toBe(400);
  });

  it('400 on bad kind enum', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const res = await GET(getReq('http://localhost/api/treasury/history?kind=bogus'));
    expect(res.status).toBe(400);
  });

  it('409 no_active_treasury when resolver reports onboarding required', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({ onboardingRequired: true });
    const res = await GET(getReq('http://localhost/api/treasury/history'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('no_active_treasury');
  });

  it('200 + entries array on happy path', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    mocks.listTransactionHistory.mockResolvedValue([row()]);
    const res = await GET(getReq('http://localhost/api/treasury/history?limit=50'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      kind: 'deposit',
      status: 'executed',
      venue: 'kamino',
      txSignature: 'sig123',
    });
    // Under-filled page → no nextCursor.
    expect(body.nextCursor).toBeNull();
  });

  it('emits nextCursor when the page is full', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    // Fill limit=2 exactly so the cursor is emitted.
    mocks.listTransactionHistory.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);
    const res = await GET(getReq('http://localhost/api/treasury/history?limit=2'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toHaveLength(2);
    expect(typeof body.nextCursor).toBe('string');
    // Cursor encodes the LAST row's id (the 'b' row).
    expect(body.nextCursor).toContain('__b');
  });

  it('passes the cursor + filters through to listTransactionHistory', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    mocks.listTransactionHistory.mockResolvedValue([]);
    const CURSOR_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const cursor = `2026-04-01T10:00:00.000Z__${CURSOR_ID}`;
    const res = await GET(
      getReq(
        `http://localhost/api/treasury/history?kind=transfer&status=failed&limit=10&before=${encodeURIComponent(cursor)}`,
      ),
    );
    expect(res.status).toBe(200);
    expect(mocks.listTransactionHistory).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        treasuryId: TREASURY_ID,
        kind: 'transfer',
        status: 'failed',
        limit: 10,
        before: expect.objectContaining({ id: CURSOR_ID }),
      }),
    );
  });
});
