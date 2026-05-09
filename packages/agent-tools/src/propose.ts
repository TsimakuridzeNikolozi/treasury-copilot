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
  // Reader for the live on-chain state we need to validate a proposal
  // against reality (wallet USDC for deposits, venue position for withdraws
  // and rebalances). Injected so tests can stub it without RPC; production
  // callers get one from createRpcBalanceReader inside buildTools.
  balanceReader: BalanceReader;
}

export interface ProposeActionResult {
  row: ProposedActionRow;
  decision: PolicyDecision;
}

// Pre-flight balance check. Returns a deny decision when the action's
// source-of-funds doesn't have enough USDC to cover `amountUsdc`. Returns
// null when the balance is sufficient — caller keeps the original decision.
//
// The balance check exists because policy.evaluate() is intentionally
// stateless about on-chain reality: it only enforces caps and allowlists.
// Without this check, a "rebalance 0.5 from save" against a save position
// of 0.09 would (a) approve, (b) leg-1 partially withdraws what's there,
// (c) leg-2 still tries to deposit 0.5 to the destination — and the wallet
// silently covers the shortfall. That's a real-money footgun.
//
// Scope: this is a propose-time SANITY gate, not an execute-time guarantee.
// For `requires_approval` actions the proposal can sit in `pending` for
// minutes/hours before a human approves; balances drift in either direction
// in that window. The signer + on-chain instructions are the actual final
// word. Stale-balance failures still surface, just at execute time as a
// clean ExecuteResult.failure (the executor's existing path).
//
// Scope: USDC accounting only. SOL gas + ATA rent are the signer's
// problem — they're paid in lamports and don't intersect this check.
//
// Trust boundary: this can only DOWNGRADE allow → deny, never upgrade. The
// signer still accepts only allow decisions produced by policy.evaluate().
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
    case 'deposit': {
      // The signer can only spend from the treasury wallet (tools.ts
      // strips the AI-supplied `sourceWallet` and re-injects the
      // configured treasury address), and that's the address the
      // RpcBalanceReader is bound to. So the wallet's free USDC is
      // exactly the constraint regardless of what `action.sourceWallet`
      // says — we never read the action's field here.
      const available = await reader.walletUsdc();
      return { source: 'wallet', available };
    }
    case 'withdraw': {
      const available = await reader.positionUsdc(action.venue);
      return { source: action.venue, available };
    }
    case 'rebalance': {
      // The shortfall the user just hit: rebalance's withdraw leg sources
      // from `fromVenue`, not the wallet. Check the position there.
      const available = await reader.positionUsdc(action.fromVenue);
      return { source: action.fromVenue, available };
    }
  }
}

// Thin orchestrator: gathers velocity context, runs policy, performs a
// balance pre-flight, persists. The trust boundary holds because `evaluate`
// is the only producer of `allow` decisions and the balance check can only
// turn allow → deny, never the reverse.
//
// `policy` and `now` are injectable for tests; production callers pass
// neither and `policy` resolves to the singleton DB row (or DEFAULT_POLICY
// when the row is missing — `getPolicy` handles the fallback).
export async function proposeAction(
  db: Db,
  action: ProposedAction,
  ctx: ProposeContext,
  policy?: Policy,
  now: () => Date = () => new Date(),
): Promise<ProposeActionResult> {
  const since = new Date(now().getTime() - TWENTY_FOUR_HOURS_MS);
  // M2: per-treasury velocity cap and per-treasury policy lookup. Both
  // queries scope on action.treasuryId so each tenant has its own budget.
  const recentAutoApprovedUsdc = await sumAutoApprovedSince(db, action.treasuryId, since);
  const effectivePolicy = policy ?? (await getPolicy(db, action.treasuryId));

  let decision = evaluate(action, { recentAutoApprovedUsdc }, effectivePolicy);

  // Skip the RPC call when the proposal is already going to fail. Saves a
  // round-trip on doomed actions (over-cap, disallowed venue, etc.) and
  // keeps test suites that mock policy fast.
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
