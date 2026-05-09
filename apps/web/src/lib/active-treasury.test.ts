import type { TreasuryRow, UserRow } from '@tc/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the @tc/db helpers used by resolveActiveTreasury so the test never
// opens a real DB connection. vi.hoisted runs before the vi.mock factory
// so the test can hold references to the same fns the mock returns.
const mocks = vi.hoisted(() => ({
  getActiveTreasuryAndRole: vi.fn(),
  getUserByPrivyDid: vi.fn(),
  listTreasuriesForUser: vi.fn(),
}));

vi.mock('@tc/db', () => mocks);

const { getActiveTreasuryAndRole, getUserByPrivyDid, listTreasuriesForUser } = mocks;

import { resolveActiveTreasury } from './active-treasury';

const PRIVY_DID = 'did:privy:abc123';
const USER_ID = '00000000-0000-4000-8000-000000000001';
const TREASURY_A_ID = '00000000-0000-4000-8000-00000000000a';
const TREASURY_B_ID = '00000000-0000-4000-8000-00000000000b';

const treasuryA: TreasuryRow = {
  id: TREASURY_A_ID,
  name: 'Personal',
  walletAddress: 'addrA',
  turnkeySubOrgId: 'sub-a',
  turnkeyWalletId: 'w-a',
  signerBackend: 'turnkey',
  telegramChatId: null,
  telegramApproverIds: [],
  createdAt: new Date('2026-05-01T00:00:00Z'),
  createdBy: USER_ID,
};

const treasuryB: TreasuryRow = {
  ...treasuryA,
  id: TREASURY_B_ID,
  name: 'Other',
  walletAddress: 'addrB',
};

const userRow: UserRow = {
  id: USER_ID,
  privyDid: PRIVY_DID,
  email: 'a@b.c',
  createdAt: new Date('2026-05-01T00:00:00Z'),
  lastSeenAt: new Date('2026-05-09T00:00:00Z'),
};

function reqWith(cookieValue: string | null): Request {
  const headers = new Headers();
  if (cookieValue !== null) {
    headers.set('cookie', `tc_active_treasury=${cookieValue}`);
  }
  return new Request('http://localhost/test', { headers });
}

const fakeDb = {} as unknown as Parameters<typeof resolveActiveTreasury>[1];

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveActiveTreasury', () => {
  it('(a) cookie absent and no memberships → onboardingRequired, no Set-Cookie', async () => {
    getActiveTreasuryAndRole.mockResolvedValue(null);
    getUserByPrivyDid.mockResolvedValue(userRow);
    listTreasuriesForUser.mockResolvedValue([]);

    const result = await resolveActiveTreasury(reqWith(null), fakeDb, PRIVY_DID);

    expect(result).toEqual({ onboardingRequired: true });
    // getActiveTreasuryAndRole shouldn't even be called when the cookie
    // is absent — the helper returns null on null input by design.
    expect(getActiveTreasuryAndRole).not.toHaveBeenCalled();
  });

  it('(b) cookie present-but-invalid AND user has memberships → first membership + Set-Cookie that re-sets the cookie', async () => {
    getActiveTreasuryAndRole.mockResolvedValue(null);
    getUserByPrivyDid.mockResolvedValue(userRow);
    listTreasuriesForUser.mockResolvedValue([
      { treasury: treasuryB, role: 'owner', joinedAt: new Date() },
    ]);

    const result = await resolveActiveTreasury(reqWith(TREASURY_A_ID), fakeDb, PRIVY_DID);

    expect('treasury' in result).toBe(true);
    if (!('treasury' in result)) throw new Error('expected resolved treasury');
    expect(result.treasury).toEqual(treasuryB);
    expect('setCookieHeader' in result).toBe(true);
    expect(result.setCookieHeader).toContain(`tc_active_treasury=${TREASURY_B_ID}`);
    // Crucially, this is a SET (re-write) not a CLEAR — Max-Age is the
    // 30-day live value, not 0.
    expect(result.setCookieHeader).toContain('Max-Age=2592000');
  });

  it('(c) cookie present-but-invalid AND user has no memberships → onboardingRequired + Set-Cookie clear', async () => {
    getActiveTreasuryAndRole.mockResolvedValue(null);
    getUserByPrivyDid.mockResolvedValue(userRow);
    listTreasuriesForUser.mockResolvedValue([]);

    const result = await resolveActiveTreasury(reqWith(TREASURY_A_ID), fakeDb, PRIVY_DID);

    expect('onboardingRequired' in result && result.onboardingRequired).toBe(true);
    expect('setCookieHeader' in result ? result.setCookieHeader : undefined).toContain('Max-Age=0');
    // Full attribute parity is what makes the browser actually delete it.
    const header = ('setCookieHeader' in result && result.setCookieHeader) || '';
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
  });

  it('(d) cookie present and valid → return that treasury, no Set-Cookie', async () => {
    getActiveTreasuryAndRole.mockResolvedValue({
      user: userRow,
      treasury: treasuryA,
      role: 'owner',
    });

    const result = await resolveActiveTreasury(reqWith(TREASURY_A_ID), fakeDb, PRIVY_DID);

    expect('treasury' in result && result.treasury).toEqual(treasuryA);
    expect('setCookieHeader' in result ? result.setCookieHeader : undefined).toBeUndefined();
    // Hot path doesn't fall through to the user/membership lookups.
    expect(getUserByPrivyDid).not.toHaveBeenCalled();
    expect(listTreasuriesForUser).not.toHaveBeenCalled();
  });

  it('cookie set but no user row exists → onboardingRequired + Set-Cookie clear', async () => {
    getActiveTreasuryAndRole.mockResolvedValue(null);
    getUserByPrivyDid.mockResolvedValue(null);

    const result = await resolveActiveTreasury(reqWith(TREASURY_A_ID), fakeDb, PRIVY_DID);

    expect('onboardingRequired' in result && result.onboardingRequired).toBe(true);
    expect('setCookieHeader' in result ? result.setCookieHeader : undefined).toContain('Max-Age=0');
    expect(listTreasuriesForUser).not.toHaveBeenCalled();
  });
});
