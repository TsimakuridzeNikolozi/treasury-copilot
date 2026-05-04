import type { PolicyDecision, ProposedAction } from '@tc/types';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client';
import {
  type AuditLogRow,
  type NewAuditLogRow,
  type ProposedActionRow,
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
      payload: { action: input.action, decision: input.decision },
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

export async function transitionAction(
  db: Db,
  input: TransitionActionInput,
): Promise<ProposedActionRow> {
  if (!LEGAL_TRANSITIONS[input.from].includes(input.to)) {
    throw new IllegalTransitionError(input.from, input.to);
  }

  return db.transaction(async (tx) => {
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
  });
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

export type { AuditLogRow };
