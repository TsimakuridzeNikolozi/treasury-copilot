import { createDb } from '@tc/db';
import { schema } from '@tc/db';
import { TEST_DATABASE_URL } from '@tc/db/test/url';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Inject env values BEFORE any module that reads them loads. The mock
// SEED_TREASURY_ID has to match a treasury row we insert in beforeAll.
const SEED_ID = '00000000-0000-4000-8000-000000000777';
const PRIVY_DID_NEW = 'did:privy:new-user';
const PRIVY_DID_EXISTING = 'did:privy:existing-user';
const PRIVY_DID_CONCURRENT = 'did:privy:concurrent-user';

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.SEED_TREASURY_ID = SEED_ID;
process.env.SIGNER_BACKEND = 'local'; // overridden per test where needed
process.env.SOLANA_RPC_URL = 'http://localhost';
process.env.TREASURY_PUBKEY_BASE58 = 'So11111111111111111111111111111111111111112';
process.env.MODEL_PROVIDER = 'anthropic';
process.env.PRIVY_APP_SECRET = 'test-secret';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
process.env.NEXT_PUBLIC_PRIVY_APP_ID = 'test-app';

// Hoisted mocks. The route imports verifyBearer + privy from
// @/lib/privy and provisionTreasury from @tc/turnkey-admin; we replace
// both at module level. The DB is left real so the session lock actually
// contends on Postgres. `env` is also mocked so tests can flip
// SIGNER_BACKEND turnkey/local without re-importing the route — t3-env
// snapshots process.env at module load and ignores subsequent mutations.
const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  getUser: vi.fn(),
  provisionTreasury: vi.fn(),
  envState: {
    SIGNER_BACKEND: 'local' as 'local' | 'turnkey',
    SEED_TREASURY_ID: '00000000-0000-4000-8000-000000000777',
    TURNKEY_PARENT_ORG_ID: '00000000-0000-4000-8000-000000000999',
    TURNKEY_PARENT_API_PUBLIC_KEY: 'a'.repeat(66),
    TURNKEY_PARENT_API_PRIVATE_KEY: 'b'.repeat(64),
    TURNKEY_PARENT_BASE_URL: 'https://api.turnkey.com',
  },
}));

vi.mock('@/lib/privy', () => ({
  verifyBearer: mocks.verifyBearer,
  privy: { getUser: mocks.getUser },
  PRIVY_COOKIE: 'privy-token',
}));

vi.mock('@tc/turnkey-admin', () => ({
  provisionTreasury: mocks.provisionTreasury,
  TurnkeyProvisionError: class TurnkeyProvisionError extends Error {},
}));

vi.mock('@/env', () => ({
  // Proxy reads through to envState first so tests can flip
  // SIGNER_BACKEND/SEED_TREASURY_ID/etc. mid-run; falls through to
  // process.env for any other key (so DATABASE_URL etc. still work).
  env: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop in mocks.envState) {
          return mocks.envState[prop as keyof typeof mocks.envState];
        }
        return process.env[prop];
      },
    },
  ),
}));

// Imported after env + mocks are wired so the module-scoped `db` and
// `env` pick up the right values.
let POST: typeof import('./route').POST;
const testDb = createDb(TEST_DATABASE_URL);

beforeAll(async () => {
  // Seed treasury — the local-mode bootstrap path looks this up by id.
  await testDb
    .insert(schema.treasuries)
    .values({
      id: SEED_ID,
      name: 'Seed',
      walletAddress: 'SeedWalletAddress11111111111111111111111111',
      turnkeySubOrgId: 'seed-sub',
      turnkeyWalletId: null,
      signerBackend: 'local',
      telegramChatId: null,
      telegramApproverIds: [],
      createdBy: null,
    })
    .onConflictDoNothing();

  ({ POST } = await import('./route'));
});

beforeEach(async () => {
  vi.clearAllMocks();
  // Wipe everything created by these tests. CASCADE flushes the FK chains
  // (proposed_actions / approvals / audit_logs / memberships) without
  // ordering games. Keep the seed treasury row by re-inserting it after.
  await testDb.execute(
    'TRUNCATE TABLE audit_logs, approvals, proposed_actions, treasury_memberships, treasuries, users CASCADE',
  );
  await testDb
    .insert(schema.treasuries)
    .values({
      id: SEED_ID,
      name: 'Seed',
      walletAddress: 'SeedWalletAddress11111111111111111111111111',
      turnkeySubOrgId: 'seed-sub',
      turnkeyWalletId: null,
      signerBackend: 'local',
      telegramChatId: null,
      telegramApproverIds: [],
      createdBy: null,
    })
    .onConflictDoNothing();
});

function bearerReq(token = 'tok'): Request {
  return new Request('http://localhost/api/me/bootstrap', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/me/bootstrap', () => {
  it('401 when bearer is missing/invalid', async () => {
    mocks.verifyBearer.mockResolvedValue(null);
    const res = await POST(bearerReq());
    expect(res.status).toBe(401);
    expect(mocks.provisionTreasury).not.toHaveBeenCalled();
  });

  it('200 + created:true on first turnkey-mode bootstrap', async () => {
    mocks.envState.SIGNER_BACKEND = 'turnkey';

    mocks.verifyBearer.mockResolvedValue({ userId: PRIVY_DID_NEW });
    mocks.getUser.mockResolvedValue({ email: { address: 'new@example.com' } });
    mocks.provisionTreasury.mockResolvedValue({
      subOrgId: 'sub-1',
      walletId: 'wallet-1',
      walletAddress: 'NewUserWalletAddress11111111111111111111111',
    });

    const res = await POST(bearerReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.activeTreasury.walletAddress).toBe('NewUserWalletAddress11111111111111111111111');
    // Cookie set with the new treasury id.
    expect(res.headers.get('set-cookie')).toContain('tc_active_treasury=');

    // DB invariants.
    const userRow = await testDb.query.users.findFirst({
      where: eq(schema.users.privyDid, PRIVY_DID_NEW),
    });
    expect(userRow).toBeDefined();
    const treasuryRow = await testDb.query.treasuries.findFirst({
      where: eq(schema.treasuries.walletAddress, 'NewUserWalletAddress11111111111111111111111'),
    });
    expect(treasuryRow?.signerBackend).toBe('turnkey');
    expect(treasuryRow?.turnkeySubOrgId).toBe('sub-1');
    const memberships = await testDb.query.treasuryMemberships.findMany({
      where: eq(schema.treasuryMemberships.userId, userRow?.id ?? ''),
    });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe('owner');
    const audits = await testDb.query.auditLogs.findMany({
      where: eq(schema.auditLogs.treasuryId, treasuryRow?.id ?? ''),
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.kind).toBe('treasury_created');
    expect(mocks.provisionTreasury).toHaveBeenCalledTimes(1);

    mocks.envState.SIGNER_BACKEND = 'local';
  });

  it('200 + created:true on first local-mode bootstrap (attaches to seed, no Turnkey call)', async () => {
    mocks.envState.SIGNER_BACKEND = 'local';

    mocks.verifyBearer.mockResolvedValue({ userId: PRIVY_DID_EXISTING });
    mocks.getUser.mockResolvedValue({ email: { address: 'dev@example.com' } });

    const res = await POST(bearerReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.activeTreasury.id).toBe(SEED_ID);
    expect(mocks.provisionTreasury).not.toHaveBeenCalled();

    const audits = await testDb.query.auditLogs.findMany({
      where: eq(schema.auditLogs.treasuryId, SEED_ID),
    });
    // Distinct kind so dev/prod divergence is grep-able later.
    expect(audits.some((a) => a.kind === 'membership_added')).toBe(true);
  });

  it('200 + created:false on idempotent re-bootstrap (existing membership)', async () => {
    mocks.envState.SIGNER_BACKEND = 'local';

    mocks.verifyBearer.mockResolvedValue({ userId: PRIVY_DID_EXISTING });
    mocks.getUser.mockResolvedValue({ email: { address: 'dev@example.com' } });

    // First call creates everything.
    const first = await POST(bearerReq());
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.created).toBe(true);

    // Second call short-circuits at stage 1.
    const second = await POST(bearerReq());
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.created).toBe(false);
    expect(secondBody.activeTreasury.id).toBe(firstBody.activeTreasury.id);

    // Still only one membership row.
    const userRow = await testDb.query.users.findFirst({
      where: eq(schema.users.privyDid, PRIVY_DID_EXISTING),
    });
    const memberships = await testDb.query.treasuryMemberships.findMany({
      where: eq(schema.treasuryMemberships.userId, userRow?.id ?? ''),
    });
    expect(memberships).toHaveLength(1);
  });

  it('concurrent idempotency under session lock: 5 simultaneous calls produce 1 treasury, 1 provisionTreasury call', async () => {
    mocks.envState.SIGNER_BACKEND = 'turnkey';

    mocks.verifyBearer.mockResolvedValue({ userId: PRIVY_DID_CONCURRENT });
    mocks.getUser.mockResolvedValue({ email: { address: 'race@example.com' } });
    mocks.provisionTreasury.mockResolvedValue({
      subOrgId: 'sub-race',
      walletId: 'wallet-race',
      walletAddress: 'ConcurrentWallet1111111111111111111111111111',
    });

    const responses = await Promise.all(Array.from({ length: 5 }, () => POST(bearerReq())));

    expect(responses.every((r) => r.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    const ids = new Set(bodies.map((b) => b.activeTreasury.id));
    expect(ids.size).toBe(1); // Same treasury id across all 5.
    const createdCount = bodies.filter((b) => b.created).length;
    expect(createdCount).toBe(1); // Exactly one of them ran stages 2+3.

    // Crucial: provisionTreasury must have been called exactly once. If
    // the session lock didn't bridge stages 2+3, we'd see 5 calls here.
    expect(mocks.provisionTreasury).toHaveBeenCalledTimes(1);

    // DB invariants.
    const userRow = await testDb.query.users.findFirst({
      where: eq(schema.users.privyDid, PRIVY_DID_CONCURRENT),
    });
    const memberships = await testDb.query.treasuryMemberships.findMany({
      where: eq(schema.treasuryMemberships.userId, userRow?.id ?? ''),
    });
    expect(memberships).toHaveLength(1);
    const audits = await testDb.query.auditLogs.findMany({
      where: eq(schema.auditLogs.kind, 'treasury_created'),
    });
    expect(audits.filter((a) => a.actor === PRIVY_DID_CONCURRENT)).toHaveLength(1);

    mocks.envState.SIGNER_BACKEND = 'local';
  });

  it('502 on stage-2 Turnkey failure; user row stays for retry', async () => {
    mocks.envState.SIGNER_BACKEND = 'turnkey';

    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:stage2-fail' });
    mocks.getUser.mockResolvedValue({ email: null });
    mocks.provisionTreasury.mockRejectedValue(new Error('boom'));

    const res = await POST(bearerReq());
    expect(res.status).toBe(502);

    // User row exists, no treasury row.
    const userRow = await testDb.query.users.findFirst({
      where: eq(schema.users.privyDid, 'did:privy:stage2-fail'),
    });
    expect(userRow).toBeDefined();
    const memberships = await testDb.query.treasuryMemberships.findMany({
      where: eq(schema.treasuryMemberships.userId, userRow?.id ?? ''),
    });
    expect(memberships).toHaveLength(0);

    // Retry succeeds without re-creating the user.
    const userIdBefore = userRow?.id;
    mocks.provisionTreasury.mockResolvedValue({
      subOrgId: 'sub-retry',
      walletId: 'wallet-retry',
      walletAddress: 'RetryWallet1111111111111111111111111111111111',
    });
    const retry = await POST(bearerReq());
    expect(retry.status).toBe(200);
    const userRowAfter = await testDb.query.users.findFirst({
      where: eq(schema.users.privyDid, 'did:privy:stage2-fail'),
    });
    expect(userRowAfter?.id).toBe(userIdBefore);

    mocks.envState.SIGNER_BACKEND = 'local';
  });

  it('500 on stage-3 persistence failure; logs orphaned subOrgId; user row stays', async () => {
    // Reproduce the post-Turnkey orphan path: provisionTreasury succeeds
    // and returns a sub-org, but stage-3's createTreasury insert fails
    // (unique constraint on wallet_address fires because a prior
    // treasury already holds the same address). We pre-insert that
    // colliding row to drive the constraint violation.
    mocks.envState.SIGNER_BACKEND = 'turnkey';

    const COLLIDING_WALLET = 'CollidingWallet11111111111111111111111111111';
    await testDb.insert(schema.treasuries).values({
      name: 'Collider',
      walletAddress: COLLIDING_WALLET,
      turnkeySubOrgId: 'collider-sub',
      turnkeyWalletId: null,
      signerBackend: 'turnkey',
      telegramChatId: null,
      telegramApproverIds: [],
      createdBy: null,
    });

    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:stage3-fail' });
    mocks.getUser.mockResolvedValue({ email: null });
    mocks.provisionTreasury.mockResolvedValue({
      subOrgId: 'orphan-sub-org',
      walletId: 'orphan-wallet',
      walletAddress: COLLIDING_WALLET, // ← collides; createTreasury throws
    });

    // Spy on console.error so we can assert the orphan was logged with
    // its subOrgId — that's how an operator finds it to reconcile via
    // the Turnkey console (M3 ships an automatic reconciler).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(bearerReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('persistence_failed');

    // Critical: user row exists (the upsert in stage 1 succeeded), but
    // no membership and no NEW treasury row for this user. Stage 3's
    // transaction rolled back atomically.
    const userRow = await testDb.query.users.findFirst({
      where: eq(schema.users.privyDid, 'did:privy:stage3-fail'),
    });
    expect(userRow).toBeDefined();
    const memberships = await testDb.query.treasuryMemberships.findMany({
      where: eq(schema.treasuryMemberships.userId, userRow?.id ?? ''),
    });
    expect(memberships).toHaveLength(0);
    // No audit row written either (the audit insert is inside the same tx).
    const audits = await testDb.query.auditLogs.findMany({
      where: eq(schema.auditLogs.actor, 'did:privy:stage3-fail'),
    });
    expect(audits).toHaveLength(0);

    // The orphan log fired with the subOrgId. Concatenate every
    // logged-line argument (console.error gets two: the message string
    // and the error object) to make the assertion order-independent.
    const logged = errorSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).toContain('orphaned subOrgId=orphan-sub-org');

    errorSpy.mockRestore();
    mocks.envState.SIGNER_BACKEND = 'local';
  });
});
