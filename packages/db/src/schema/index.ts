import type { PolicyDecision, ProposedAction, Venue } from '@tc/types';
import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
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

export const proposedActions = pgTable(
  'proposed_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payload: jsonb('payload').$type<ProposedAction>().notNull(),
    status: actionStatus('status').notNull().default('pending'),
    amountUsdc: numeric('amount_usdc', { precision: 20, scale: 6 }).notNull(),
    venue: text('venue', { enum: VENUE_VALUES }).notNull(),
    proposedBy: text('proposed_by').notNull(),
    policyDecision: jsonb('policy_decision').$type<PolicyDecision>(),
    telegramMessageId: integer('telegram_message_id'),
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
    approverTelegramId: text('approver_telegram_id').notNull(),
    decision: text('decision', { enum: DECISION_VALUES }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('approvals_action_id_idx').on(t.actionId)],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    actionId: uuid('action_id').references(() => proposedActions.id, { onDelete: 'set null' }),
    actor: text('actor').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('audit_logs_action_id_idx').on(t.actionId),
    index('audit_logs_created_at_idx').on(t.createdAt),
  ],
);

export const proposedActionsRelations = relations(proposedActions, ({ many }) => ({
  approvals: many(approvals),
  auditLogs: many(auditLogs),
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  action: one(proposedActions, {
    fields: [approvals.actionId],
    references: [proposedActions.id],
  }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  action: one(proposedActions, {
    fields: [auditLogs.actionId],
    references: [proposedActions.id],
  }),
}));

export type ProposedActionRow = typeof proposedActions.$inferSelect;
export type NewProposedActionRow = typeof proposedActions.$inferInsert;
export type ApprovalRow = typeof approvals.$inferSelect;
export type NewApprovalRow = typeof approvals.$inferInsert;
export type AuditLogRow = typeof auditLogs.$inferSelect;
export type NewAuditLogRow = typeof auditLogs.$inferInsert;
