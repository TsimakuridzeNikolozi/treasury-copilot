import type { Connection, PublicKey } from '@solana/web3.js';
import type { Db } from '@tc/db';
import { getKaminoUsdcPosition, getKaminoUsdcSupplyApy } from '@tc/protocols/kamino';
import { getSaveUsdcPosition, getSaveUsdcSupplyApy } from '@tc/protocols/save';
import { getWalletUsdcBalance } from '@tc/protocols/usdc';
import { DepositActionSchema, RebalanceActionSchema, WithdrawActionSchema } from '@tc/types';
import { tool } from 'ai';
import { z } from 'zod';
import { createRpcBalanceReader } from './balance';
import { type ProposeContext, proposeAction } from './propose';

// The AI never sets `kind` (implied by tool name) or wallet fields (always
// the configured treasury — letting the AI propose them was a hallucination
// surface; we saw the model fill `So11111…112` from chat hints). The chat
// route injects ctx.treasuryAddress server-side in execute().
const DepositInput = DepositActionSchema.omit({ kind: true, sourceWallet: true });
const WithdrawInput = WithdrawActionSchema.omit({ kind: true, destinationWallet: true });
const RebalanceInput = RebalanceActionSchema.omit({ kind: true, wallet: true });

// Inputs to buildTools — the chat route's view, before we derive the
// downstream ProposeContext (which needs a BalanceReader). Kept separate
// from ProposeContext so the route can stay ignorant of the reader detail.
export interface ToolContext {
  proposedBy: string;
  modelProvider: string;
  connection: Connection;
  treasuryAddress: PublicKey;
}

// Per-request factory: `db` and `ctx` are baked into each tool's execute closure
// so handlers don't read globals. Call this once per chat request. The
// BalanceReader is built once here and shared across the propose tools so a
// rebalance proposal doesn't pay for two independent RPC clients.
export function buildTools(db: Db, ctx: ToolContext) {
  const treasuryBase58 = ctx.treasuryAddress.toBase58();
  const balanceReader = createRpcBalanceReader(ctx.connection, ctx.treasuryAddress);
  const proposeCtx: ProposeContext = {
    proposedBy: ctx.proposedBy,
    modelProvider: ctx.modelProvider,
    balanceReader,
  };
  return {
    proposeDeposit: tool({
      description:
        'Propose a USDC deposit into a yield venue (kamino, save). The treasury wallet is configured server-side; do not ask the user for it. Returns the policy decision.',
      inputSchema: DepositInput,
      execute: async (input) =>
        proposeAction(db, { kind: 'deposit', sourceWallet: treasuryBase58, ...input }, proposeCtx),
    }),
    proposeWithdraw: tool({
      description:
        'Propose a USDC withdrawal from a yield venue (kamino, save). The destination is the treasury wallet, configured server-side; do not ask the user for it.',
      inputSchema: WithdrawInput,
      execute: async (input) =>
        proposeAction(
          db,
          { kind: 'withdraw', destinationWallet: treasuryBase58, ...input },
          proposeCtx,
        ),
    }),
    proposeRebalance: tool({
      description:
        'Propose moving USDC from one yield venue to another (e.g., save → kamino). Allowed venues: kamino, save. The wallet is the configured treasury; do not ask the user for it.',
      inputSchema: RebalanceInput,
      execute: async (input) =>
        proposeAction(db, { kind: 'rebalance', wallet: treasuryBase58, ...input }, proposeCtx),
    }),
    getTreasurySnapshot: tool({
      description:
        "Fetch the treasury's USDC wallet balance plus per-venue (kamino, save) supplied position and current supply APY. Call this when the user asks to see positions or compare APYs, and ALWAYS call it before proposing a rebalance so the user has numbers to justify the move. Returns amounts as decimal-USDC strings (e.g. '5.234567') and APYs as fractional decimals (e.g. 0.0523 = 5.23%).",
      inputSchema: z.object({}),
      execute: async () => {
        const [walletUsdc, kaminoPos, kaminoApy, savePos, saveApy] = await Promise.all([
          getWalletUsdcBalance(ctx.connection, ctx.treasuryAddress),
          getKaminoUsdcPosition(ctx.connection, ctx.treasuryAddress),
          getKaminoUsdcSupplyApy(ctx.connection),
          getSaveUsdcPosition(ctx.connection, ctx.treasuryAddress),
          getSaveUsdcSupplyApy(ctx.connection),
        ]);
        return {
          treasuryAddress: ctx.treasuryAddress.toBase58(),
          usdcBalance: walletUsdc.amountUsdc,
          kamino: {
            suppliedUsdc: kaminoPos.amountUsdc,
            supplyApy: kaminoApy.apyDecimal,
          },
          save: {
            suppliedUsdc: savePos.amountUsdc,
            supplyApy: saveApy.apyDecimal,
          },
        };
      },
    }),
  } as const;
}
