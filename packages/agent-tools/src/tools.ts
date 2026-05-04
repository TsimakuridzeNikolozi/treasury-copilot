import type { Db } from '@tc/db';
import { DepositActionSchema, RebalanceActionSchema, WithdrawActionSchema } from '@tc/types';
import { tool } from 'ai';
import { type ProposeContext, proposeAction } from './propose';

// The AI never sets `kind` — it's implied by the tool name. Stripping it from
// the input schema removes a hallucination surface.
const DepositInput = DepositActionSchema.omit({ kind: true });
const WithdrawInput = WithdrawActionSchema.omit({ kind: true });
const RebalanceInput = RebalanceActionSchema.omit({ kind: true });

// Per-request factory: `db` and `ctx` are baked into each tool's execute closure
// so handlers don't read globals. Call this once per chat request.
export function buildTools(db: Db, ctx: ProposeContext) {
  return {
    proposeDeposit: tool({
      description:
        'Propose a USDC deposit into a yield venue (kamino, drift, marginfi). Returns the policy decision.',
      inputSchema: DepositInput,
      execute: async (input) => proposeAction(db, { kind: 'deposit', ...input }, ctx),
    }),
    proposeWithdraw: tool({
      description: 'Propose a USDC withdrawal from a yield venue.',
      inputSchema: WithdrawInput,
      execute: async (input) => proposeAction(db, { kind: 'withdraw', ...input }, ctx),
    }),
    proposeRebalance: tool({
      description: 'Propose moving USDC from one yield venue to another (e.g., kamino → drift).',
      inputSchema: RebalanceInput,
      execute: async (input) => proposeAction(db, { kind: 'rebalance', ...input }, ctx),
    }),
  } as const;
}
