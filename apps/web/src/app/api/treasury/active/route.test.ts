import { type UserRow, schema } from '@tc/db';
import { createDb } from '@tc/db';
import { TEST_DATABASE_URL } from '@tc/db/test/url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TREASURY_ID = '00000000-0000-4000-8000-000000000aaa';
const PRIVY_DID = 'did:privy:treasury-active-user';

process.env.DATABASE_URL = TEST_DATABASE_URL;

const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
}));

vi.mock('@/lib/privy', () => ({
  verifyBearer: mocks.verifyBearer,
  privy: {},
  PRIVY_COOKIE: 'privy-token',
}));

vi.mock('@/env', () => ({
  env: new Proxy({}, { get: (_t, prop: string) => process.env[prop] }),
}));

let POST: typeof import('./route').POST;
const testDb = createDb(TEST_DATABASE_URL);

beforeAll(async () => {
  ({ POST } = await import('./route'));
});

let user: UserRow;

beforeEach(async () => {
  vi.clearAllMocks();
  await testDb.execute(
    'TRUNCATE TABLE audit_logs, approvals, proposed_actions, treasury_memberships, treasuries, users CASCADE',
  );
  await testDb.insert(schema.treasuries).values({
    id: TREASURY_ID,
    name: 'Test',
    walletAddress: 'TestWalletAddress11111111111111111111111111',
    turnkeySubOrgId: 'sub',
    turnkeyWalletId: null,
    signerBackend: 'local',
    telegramChatId: null,
    telegramApproverIds: [],
    createdBy: null,
  });
  const [u] = await testDb
    .insert(schema.users)
    .values({ privyDid: PRIVY_DID, email: 'a@b.c', lastSeenAt: new Date() })
    .returning();
  if (!u) throw new Error('user insert returned no row');
  user = u;
});

afterEach(() => {
  vi.clearAllMocks();
});

function postReq(body: unknown, token = 'tok'): Request {
  return new Request('http://localhost/api/treasury/active', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/treasury/active', () => {
  it('401 on missing bearer', async () => {
    mocks.verifyBearer.mockResolvedValue(null);
    const res = await POST(postReq({ treasuryId: TREASURY_ID }));
    expect(res.status).toBe(401);
  });

  it('400 on malformed body', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: PRIVY_DID });
    const res = await POST(postReq({ treasuryId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('403 when user is not a member', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: PRIVY_DID });
    // No membership row inserted — user exists but isn't on the treasury.
    const res = await POST(postReq({ treasuryId: TREASURY_ID }));
    expect(res.status).toBe(403);
  });

  it('204 + Set-Cookie on member (with full attribute set)', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: PRIVY_DID });
    await testDb.insert(schema.treasuryMemberships).values({
      treasuryId: TREASURY_ID,
      userId: user.id,
      role: 'owner',
    });

    const res = await POST(postReq({ treasuryId: TREASURY_ID }));
    expect(res.status).toBe(204);
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toContain(`tc_active_treasury=${TREASURY_ID}`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=2592000');
  });
});
