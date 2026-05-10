import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_TREASURY_ID, ensureTestTreasury } from '../../test/treasury';
import { TEST_DATABASE_URL } from '../../test/url';
import * as schema from '../schema';
import {
  LocalModeTreasuryAmbiguous,
  LocalModeTreasuryMissing,
  getLocalModeTreasury,
} from './treasuries';

const DATABASE_URL = process.env.DATABASE_URL ?? TEST_DATABASE_URL;

const SKIP = process.env.SKIP_DB_TESTS === '1';
const queryClient = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(queryClient, { schema });

const SECOND_LOCAL_ID = '00000000-0000-4000-8000-000000000abc';

afterAll(async () => {
  await queryClient.end();
});

describe.skipIf(SKIP)('queries/treasuries — getLocalModeTreasury', () => {
  beforeEach(async () => {
    // Other suites in this DB pkg insert their own local-mode treasuries
    // (policies.test.ts:97 "Policies Test Other", actions.test.ts second
    // treasuries) and don't always clean up. Wipe everything CASCADE so
    // the count assertions are deterministic, then re-seed the shared
    // test treasury for any downstream code that calls ensureTestTreasury.
    //
    // Safe to truncate aggressively because packages/db/vitest.config.ts
    // pins `fileParallelism: false` — no other test file is mid-run when
    // this beforeEach executes. If parallelism is ever turned on, scope
    // the cleanup to rows this suite created or move to per-suite
    // schemas instead.
    await db.execute(
      'TRUNCATE TABLE audit_logs, approvals, proposed_actions, treasury_memberships, policies, treasuries, users CASCADE',
    );
    await ensureTestTreasury(db);
  });

  it('returns the unique signer_backend=local row', async () => {
    const row = await getLocalModeTreasury(db);
    expect(row.id).toBe(TEST_TREASURY_ID);
    expect(row.signerBackend).toBe('local');
  });

  it('throws LocalModeTreasuryAmbiguous when multiple local rows exist', async () => {
    await db.insert(schema.treasuries).values({
      id: SECOND_LOCAL_ID,
      name: 'Second Local',
      walletAddress: 'SecondLocalWallet111111111111111111111111111',
      turnkeySubOrgId: 'second-local-sub',
      turnkeyWalletId: null,
      signerBackend: 'local',
      telegramChatId: null,
      telegramApproverIds: [],
      createdBy: null,
    });

    await expect(getLocalModeTreasury(db)).rejects.toBeInstanceOf(LocalModeTreasuryAmbiguous);
  });

  it('throws LocalModeTreasuryMissing when zero local rows exist', async () => {
    // Promote the shared test treasury to turnkey for the duration of the
    // test so the lookup sees zero local rows. Restore in finally.
    await db
      .update(schema.treasuries)
      .set({ signerBackend: 'turnkey' })
      .where(eq(schema.treasuries.id, TEST_TREASURY_ID));
    try {
      await expect(getLocalModeTreasury(db)).rejects.toBeInstanceOf(LocalModeTreasuryMissing);
    } finally {
      await db
        .update(schema.treasuries)
        .set({ signerBackend: 'local' })
        .where(eq(schema.treasuries.id, TEST_TREASURY_ID));
    }
  });
});
