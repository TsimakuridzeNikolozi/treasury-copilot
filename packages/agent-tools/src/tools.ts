import type { Connection, PublicKey } from '@solana/web3.js';
import type { Db } from '@tc/db';
import { getKaminoUsdcPosition, getKaminoUsdcSupplyApy } from '@tc/protocols/kamino';
import { getSaveUsdcPosition, getSaveUsdcSupplyApy } from '@tc/protocols/save';
import { getWalletUsdcBalance } from '@tc/protocols/usdc';
import { DepositActionSchema, RebalanceActionSchema, WithdrawActionSchema } from '@tc/types';
import { tool } from 'ai';
import { z } from 'zod';
import { type ProposeContext, proposeAction } from './propose';

// The AI never sets `kind` — it's implied by the tool name. Stripping it from
// the input schema removes a hallucination surface.
const DepositInput = DepositActionSchema.omit({ kind: true });
const WithdrawInput = WithdrawActionSchema.omit({ kind: true });
const RebalanceInput = RebalanceActionSchema.omit({ kind: true });

// Read-tool dependencies — connection (RPC) and the treasury address that
// reads default to. Composed with ProposeContext so a single object configures
// all tools without splitting them across two factories.
export interface ToolContext extends ProposeContext {
  connection: Connection;
  treasuryAddress: PublicKey;
}

// Per-request factory: `db` and `ctx` are baked into each tool's execute closure
// so handlers don't read globals. Call this once per chat request.
export function buildTools(db: Db, ctx: ToolContext) {
  return {
    proposeDeposit: tool({
      description:
        'Propose a USDC deposit into a yield venue (kamino, save). Returns the policy decision.',
      inputSchema: DepositInput,
      execute: async (input) => proposeAction(db, { kind: 'deposit', ...input }, ctx),
    }),
    proposeWithdraw: tool({
      description: 'Propose a USDC withdrawal from a yield venue.',
      inputSchema: WithdrawInput,
      execute: async (input) => proposeAction(db, { kind: 'withdraw', ...input }, ctx),
    }),
    proposeRebalance: tool({
      description: 'Propose moving USDC from one yield venue to another (e.g., kamino → save).',
      inputSchema: RebalanceInput,
      execute: async (input) => proposeAction(db, { kind: 'rebalance', ...input }, ctx),
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
