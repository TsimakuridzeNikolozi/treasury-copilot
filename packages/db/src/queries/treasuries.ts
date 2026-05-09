import { desc, eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../client';
import { type TreasuryRow, auditLogs, treasuries, treasuryMemberships } from '../schema';

export interface CreateTreasuryInput {
  name: string;
  walletAddress: string;
  turnkeySubOrgId: string;
  // Nullable — the seed treasury was provisioned outside Turnkey-admin so
  // we don't have its UUID; new treasuries get a UUID back from
  // CreateWallet and store it here.
  turnkeyWalletId: string | null;
  signerBackend: 'local' | 'turnkey';
  // Owner's user id. Nullable for the seed treasury (no real owner; the
  // seed script can attach a real owner later via OWNER_PRIVY_DID env).
  createdBy: string | null;
  // Optional; when provided, the Telegram config is set at creation.
  // Useful for the seed script which copies env values forward.
  telegramChatId?: string | null;
  telegramApproverIds?: string[];
}

export async function createTreasury(db: DbOrTx, input: CreateTreasuryInput): Promise<TreasuryRow> {
  const [row] = await db
    .insert(treasuries)
    .values({
      name: input.name,
      walletAddress: input.walletAddress,
      turnkeySubOrgId: input.turnkeySubOrgId,
      turnkeyWalletId: input.turnkeyWalletId,
      signerBackend: input.signerBackend,
      createdBy: input.createdBy,
      telegramChatId: input.telegramChatId ?? null,
      telegramApproverIds: input.telegramApproverIds ?? [],
    })
    .returning();
  if (!row) throw new Error('createTreasury: insert returned no row');
  return row;
}

export async function getTreasuryById(db: DbOrTx, id: string): Promise<TreasuryRow | null> {
  const row = await db.query.treasuries.findFirst({ where: eq(treasuries.id, id) });
  return row ?? null;
}

export async function getTreasuryByWallet(
  db: Db,
  walletAddress: string,
): Promise<TreasuryRow | null> {
  const row = await db.query.treasuries.findFirst({
    where: eq(treasuries.walletAddress, walletAddress),
  });
  return row ?? null;
}

// Lists every treasury the user is a member of, most-recently-joined first.
// The bootstrap flow's "do I have any treasuries" gate calls this; the
// switcher in app-nav also lists from here.
export async function listTreasuriesForUser(db: Db, userId: string) {
  return db
    .select({
      treasury: treasuries,
      role: treasuryMemberships.role,
      joinedAt: treasuryMemberships.createdAt,
    })
    .from(treasuryMemberships)
    .innerJoin(treasuries, eq(treasuries.id, treasuryMemberships.treasuryId))
    .where(eq(treasuryMemberships.userId, userId))
    .orderBy(desc(treasuryMemberships.createdAt));
}

export interface UpdateTelegramConfigInput {
  treasuryId: string;
  chatId: string | null;
  approverIds: string[];
  // Privy DID of the editor — written to audit_logs.actor.
  updatedBy: string;
}

// Atomic write + audit. If the audit insert fails (constraint, disk, etc.),
// the treasury update rolls back so operators always see a coherent
// audit_logs trail next to their telegram routing config.
export async function updateTelegramConfig(
  db: Db,
  input: UpdateTelegramConfigInput,
): Promise<TreasuryRow> {
  return db.transaction(async (tx) => {
    const before = await tx.query.treasuries.findFirst({
      where: eq(treasuries.id, input.treasuryId),
    });
    if (!before) throw new Error(`updateTelegramConfig: treasury ${input.treasuryId} not found`);

    const [row] = await tx
      .update(treasuries)
      .set({
        telegramChatId: input.chatId,
        telegramApproverIds: input.approverIds,
      })
      .where(eq(treasuries.id, input.treasuryId))
      .returning();
    if (!row) throw new Error('updateTelegramConfig: update returned no row');

    await tx.insert(auditLogs).values({
      kind: 'telegram_config_updated',
      treasuryId: input.treasuryId,
      actor: input.updatedBy,
      payload: {
        before: {
          chatId: before.telegramChatId,
          approverIds: before.telegramApproverIds,
        },
        after: {
          chatId: input.chatId,
          approverIds: input.approverIds,
        },
      },
    });

    return row;
  });
}

// Used by the executor's per-action signer factory and the bot's
// per-callback authorization. Returns enough fields to build a Signer
// (backend, sub-org, wallet) and route Telegram traffic (chatId,
// approver list).
export async function getTreasuryForRouting(
  db: Db,
  treasuryId: string,
): Promise<TreasuryRow | null> {
  return getTreasuryById(db, treasuryId);
}
