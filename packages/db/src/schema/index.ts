import type { PolicyDecision, ProposedAction, Venue } from '@tc/types';
import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const actionStatus = pgEnum('action_status', [
  'pending',
  'approved',
  'executing',
  'denied',
  'executed',
  'failed',
]);

const VENUE_VALUES = ['kamino', 'save', 'drift', 'marginfi'] as const satisfies readonly Venue[];
const DECISION_VALUES = ['approve', 'deny'] as const;

// M2 multi-tenancy roles. Owner-only in M2; M3 lifts this CHECK.
const ROLE_VALUES = ['owner'] as const;

// One row per Privy DID. Lazily created on first authenticated request via
// bootstrapUser. We keep the raw Privy DID in audit_logs.actor and
// proposed_actions.proposed_by (as text) — JOINs to users.privy_did surface
// the rich row when needed. No destructive proposed_by backfill on M2.
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    privyDid: text('privy_did').notNull().unique(),
    // Nullable because Privy may issue identities (e.g., SIWE-only) without
    // an email claim. Populated when available from `verifyAuthToken`.
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // Updated on every bootstrap call. Useful for M3 quotas and last-seen UI.
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    // M2 PR 5 onboarding gate. `onboarded_at` non-null means the user
    // finished the wizard — middleware/server-page-auth let them into
    // /chat and /settings. Null means they're mid-onboarding (or
    // pre-PR-5; the migration backfills NOW() so they skip the wizard).
    // `onboarding_step` is 1..5 marking resume position; null when
    // onboarded_at is set, OR when the user has not started yet.
    onboardedAt: timestamp('onboarded_at', { withTimezone: true }),
    onboardingStep: smallint('onboarding_step'),
  },
  (t) => [index('users_privy_did_idx').on(t.privyDid)],
);

// One row per treasury. M2 ships personal treasuries only — every user gets
// exactly one auto-provisioned at first sign-in (in prod) or attached to the
// seed (in dev). M3 introduces invitations and team treasuries.
export const treasuries = pgTable(
  'treasuries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Default "Personal" for auto-provisioned treasuries. Seed treasury is
    // named "Seed". Future user-rename UI will pass through escapeHtml in
    // the bot.
    name: text('name').notNull(),
    walletAddress: text('wallet_address').notNull().unique(),
    turnkeySubOrgId: text('turnkey_sub_org_id').notNull(),
    // Turnkey's internal wallet UUID. Distinct from walletAddress (the
    // Solana base58). Nullable for the seed treasury — `TURNKEY_SIGN_WITH`
    // gives us the address but not the UUID; populated for new
    // provisioning where the admin API returns it.
    turnkeyWalletId: text('turnkey_wallet_id'),
    signerBackend: text('signer_backend').notNull().$type<'local' | 'turnkey'>(),
    // Telegram routing — null chatId means "no Telegram routing configured;
    // auto-approve only". approverIds defaults to empty array; treasury can
    // exist without approvers (and require_approval actions will park in
    // pending until config lands). Both editable via the settings page in
    // PR 3.
    telegramChatId: text('telegram_chat_id'),
    telegramApproverIds: text('telegram_approver_ids').array().notNull().default(sql`'{}'`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // Nullable for the seed treasury (no real owner at first; we don't
    // fabricate a synthetic system user). New user-created treasuries
    // populate this from the bootstrap caller.
    createdBy: uuid('created_by').references(() => users.id),
  },
  (t) => [
    index('treasuries_created_by_idx').on(t.createdBy),
    check('treasuries_signer_backend_chk', sql`${t.signerBackend} IN ('local', 'turnkey')`),
  ],
);

// (treasury_id, user_id) composite PK; cascade on either side. role is
// CHECK-constrained to a single value in M2 ('owner'); M3 drops the CHECK
// and adds 'approver' / 'viewer'.
export const treasuryMemberships = pgTable(
  'treasury_memberships',
  {
    treasuryId: uuid('treasury_id')
      .references(() => treasuries.id, { onDelete: 'cascade' })
      .notNull(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    role: text('role', { enum: ROLE_VALUES }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.treasuryId, t.userId] }),
    // (user_id, treasury_id) composite for the "list my treasuries" query.
    // The PK above gives the (treasury_id, user_id) lookup direction.
    index('treasury_memberships_user_treasury_idx').on(t.userId, t.treasuryId),
    // The text-column `enum` option above is TS-only — drizzle does not
    // emit a DB CHECK for it. Enforce 'owner' at the DB layer too so a
    // direct SQL write can't sneak in a future role value before the M3
    // migration adds 'approver' / 'viewer'. M3 drops this check.
    check('treasury_memberships_role_chk', sql`${t.role} = 'owner'`),
  ],
);

export const proposedActions = pgTable(
  'proposed_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // M2: every action belongs to a treasury. NOT NULL once Migration B
    // applies after the seed script backfills legacy rows. The drizzle
    // schema declares the final post-M2 shape; the migrations split the
    // nullable phase into A and the NOT NULL flip into B.
    //
    // ON DELETE: default (NO ACTION) is intentional. A treasury that has
    // ever proposed an action keeps an immutable history record — the FK
    // blocks treasury deletion until the operator explicitly archives or
    // reassigns these rows. Contrast with treasury_memberships and
    // policies, which CASCADE because they're configuration, not history.
    treasuryId: uuid('treasury_id')
      .references(() => treasuries.id)
      .notNull(),
    payload: jsonb('payload').$type<ProposedAction>().notNull(),
    status: actionStatus('status').notNull().default('pending'),
    amountUsdc: numeric('amount_usdc', { precision: 20, scale: 6 }).notNull(),
    venue: text('venue', { enum: VENUE_VALUES }).notNull(),
    proposedBy: text('proposed_by').notNull(),
    policyDecision: jsonb('policy_decision').$type<PolicyDecision>(),
    telegramMessageId: integer('telegram_message_id'),
    // Snapshotted from treasuries.telegram_chat_id at post time. Bot reads
    // this — not the latest treasury config — when editing the card after
    // execution. Without it, an owner reconfiguring the chat mid-flight
    // would silently break post-execution edits (the message_id only exists
    // in the original chat). Nullable: rows that were never posted (auto-
    // approved actions, or pending rows when the treasury had no chat
    // configured) leave it NULL.
    telegramChatId: text('telegram_chat_id'),
    // Persisted between sign and submit so a crash mid-broadcast can be
    // recovered by re-confirming the signature rather than re-submitting.
    // For rebalance actions this is the leg-2 (deposit) signature; the
    // leg-1 (withdraw) sig lives in `rebalance_intermediate_signature` below.
    txSignature: text('tx_signature'),
    // Rebalance-only: the leg-1 (withdraw) signature. NULL for single-leg
    // actions. The executor uses (intermediate IS NOT NULL, tx_signature IS
    // NULL) as the resume-leg-2 marker after a crash between legs.
    rebalanceIntermediateSignature: text('rebalance_intermediate_signature'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    executedAt: timestamp('executed_at', { withTimezone: true }),
  },
  (t) => [
    index('proposed_actions_status_idx').on(t.status),
    index('proposed_actions_created_at_idx').on(t.createdAt),
    index('proposed_actions_status_created_at_idx').on(t.status, t.createdAt),
    // (treasury_id, status) for the worker's per-treasury "pending" query
    // and the M3 history page's recent-activity view.
    index('proposed_actions_treasury_id_status_idx').on(t.treasuryId, t.status),
    // Defense in depth: the IS NULL CAS in setActionTxSignature already
    // prevents per-row reuse, but a unique partial index catches cross-row
    // collisions if the signer ever miscomputed a signature. Partial because
    // most rows have NULL tx_signature (pre-execution or pre-2B history).
    uniqueIndex('proposed_actions_tx_signature_uq')
      .on(t.txSignature)
      .where(sql`${t.txSignature} IS NOT NULL`),
    // Same defense for the leg-1 signature on rebalance.
    uniqueIndex('proposed_actions_rebalance_intermediate_signature_uq')
      .on(t.rebalanceIntermediateSignature)
      .where(sql`${t.rebalanceIntermediateSignature} IS NOT NULL`),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actionId: uuid('action_id')
      .references(() => proposedActions.id, { onDelete: 'cascade' })
      .notNull(),
    // Denormalized from the action so the worker's "approvals for treasury X"
    // query stays cheap (no JOIN). App-level enforcement keeps it consistent
    // with proposed_actions.treasury_id (we control all writes).
    // ON DELETE: default (NO ACTION) for the same reason as
    // proposed_actions.treasury_id — approvals are immutable history.
    treasuryId: uuid('treasury_id')
      .references(() => treasuries.id)
      .notNull(),
    approverTelegramId: text('approver_telegram_id').notNull(),
    decision: text('decision', { enum: DECISION_VALUES }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('approvals_action_id_idx').on(t.actionId),
    index('approvals_treasury_id_idx').on(t.treasuryId),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    actionId: uuid('action_id').references(() => proposedActions.id, { onDelete: 'set null' }),
    // Nullable: system-level events (e.g., a future `treasury_deleted`) may
    // legitimately have no associated treasury. For action-related events
    // it's denormalized from the action via the seed script's backfill and
    // by the writers in queries/actions.ts going forward.
    // ON DELETE: default (NO ACTION). Audit history outlives configuration
    // — same reasoning as proposed_actions.treasury_id. A future
    // treasury-archive flow either nulls this column or moves the row to a
    // historical schema before deleting the treasury.
    treasuryId: uuid('treasury_id').references(() => treasuries.id),
    actor: text('actor').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('audit_logs_action_id_idx').on(t.actionId),
    index('audit_logs_created_at_idx').on(t.createdAt),
    // (treasury_id, created_at desc) for the M3 history page filtered by
    // treasury and ordered most-recent-first.
    index('audit_logs_treasury_id_created_at_idx').on(t.treasuryId, t.createdAt),
  ],
);

// M2 policies are per-treasury. The legacy singleton CHECK + id PK are
// dropped in Migration B; the seed script backfills the existing
// `id='default'` row's `treasury_id` to the seed treasury before the PK swap.
export const policies = pgTable('policies', {
  treasuryId: uuid('treasury_id')
    .primaryKey()
    .references(() => treasuries.id, { onDelete: 'cascade' }),
  requireApprovalAboveUsdc: numeric('require_approval_above_usdc', {
    precision: 20,
    scale: 6,
  }).notNull(),
  maxSingleActionUsdc: numeric('max_single_action_usdc', { precision: 20, scale: 6 }).notNull(),
  maxAutoApprovedUsdcPer24h: numeric('max_auto_approved_usdc_per_24h', {
    precision: 20,
    scale: 6,
  }).notNull(),
  allowedVenues: text('allowed_venues', { enum: VENUE_VALUES }).array().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by'),
});

// Relations

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(treasuryMemberships),
  treasuriesCreated: many(treasuries),
}));

export const treasuriesRelations = relations(treasuries, ({ many, one }) => ({
  memberships: many(treasuryMemberships),
  policy: one(policies, {
    fields: [treasuries.id],
    references: [policies.treasuryId],
  }),
  creator: one(users, {
    fields: [treasuries.createdBy],
    references: [users.id],
  }),
}));

export const treasuryMembershipsRelations = relations(treasuryMemberships, ({ one }) => ({
  treasury: one(treasuries, {
    fields: [treasuryMemberships.treasuryId],
    references: [treasuries.id],
  }),
  user: one(users, {
    fields: [treasuryMemberships.userId],
    references: [users.id],
  }),
}));

export const policiesRelations = relations(policies, ({ one }) => ({
  treasury: one(treasuries, {
    fields: [policies.treasuryId],
    references: [treasuries.id],
  }),
}));

export const proposedActionsRelations = relations(proposedActions, ({ many, one }) => ({
  approvals: many(approvals),
  auditLogs: many(auditLogs),
  treasury: one(treasuries, {
    fields: [proposedActions.treasuryId],
    references: [treasuries.id],
  }),
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  action: one(proposedActions, {
    fields: [approvals.actionId],
    references: [proposedActions.id],
  }),
  treasury: one(treasuries, {
    fields: [approvals.treasuryId],
    references: [treasuries.id],
  }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  action: one(proposedActions, {
    fields: [auditLogs.actionId],
    references: [proposedActions.id],
  }),
  treasury: one(treasuries, {
    fields: [auditLogs.treasuryId],
    references: [treasuries.id],
  }),
}));

export type ProposedActionRow = typeof proposedActions.$inferSelect;
export type NewProposedActionRow = typeof proposedActions.$inferInsert;
export type ApprovalRow = typeof approvals.$inferSelect;
export type NewApprovalRow = typeof approvals.$inferInsert;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type NewAuditLogRow = typeof auditLogs.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type TreasuryRow = typeof treasuries.$inferSelect;
export type NewTreasuryRow = typeof treasuries.$inferInsert;
export type TreasuryMembershipRow = typeof treasuryMemberships.$inferSelect;
export type NewTreasuryMembershipRow = typeof treasuryMemberships.$inferInsert;
export type PolicyRow = typeof policies.$inferSelect;
export type NewPolicyRow = typeof policies.$inferInsert;
