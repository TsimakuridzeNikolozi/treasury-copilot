import { eq } from 'drizzle-orm';
import * as schema from '../src/schema';

// Stable id for the shared test treasury. Tests insert it on demand
// (idempotent) so every proposed_actions / approvals / audit_logs row they
// create has a valid treasury_id FK. All suites within a single Postgres
// test DB share this row — whichever suite runs first inserts it; later
// callers find-by-id and return the existing row (their values are
// ignored). If you ever need concurrent suite execution against the same
// DB, give each suite its own TEST_TREASURY_ID instead of trying to vary
// the wallet address.
export const TEST_TREASURY_ID = '00000000-0000-4000-8000-000000000001';
export const TEST_TREASURY_WALLET = 'So11111111111111111111111111111111111111112';

// biome-ignore lint/suspicious/noExplicitAny: takes any drizzle Db / tx
export async function ensureTestTreasury(db: any) {
  const existing = await db.query.treasuries.findFirst({
    where: eq(schema.treasuries.id, TEST_TREASURY_ID),
  });
  if (existing) return existing;
  const [row] = await db
    .insert(schema.treasuries)
    .values({
      id: TEST_TREASURY_ID,
      name: 'Test Treasury',
      walletAddress: TEST_TREASURY_WALLET,
      turnkeySubOrgId: 'test-suborg',
      turnkeyWalletId: null,
      signerBackend: 'local',
      telegramChatId: null,
      telegramApproverIds: [],
      createdBy: null,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  // Lost a race; re-read.
  const reread = await db.query.treasuries.findFirst({
    where: eq(schema.treasuries.id, TEST_TREASURY_ID),
  });
  if (!reread) throw new Error('ensureTestTreasury: insert + reread both empty');
  return reread;
}
