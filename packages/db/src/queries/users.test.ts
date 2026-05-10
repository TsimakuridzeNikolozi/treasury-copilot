import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../../test/url';
import * as schema from '../schema';
import {
  InvalidOnboardingStep,
  bootstrapUserCore,
  markUserOnboarded,
  markUserOnboardingStep,
} from './users';

const DATABASE_URL = process.env.DATABASE_URL ?? TEST_DATABASE_URL;
const SKIP = process.env.SKIP_DB_TESTS === '1';

const queryClient = postgres(DATABASE_URL, { max: 4 });
const db = drizzle(queryClient, { schema });

afterAll(async () => {
  await queryClient.end();
});

const PRIVY_DID = 'did:privy:onboarding-test';

describe.skipIf(SKIP)('queries/users — onboarding helpers', () => {
  beforeEach(async () => {
    // Wipe everything CASCADE so the audit_logs / users tables are
    // deterministic per test. Same pattern as treasuries.test.ts (safe
    // because vitest.config.ts pins fileParallelism: false).
    await db.execute(
      'TRUNCATE TABLE audit_logs, approvals, proposed_actions, treasury_memberships, policies, treasuries, users CASCADE',
    );
  });

  describe('markUserOnboardingStep', () => {
    it('writes the step on a fresh user (onboarded_at is null)', async () => {
      const user = await bootstrapUserCore(db, { privyDid: PRIVY_DID, email: null });
      await markUserOnboardingStep(db, user.id, 3);
      const row = await db.query.users.findFirst({ where: eq(schema.users.id, user.id) });
      expect(row?.onboardingStep).toBe(3);
    });

    it('is idempotent on repeat with the same step', async () => {
      const user = await bootstrapUserCore(db, { privyDid: PRIVY_DID, email: null });
      await markUserOnboardingStep(db, user.id, 2);
      await markUserOnboardingStep(db, user.id, 2);
      const row = await db.query.users.findFirst({ where: eq(schema.users.id, user.id) });
      expect(row?.onboardingStep).toBe(2);
    });

    it('no-ops when the user is already onboarded', async () => {
      const user = await bootstrapUserCore(db, { privyDid: PRIVY_DID, email: null });
      await markUserOnboarded(db, user.id);
      await markUserOnboardingStep(db, user.id, 4);
      const row = await db.query.users.findFirst({ where: eq(schema.users.id, user.id) });
      // markUserOnboarded set step to null and onboardedAt to NOW();
      // the subsequent markUserOnboardingStep is filtered at SQL level
      // (where onboarded_at IS NULL) so step stays null.
      expect(row?.onboardingStep).toBeNull();
      expect(row?.onboardedAt).not.toBeNull();
    });

    it('throws InvalidOnboardingStep on out-of-range values', async () => {
      const user = await bootstrapUserCore(db, { privyDid: PRIVY_DID, email: null });
      await expect(markUserOnboardingStep(db, user.id, 0)).rejects.toBeInstanceOf(
        InvalidOnboardingStep,
      );
      await expect(markUserOnboardingStep(db, user.id, 6)).rejects.toBeInstanceOf(
        InvalidOnboardingStep,
      );
      await expect(markUserOnboardingStep(db, user.id, 1.5)).rejects.toBeInstanceOf(
        InvalidOnboardingStep,
      );
    });
  });

  describe('markUserOnboarded', () => {
    it('sets onboarded_at, clears onboarding_step, writes audit row', async () => {
      const user = await bootstrapUserCore(db, { privyDid: PRIVY_DID, email: null });
      await markUserOnboardingStep(db, user.id, 3);
      await markUserOnboarded(db, user.id);

      const row = await db.query.users.findFirst({ where: eq(schema.users.id, user.id) });
      expect(row?.onboardedAt).not.toBeNull();
      expect(row?.onboardingStep).toBeNull();

      const audits = await db.query.auditLogs.findMany({
        where: eq(schema.auditLogs.kind, 'user_onboarded'),
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actor).toBe(PRIVY_DID);
      expect(audits[0]?.treasuryId).toBeNull();
      expect(audits[0]?.payload).toMatchObject({ userId: user.id });
    });

    it('is idempotent — second call does NOT write a duplicate audit row', async () => {
      const user = await bootstrapUserCore(db, { privyDid: PRIVY_DID, email: null });
      await markUserOnboarded(db, user.id);
      const firstStamp = (await db.query.users.findFirst({ where: eq(schema.users.id, user.id) }))
        ?.onboardedAt;

      await markUserOnboarded(db, user.id);
      const secondStamp = (await db.query.users.findFirst({ where: eq(schema.users.id, user.id) }))
        ?.onboardedAt;

      // Stamp didn't move — the second call no-op'd because the WHERE
      // clause filtered on onboarded_at IS NULL.
      expect(secondStamp?.getTime()).toBe(firstStamp?.getTime());

      const audits = await db.query.auditLogs.findMany({
        where: eq(schema.auditLogs.kind, 'user_onboarded'),
      });
      expect(audits).toHaveLength(1);
    });
  });
});
