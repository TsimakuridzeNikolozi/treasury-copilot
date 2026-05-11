import { type UserRow, createDb, schema } from '@tc/db';
import { TEST_DATABASE_URL } from '@tc/db/test/url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const TREASURY_ID = '00000000-0000-4000-8000-000000000bbb';
const TREASURY_WALLET = 'So11111111111111111111111111111111111111112';
const PRIVY_DID = 'did:privy:balance-route-test';

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.SOLANA_RPC_URL = 'http://localhost';

const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  getWalletUsdcBalance: vi.fn(),
}));

vi.mock('@/lib/privy', () => ({
  verifyBearer: mocks.verifyBearer,
  privy: {},
  PRIVY_COOKIE: 'privy-token',
}));

vi.mock('@/env', () => ({
  env: new Proxy({}, { get: (_t, prop: string) => process.env[prop] }),
}));

vi.mock('@tc/protocols', () => ({
  usdc: {
    getWalletUsdcBalance: mocks.getWalletUsdcBalance,
  },
}));

let GET: typeof import('./route').GET;
const testDb = createDb(TEST_DATABASE_URL);

beforeAll(async () => {
  ({ GET } = await import('./route'));
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
    walletAddress: TREASURY_WALLET,
    turnkeySubOrgId: 'sub',
    turnkeyWalletId: null,
    signerBackend: 'local',
    telegramChatId: null,
    telegramApproverIds: [],
    createdBy: null,
  });
  const [u] = await testDb
    .insert(schema.users)
    .values({ privyDid: PRIVY_DID, email: null, lastSeenAt: new Date() })
    .returning();
  if (!u) throw new Error('user insert returned no row');
  user = u;
  await testDb
    .insert(schema.treasuryMemberships)
    .values({ treasuryId: TREASURY_ID, userId: user.id, role: 'owner' });
});

afterEach(() => {
  vi.clearAllMocks();
});

function getReq(opts: { treasuryId?: string; cookie?: string; token?: string } = {}): Request {
  const url = new URL('http://localhost/api/treasury/balance');
  if (opts.treasuryId) url.searchParams.set('treasuryId', opts.treasuryId);
  const headers = new Headers({ authorization: `Bearer ${opts.token ?? 'tok'}` });
  if (opts.cookie) headers.set('cookie', opts.cookie);
  return new Request(url.toString(), { method: 'GET', headers });
}

describe('GET /api/treasury/balance', () => {
  it('401 on missing bearer', async () => {
    mocks.verifyBearer.mockResolvedValue(null);
    const res = await GET(getReq());
    expect(res.status).toBe(401);
  });

  it('200 on happy path; returns the mocked balance', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: PRIVY_DID });
    mocks.getWalletUsdcBalance.mockResolvedValue({ amountUsdc: '1234.56' });

    const res = await GET(
      getReq({ treasuryId: TREASURY_ID, cookie: `tc_active_treasury=${TREASURY_ID}` }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.amountUsdc).toBe('1234.56');
    expect(mocks.getWalletUsdcBalance).toHaveBeenCalledTimes(1);
  });

  it('409 active_treasury_changed when query treasuryId mismatches the cookie', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: PRIVY_DID });
    mocks.getWalletUsdcBalance.mockResolvedValue({ amountUsdc: '0' });

    const res = await GET(
      getReq({
        treasuryId: '00000000-0000-4000-8000-000000000ccc', // wrong id
        cookie: `tc_active_treasury=${TREASURY_ID}`,
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('active_treasury_changed');
    // Critical: the RPC was NOT called. 409 short-circuits before
    // hitting Solana, so a stale tab can't burn quota on the wrong
    // treasury.
    expect(mocks.getWalletUsdcBalance).not.toHaveBeenCalled();
  });

  it('caches the balance — second call within TTL does NOT hit the RPC', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: PRIVY_DID });
    mocks.getWalletUsdcBalance.mockResolvedValue({ amountUsdc: '500' });

    // Random treasuryId per test run so the module-scoped cache (which
    // persists across tests within the same vitest worker) doesn't
    // serve a stale value from the prior "happy path" test. Wipe + fresh
    // insert because the existing membership FK blocks an in-place id
    // update.
    const cacheTreasuryId = crypto.randomUUID();
    await testDb
      .delete(schema.treasuryMemberships)
      .where(eq(schema.treasuryMemberships.treasuryId, TREASURY_ID));
    await testDb.delete(schema.treasuries).where(eq(schema.treasuries.id, TREASURY_ID));
    await testDb.insert(schema.treasuries).values({
      id: cacheTreasuryId,
      name: 'Cache Test',
      walletAddress: 'So11111111111111111111111111111111111111112',
      turnkeySubOrgId: 'sub',
      turnkeyWalletId: null,
      signerBackend: 'local',
      telegramChatId: null,
      telegramApproverIds: [],
      createdBy: null,
    });
    await testDb
      .insert(schema.treasuryMemberships)
      .values({ treasuryId: cacheTreasuryId, userId: user.id, role: 'owner' });

    const args = {
      treasuryId: cacheTreasuryId,
      cookie: `tc_active_treasury=${cacheTreasuryId}`,
    };
    await GET(getReq(args));
    await GET(getReq(args));

    // Module-scoped cache (3s TTL) coalesces the two calls within the
    // same test run (sub-millisecond apart). Concurrent tabs polling
    // every 5s collapse to one RPC per ~3s window.
    expect(mocks.getWalletUsdcBalance).toHaveBeenCalledTimes(1);
  });
});
