import type { Connection, PublicKey } from '@solana/web3.js';
import { type Db, ensureSubscriptionsForTreasury, listSubscriptions } from '@tc/db';
import { getJupiterUsdcPosition, getJupiterUsdcSupplyApy } from '@tc/protocols/jupiter';
import { getKaminoUsdcPosition, getKaminoUsdcSupplyApy } from '@tc/protocols/kamino';
import { getSaveUsdcPosition, getSaveUsdcSupplyApy } from '@tc/protocols/save';
import { USDC_MINT_BASE58, getWalletUsdcBalance } from '@tc/protocols/usdc';
import {
  DepositActionSchema,
  RebalanceActionSchema,
  TransferActionSchema,
  WithdrawActionSchema,
} from '@tc/types';
import { tool } from 'ai';
import { z } from 'zod';
import { createRpcBalanceReader } from './balance';
import { type ProposeContext, proposeAction } from './propose';

// The AI never sets `kind` (implied by tool name), `treasuryId` (the
// active treasury — server-injected from the auth/cookie), or wallet
// fields (always the configured treasury — letting the AI propose them
// was a hallucination surface; we saw the model fill `So11111…112` from
// chat hints). The chat route injects ctx.treasuryAddress + ctx.treasuryId
// server-side in execute().
const DepositInput = DepositActionSchema.omit({
  kind: true,
  treasuryId: true,
  sourceWallet: true,
});
const WithdrawInput = WithdrawActionSchema.omit({
  kind: true,
  treasuryId: true,
  destinationWallet: true,
});
const RebalanceInput = RebalanceActionSchema.omit({
  kind: true,
  treasuryId: true,
  wallet: true,
});
// M4 PR 3 — transfer kind. `tokenMint` is also server-injected: today only
// USDC is supported, so letting the AI fill it would just add a
// hallucination surface (model picks SOL mint from chat context, etc.).
// When multi-asset support lands, this is the seam to widen — accept a
// mint or symbol from the AI and validate server-side.
//
// Without M4-2's address book, `recipientAddress` here MUST be a literal
// base58 Solana address — the @tc/types schema's regex enforces it. M4-2
// will add a sibling tool `proposeTransferByLabel` (or extend this one) to
// accept address-book labels.
const TransferInput = TransferActionSchema.omit({
  kind: true,
  treasuryId: true,
  sourceWallet: true,
  tokenMint: true,
});

// Inputs to buildTools — the chat route's view, before we derive the
// downstream ProposeContext (which needs a BalanceReader). Kept separate
// from ProposeContext so the route can stay ignorant of the reader detail.
export interface ToolContext {
  proposedBy: string;
  modelProvider: string;
  connection: Connection;
  treasuryAddress: PublicKey;
  // M2: the active treasury's id, server-injected from the auth/cookie.
  // Threaded into every proposed action so per-treasury policy + velocity
  // cap apply correctly. The AI never sees or sets this.
  treasuryId: string;
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
        'Propose a USDC deposit into a yield venue (kamino, save, jupiter). The treasury wallet is configured server-side; do not ask the user for it. Returns the policy decision.',
      inputSchema: DepositInput,
      execute: async (input) =>
        proposeAction(
          db,
          {
            kind: 'deposit',
            treasuryId: ctx.treasuryId,
            sourceWallet: treasuryBase58,
            ...input,
          },
          proposeCtx,
        ),
    }),
    proposeWithdraw: tool({
      description:
        'Propose a USDC withdrawal from a yield venue (kamino, save, jupiter). The destination is the treasury wallet, configured server-side; do not ask the user for it.',
      inputSchema: WithdrawInput,
      execute: async (input) =>
        proposeAction(
          db,
          {
            kind: 'withdraw',
            treasuryId: ctx.treasuryId,
            destinationWallet: treasuryBase58,
            ...input,
          },
          proposeCtx,
        ),
    }),
    proposeRebalance: tool({
      description:
        'Propose moving USDC from one yield venue to another (e.g., save → kamino). Allowed venues: kamino, save, jupiter. The wallet is the configured treasury; do not ask the user for it.',
      inputSchema: RebalanceInput,
      execute: async (input) =>
        proposeAction(
          db,
          {
            kind: 'rebalance',
            treasuryId: ctx.treasuryId,
            wallet: treasuryBase58,
            ...input,
          },
          proposeCtx,
        ),
    }),
    proposeTransfer: tool({
      description:
        "Propose sending USDC from the treasury wallet to an arbitrary external Solana address (payroll, vendor payment, on-chain settlement, etc.). The recipient MUST be a literal base58 Solana address (32-44 chars, no labels yet). Use this when the user asks to 'send', 'pay', 'wire', or 'transfer' USDC to someone — NOT for deposits/withdrawals to yield venues (those use proposeDeposit / proposeWithdraw). The source wallet and token mint are configured server-side (USDC only); do not ask the user for them. Optional `memo` (≤180 chars) attaches an on-chain note to the transfer; ask the user if they'd like to include one only when context suggests it (invoice number, payment reference, etc.).",
      inputSchema: TransferInput,
      execute: async (input) =>
        proposeAction(
          db,
          {
            kind: 'transfer',
            treasuryId: ctx.treasuryId,
            sourceWallet: treasuryBase58,
            tokenMint: USDC_MINT_BASE58,
            ...input,
          },
          proposeCtx,
        ),
    }),
    getTreasurySnapshot: tool({
      description:
        "Fetch the treasury's USDC wallet balance plus per-venue (kamino, save, jupiter) supplied position and current supply APY. Call this when the user asks to see positions or compare APYs, and ALWAYS call it before proposing a rebalance so the user has numbers to justify the move. Returns amounts as decimal-USDC strings (e.g. '5.234567') and APYs as fractional decimals (e.g. 0.0523 = 5.23%). The jupiter sub-fields may be null if the Jupiter Lend SDK is temporarily unavailable; treat null as 'data missing' rather than zero.",
      inputSchema: z.object({}),
      execute: async () => {
        // Kamino + Save are mature single-RPC reads; failure of any of them
        // should fail the whole snapshot loudly (the user would be acting
        // on partial data otherwise).
        const [walletUsdc, kaminoPos, kaminoApy, savePos, saveApy] = await Promise.all([
          getWalletUsdcBalance(ctx.connection, ctx.treasuryAddress),
          getKaminoUsdcPosition(ctx.connection, ctx.treasuryAddress),
          getKaminoUsdcSupplyApy(ctx.connection),
          getSaveUsdcPosition(ctx.connection, ctx.treasuryAddress),
          getSaveUsdcSupplyApy(ctx.connection),
        ]);

        // Jupiter Lend SDK is pre-1.0 and chains several sequential RPC
        // calls inside getLendingTokenDetails; isolate its failures so a
        // single hiccup doesn't take down the whole snapshot. If we
        // observe similar flakiness in Kamino/Save later, generalise —
        // for now Jupiter is the only venue that needs lenient treatment.
        // The sanity-range assertion in supplyRateBnToApyDecimal will
        // surface as a rejection reason in the console.warn below if the
        // SDK scale ever changes underneath us.
        const [jupiterPosResult, jupiterApyResult] = await Promise.allSettled([
          getJupiterUsdcPosition(ctx.connection, ctx.treasuryAddress),
          getJupiterUsdcSupplyApy(ctx.connection),
        ]);
        if (jupiterPosResult.status === 'rejected') {
          console.warn('[snapshot] jupiter position read failed:', jupiterPosResult.reason);
        }
        if (jupiterApyResult.status === 'rejected') {
          console.warn('[snapshot] jupiter apy read failed:', jupiterApyResult.reason);
        }

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
          jupiter: {
            suppliedUsdc:
              jupiterPosResult.status === 'fulfilled' ? jupiterPosResult.value.amountUsdc : null,
            supplyApy:
              jupiterApyResult.status === 'fulfilled' ? jupiterApyResult.value.apyDecimal : null,
          },
        };
      },
    }),
    getAlertConfig: tool({
      description:
        "Read-only listing of the user's proactive-alert subscriptions (yield_drift, idle_capital, anomaly, concentration, protocol_health). Call this when the user asks what alerts they have, whether something is enabled, or what their thresholds are. To CHANGE alert settings the user must visit /settings → Alerts (this tool cannot edit them — no write tool exists by design, alerts are sensitive config).",
      inputSchema: z.object({}),
      execute: async () => {
        await ensureSubscriptionsForTreasury(db, ctx.treasuryId);
        const rows = await listSubscriptions(db, ctx.treasuryId);
        return {
          treasuryId: ctx.treasuryId,
          subscriptions: rows.map((r) => ({
            kind: r.kind,
            enabled: r.enabled,
            config: r.config,
            updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
            updatedBy: r.updatedBy ?? null,
          })),
        };
      },
    }),
  } as const;
}
