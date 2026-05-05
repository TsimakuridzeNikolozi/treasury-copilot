import type { PolicyDecision, ProposedAction } from '@tc/types';
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  type ApprovalRow,
  type AuditLogRow,
  type NewApprovalRow,
  type NewAuditLogRow,
  type ProposedActionRow,
  approvals,
  auditLogs,
  proposedActions,
} from '../schema';

export type ActionStatus = ProposedActionRow['status'];

export type AuditActor = 'agent' | 'policy' | 'signer' | 'system' | { telegramId: string };

function actorString(actor: AuditActor): string {
  return typeof actor === 'string' ? actor : `tg:${actor.telegramId}`;
}

// Only `approved` actions are eligible for execution, so `failed` is reachable
// only from `approved` (signer hit an error). `pending → failed` is intentionally
// illegal: a still-pending action means no human (or policy) authorised it, so
// "failed execution" cannot have happened.
const LEGAL_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  pending: ['approved', 'denied'],
  approved: ['executed', 'failed'],
  denied: [],
  executed: [],
  failed: [],
};

function statusFromDecision(kind: PolicyDecision['kind']): ActionStatus {
  switch (kind) {
    case 'allow':
      return 'approved';
    case 'deny':
      return 'denied';
    case 'requires_approval':
      return 'pending';
  }
}

function venueFor(action: ProposedAction): ProposedActionRow['venue'] {
  switch (action.kind) {
    case 'deposit':
    case 'withdraw':
      return action.venue;
    case 'rebalance':
      return action.fromVenue;
  }
}

export interface InsertProposedActionInput {
  action: ProposedAction;
  decision: PolicyDecision;
  proposedBy: string;
  // Free-form context merged into the audit log payload (e.g., model provider,
  // chat session id). Not stored on the action row itself.
  meta?: Record<string, unknown>;
}

// Note: for `allow` decisions the action is stored twice (in `payload` and
// inside `policy_decision.action`). This is intentional — the policy_decision
// column is a self-contained permission slip the signer reads directly, so the
// action it authorises must travel with it.

export async function insertProposedAction(
  db: Db,
  input: InsertProposedActionInput,
): Promise<ProposedActionRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(proposedActions)
      .values({
        payload: input.action,
        amountUsdc: input.action.amountUsdc,
        venue: venueFor(input.action),
        proposedBy: input.proposedBy,
        policyDecision: input.decision,
        status: statusFromDecision(input.decision.kind),
      })
      .returning();
    if (!row) throw new Error('insertProposedAction: insert returned no row');

    const audit: NewAuditLogRow = {
      kind: 'action_proposed',
      actionId: row.id,
      actor: 'agent',
      payload: {
        action: input.action,
        decision: input.decision,
        ...(input.meta ?? {}),
      },
    };
    await tx.insert(auditLogs).values(audit);

    return row;
  });
}

export interface TransitionActionInput {
  id: string;
  from: ActionStatus;
  to: ActionStatus;
  actor: AuditActor;
  payload?: Record<string, unknown>;
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: ActionStatus,
    public readonly to: ActionStatus,
  ) {
    super(`illegal status transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export class TransitionConflictError extends Error {
  constructor(
    public readonly id: string,
    public readonly expected: ActionStatus,
    public readonly actualOrMissing: ActionStatus | null,
  ) {
    const found = actualOrMissing ?? 'missing';
    super(`transition conflict on ${id}: expected status ${expected}, found ${found}`);
    this.name = 'TransitionConflictError';
  }
}

// Inner transition logic, assumes the caller is already inside a transaction.
// Extracted so `recordApproval` can wrap the transition + the approvals insert
// in a single tx without nesting (Drizzle would create a savepoint, but it
// also forces an awkward `tx as Db` cast at the call site).
type TxLike = Parameters<Parameters<Db['transaction']>[0]>[0];

async function transitionActionInTx(
  tx: TxLike,
  input: TransitionActionInput,
): Promise<ProposedActionRow> {
  if (!LEGAL_TRANSITIONS[input.from].includes(input.to)) {
    throw new IllegalTransitionError(input.from, input.to);
  }

  const [row] = await tx
    .update(proposedActions)
    .set({
      status: input.to,
      ...(input.to === 'executed' ? { executedAt: new Date() } : {}),
    })
    .where(and(eq(proposedActions.id, input.id), eq(proposedActions.status, input.from)))
    .returning();

  if (!row) {
    const [current] = await tx
      .select({ status: proposedActions.status })
      .from(proposedActions)
      .where(eq(proposedActions.id, input.id))
      .limit(1);
    throw new TransitionConflictError(input.id, input.from, current?.status ?? null);
  }

  const audit: NewAuditLogRow = {
    kind: 'status_transition',
    actionId: row.id,
    actor: actorString(input.actor),
    payload: {
      from: input.from,
      to: input.to,
      ...(input.payload ? { extra: input.payload } : {}),
    },
  };
  await tx.insert(auditLogs).values(audit);

  return row;
}

export async function transitionAction(
  db: Db,
  input: TransitionActionInput,
): Promise<ProposedActionRow> {
  return db.transaction((tx) => transitionActionInTx(tx, input));
}

// Sum USDC of auto-approved actions still in flight or completed in [since, now].
//
// Filter rationale:
// - `policy_decision ->> 'kind' = 'allow'` keeps the auto-approved budget
//   separate from human-approved spend (a human's $50k action shouldn't poison
//   the next 24h of auto-approvals).
// - `failed` is excluded on the assumption that a failed execution moved no
//   funds. If partial execution ever becomes possible, this exclusion needs
//   revisiting — a half-executed action would silently free its slot in the cap.
//
// Caller is responsible for handling the read-then-write race: two parallel
// proposals can both observe the same total and both pass the cap. Tolerated
// today (max overshoot = one `requireApprovalAboveUsdc`); fix with a single
// transaction or an advisory lock when load demands it.
export async function sumAutoApprovedSince(db: Db, since: Date): Promise<string> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${proposedActions.amountUsdc}), 0)::text`,
    })
    .from(proposedActions)
    .where(
      and(
        inArray(proposedActions.status, ['approved', 'executed']),
        sql`${proposedActions.policyDecision} ->> 'kind' = 'allow'`,
        gte(proposedActions.createdAt, since),
      ),
    );
  return row?.total ?? '0';
}

// Find pending actions that haven't been posted to Telegram yet. The worker's
// poller calls this every few seconds; ordering by createdAt is FIFO so older
// actions don't get starved. `limit` keeps each tick bounded.
export async function findPendingForTelegram(db: Db, limit = 25): Promise<ProposedActionRow[]> {
  return db
    .select()
    .from(proposedActions)
    .where(and(eq(proposedActions.status, 'pending'), isNull(proposedActions.telegramMessageId)))
    .orderBy(asc(proposedActions.createdAt))
    .limit(limit);
}

export async function setTelegramMessageId(
  db: Db,
  actionId: string,
  telegramMessageId: number,
): Promise<void> {
  await db
    .update(proposedActions)
    .set({ telegramMessageId })
    .where(eq(proposedActions.id, actionId));
}

export interface RecordApprovalInput {
  actionId: string;
  approverTelegramId: string;
  decision: 'approve' | 'deny';
  // Free-form context merged into the audit payload (e.g., the approver's
  // username for at-a-glance log reading). Not stored on the approval row.
  meta?: Record<string, unknown>;
}

export interface RecordApprovalResult {
  approval: ApprovalRow;
  action: ProposedActionRow;
}

// Atomically record an approve/deny click and transition the action.
//
// Single transaction so the approval row and the status flip can't disagree:
// either both land or neither does. If the action isn't `pending` anymore (a
// peer approver beat us to it, or the row was deleted), `transitionAction`
// throws `TransitionConflictError` and the whole tx rolls back — including
// the approval row, which would otherwise lie about which click resolved it.
export async function recordApproval(
  db: Db,
  input: RecordApprovalInput,
): Promise<RecordApprovalResult> {
  const targetStatus: ActionStatus = input.decision === 'approve' ? 'approved' : 'denied';

  return db.transaction(async (tx) => {
    const [approval] = await tx
      .insert(approvals)
      .values({
        actionId: input.actionId,
        approverTelegramId: input.approverTelegramId,
        decision: input.decision,
      } satisfies NewApprovalRow)
      .returning();
    if (!approval) throw new Error('recordApproval: insert returned no row');

    const action = await transitionActionInTx(tx, {
      id: input.actionId,
      from: 'pending',
      to: targetStatus,
      actor: { telegramId: input.approverTelegramId },
      ...(input.meta ? { payload: input.meta } : {}),
    });

    return { approval, action };
  });
}

export type { AuditLogRow };
