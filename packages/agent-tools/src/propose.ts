import {
  type Db,
  type ProposedActionRow,
  insertProposedAction,
  sumAutoApprovedSince,
} from '@tc/db';
import { DEFAULT_POLICY, type Policy, type PolicyDecision, evaluate } from '@tc/policy';
import type { ProposedAction } from '@tc/types';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export interface ProposeContext {
  proposedBy: string;
  modelProvider: string;
}

export interface ProposeActionResult {
  row: ProposedActionRow;
  decision: PolicyDecision;
}

// Thin orchestrator: gathers velocity context, runs policy, persists. The trust
// boundary holds because `evaluate` is the only producer of `allow` decisions.
// `policy` and `now` are injectable for tests.
export async function proposeAction(
  db: Db,
  action: ProposedAction,
  ctx: ProposeContext,
  policy: Policy = DEFAULT_POLICY,
  now: () => Date = () => new Date(),
): Promise<ProposeActionResult> {
  const since = new Date(now().getTime() - TWENTY_FOUR_HOURS_MS);
  const recentAutoApprovedUsdc = await sumAutoApprovedSince(db, since);

  const decision = evaluate(action, { recentAutoApprovedUsdc }, policy);

  const row = await insertProposedAction(db, {
    action,
    decision,
    proposedBy: ctx.proposedBy,
    meta: { modelProvider: ctx.modelProvider },
  });

  return { row, decision };
}
