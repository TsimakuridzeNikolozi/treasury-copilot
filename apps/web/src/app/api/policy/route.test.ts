import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  resolveActiveTreasury: vi.fn(),
  getPolicy: vi.fn(),
  upsertPolicy: vi.fn(),
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
  getPolicy: mocks.getPolicy,
  upsertPolicy: mocks.upsertPolicy,
}));

const { GET, PATCH } = await import('./route');

const TREASURY_ID = '00000000-0000-4000-8000-000000000aaa';

const VALID_PATCH = {
  requireApprovalAboveUsdc: '100',
  maxSingleActionUsdc: '1000',
  maxAutoApprovedUsdcPer24h: '500',
  allowedVenues: ['kamino'],
  treasuryId: TREASURY_ID,
};

function getReq(): Request {
  return new Request('http://localhost/api/policy', {
    headers: { authorization: 'Bearer tok' },
  });
}
function patchReq(body: unknown): Request {
  return new Request('http://localhost/api/policy', {
    method: 'PATCH',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/policy', () => {
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
  });

  it('returns the policy on success', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    mocks.getPolicy.mockResolvedValue({ requireApprovalAboveUsdc: '100' });
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(mocks.getPolicy).toHaveBeenCalledWith({}, TREASURY_ID);
  });
});

describe('PATCH /api/policy', () => {
  it('400 on malformed body', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const res = await PATCH(patchReq({ ...VALID_PATCH, treasuryId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('403 when role is not owner', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      // anticipating M3: M2 only allows 'owner', but the runtime gate is
      // wired now so the test stays meaningful when the CHECK lifts.
      role: 'approver',
    });
    const res = await PATCH(patchReq(VALID_PATCH));
    expect(res.status).toBe(403);
  });

  it('409 active_treasury_changed when body treasuryId mismatches resolved', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: '00000000-0000-4000-8000-00000000bbbb' },
      role: 'owner',
    });
    const res = await PATCH(patchReq(VALID_PATCH));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('active_treasury_changed');
  });

  it('204 on happy path; upsertPolicy called with the resolved treasury', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    const res = await PATCH(patchReq(VALID_PATCH));
    expect(res.status).toBe(204);
    expect(mocks.upsertPolicy).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ treasuryId: TREASURY_ID, updatedBy: 'did:privy:x' }),
    );
  });
});
