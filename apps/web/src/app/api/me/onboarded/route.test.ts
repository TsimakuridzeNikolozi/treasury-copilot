import { type UserRow, createDb, schema } from '@tc/db';
import { TEST_DATABASE_URL } from '@tc/db/test/url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PRIVY_DID = 'did:privy:onboarded-route-test';

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
  const [u] = await testDb
    .insert(schema.users)
    .values({ privyDid: PRIVY_DID, email: null, lastSeenAt: new Date() })
    .returning();
  if (!u) throw new Error('user insert returned no row');
  user = u;
});

afterEach(() => {
  vi.clearAllMocks();
});

function postReq(token = 'tok'): Request {
  return new Request('http://localhost/api/me/onboarded', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('POST /api/me/onboarded', () => {
  it('401 on missing bearer', async () => {
    mocks.verifyBearer.mockResolvedValue(null);
    const res = await POST(postReq());
    expect(res.status).toBe(401);
  });

  it('204 on first onboarded call; sets onboarded_at, writes user_onboarded audit row', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: PRIVY_DID });
    const res = await POST(postReq());
    expect(res.status).toBe(204);

    const row = await testDb.query.users.findFirst({ where: eq(schema.users.id, user.id) });
    expect(row?.onboardedAt).not.toBeNull();
    expect(row?.onboardingStep).toBeNull();

    const audits = await testDb.query.auditLogs.findMany({
      where: eq(schema.auditLogs.kind, 'user_onboarded'),
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor).toBe(PRIVY_DID);
  });

  it('idempotent — second call returns 204 without writing a duplicate audit row', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: PRIVY_DID });
    await POST(postReq());
    await POST(postReq());

    const audits = await testDb.query.auditLogs.findMany({
      where: eq(schema.auditLogs.kind, 'user_onboarded'),
    });
    // markUserOnboarded filters on `onboarded_at IS NULL`, so the
    // second call no-ops at the SQL level — no audit row written.
    expect(audits).toHaveLength(1);
  });

  it("409 when the user row doesn't exist (privyDid never bootstrapped)", async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:never-existed' });
    const res = await POST(postReq());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('no_user_row');
  });
});
