import {
  type Db,
  type ProposedActionRow,
  getPolicy,
  insertProposedAction,
  sumAutoApprovedSince,
} from '@tc/db';
import { type Policy, type PolicyDecision, evaluate } from '@tc/policy';
import type { ProposedAction } from '@tc/types';
import Decimal from 'decimal.js';
import type { BalanceReader } from './balance';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export interface ProposeContext {
  proposedBy: string;
  modelProvider: string;
  // Injected so tests can stub without RPC; production callers get one from buildTools.
  balanceReader: BalanceReader;
  // Pre-approved recipients (address book, M4-2). Bypasses the human
  // approval gate for transfers above requireApprovalAboveUsdc.
  preApprovedRecipients?: ReadonlySet<string>;
  // Every recipient in the treasury's address book (a superset of
  // preApprovedRecipients). Drives the requireAddressBookForTransfers
  // safety gate in @tc/policy.evaluate — when the gate is on (default),
  // transfers to addresses NOT in this set deny outright. Omit and the
  // policy engine treats the book as empty (fail-closed: every transfer
  // denies when the gate is on).
  addressBookRecipients?: ReadonlySet<string>;
}

export interface ProposeActionResult {
  row: ProposedActionRow;
  decision: PolicyDecision;
}

// Propose-time sanity gate — can only downgrade allow → deny, never upgrade.
// policy.evaluate() is stateless about on-chain balances; without this a
// rebalance from an underfunded venue would partially execute before failing.
async function denyForInsufficientBalance(
  action: ProposedAction,
  reader: BalanceReader,
): Promise<Extract<PolicyDecision, { kind: 'deny' }> | null> {
  const { source, available } = await readSourceBalance(action, reader);
  // decimal.js for parity with @tc/policy's evaluate() — a `parseFloat`
  // path would lose precision past 2^53, and UsdcAmountSchema's regex is
  // `^\d+(\.\d{1,6})?$` (integer part unbounded). decimal.js is already
  // in the dep graph via @tc/policy; declaring it here makes the
  // dependency explicit at the import site.
  if (new Decimal(available).gte(new Decimal(action.amountUsdc))) return null;
  return {
    kind: 'deny',
    reason: `insufficient balance: ${source} has ${available} USDC, action needs ${action.amountUsdc} USDC`,
  };
}

async function readSourceBalance(
  action: ProposedAction,
  reader: BalanceReader,
): Promise<{ source: string; available: string }> {
  switch (action.kind) {
    case 'deposit':
    case 'transfer': {
      const available = await reader.walletUsdc();
      return { source: 'wallet', available };
    }
    case 'withdraw': {
      const available = await reader.positionUsdc(action.venue);
      return { source: action.venue, available };
    }
    case 'rebalance': {
      const available = await reader.positionUsdc(action.fromVenue);
      return { source: action.fromVenue, available };
    }
  }
}

// `policy` and `now` are injectable for tests; production callers omit both.
export async function proposeAction(
  db: Db,
  action: ProposedAction,
  ctx: ProposeContext,
  policy?: Policy,
  now: () => Date = () => new Date(),
): Promise<ProposeActionResult> {
  const since = new Date(now().getTime() - TWENTY_FOUR_HOURS_MS);
  const recentAutoApprovedUsdc = await sumAutoApprovedSince(db, action.treasuryId, since);
  const effectivePolicy = policy ?? (await getPolicy(db, action.treasuryId));

  // Forward both M4-2 sets into the policy engine:
  //   - preApprovedRecipients gates the approval-bypass above
  //     requireApprovalAboveUsdc.
  //   - addressBookRecipients gates the requireAddressBookForTransfers
  //     deny (denies transfers to unknown addresses when on).
  // Both use the spread pattern so undefined fields are omitted, not
  // explicit `undefined` (exactOptionalPropertyTypes).
  let decision = evaluate(
    action,
    {
      recentAutoApprovedUsdc,
      ...(ctx.preApprovedRecipients !== undefined && {
        preApprovedRecipients: ctx.preApprovedRecipients,
      }),
      ...(ctx.addressBookRecipients !== undefined && {
        addressBookRecipients: ctx.addressBookRecipients,
      }),
    },
    effectivePolicy,
  );

  if (decision.kind !== 'deny') {
    const balanceDeny = await denyForInsufficientBalance(action, ctx.balanceReader);
    if (balanceDeny) decision = balanceDeny;
  }

  const row = await insertProposedAction(db, {
    action,
    decision,
    proposedBy: ctx.proposedBy,
    meta: { modelProvider: ctx.modelProvider },
  });

  return { row, decision };
}
