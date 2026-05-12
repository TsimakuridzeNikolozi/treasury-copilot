import type { Connection, PublicKey } from '@solana/web3.js';
import {
  type Db,
  computeRunway,
  ensureSubscriptionsForTreasury,
  getFailureReasons,
  listAddressBookEntries,
  listSubscriptions,
  listTransactionHistory,
} from '@tc/db';
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
  // M4 PR 2: address-book-derived set of recipient addresses that bypass
  // the approval gate for transfers above `requireApprovalAboveUsdc`.
  // The velocity cap still applies. The chat route fetches this set
  // per-request (cheap — single SELECT scoped to the treasury) and
  // passes it through; tests can omit it (empty set is the same effect
  // as no pre-approvals).
  preApprovedRecipients?: ReadonlySet<string>;
  // M4 PR 2: every address-book recipient (superset of
  // preApprovedRecipients). Drives the requireAddressBookForTransfers
  // safety gate — transfers to addresses NOT in this set DENY when the
  // policy flag is on (default). The chat route fetches this alongside
  // preApprovedRecipients per request.
  addressBookRecipients?: ReadonlySet<string>;
}

// Per-request factory: `db` and `ctx` are baked into each tool's execute closure
// so handlers don't read globals. Call this once per chat request. The
// BalanceReader is built once here and shared across the propose tools so a
// rebalance proposal doesn't pay for two independent RPC clients.
export function buildTools(db: Db, ctx: ToolContext) {
  const treasuryBase58 = ctx.treasuryAddress.toBase58();
  const balanceReader = createRpcBalanceReader(ctx.connection, ctx.treasuryAddress);
  // Spread-thread the two M4-2 sets so undefined fields are omitted,
  // not explicit `undefined` — required by exactOptionalPropertyTypes.
  // proposeAction forwards both into EvaluateContext:
  //   preApprovedRecipients  → approval-bypass for over-threshold transfers
  //   addressBookRecipients  → requireAddressBookForTransfers gate
  const proposeCtx: ProposeContext = {
    proposedBy: ctx.proposedBy,
    modelProvider: ctx.modelProvider,
    balanceReader,
    ...(ctx.preApprovedRecipients !== undefined && {
      preApprovedRecipients: ctx.preApprovedRecipients,
    }),
    ...(ctx.addressBookRecipients !== undefined && {
      addressBookRecipients: ctx.addressBookRecipients,
    }),
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
    getAddressBook: tool({
      description:
        "Read-only listing of the treasury's address book entries (named recipients for outbound USDC transfers). Call this when the user names a recipient by label (e.g. 'send 100 to Acme') — resolve the label to its base58 address from this list, then call proposeTransfer with that address. Also useful for 'who's in my address book?' / 'what addresses are pre-approved?' queries. Labels are CASE-SENSITIVE: 'Acme Corp' and 'acme corp' are different entries. When the user types a label in mixed case ('send 100 to acme'), search this list and use the canonical label's recipientAddress; if no entry matches case-insensitively, ask the user to clarify or to add the recipient first. Entries with preApproved=true skip the approval card for transfers above the treasury's requireApprovalAboveUsdc cap (the 24h velocity budget still applies). To ADD, EDIT, or REMOVE entries the user must visit /settings → Address book — this tool is read-only by design.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await listAddressBookEntries(db, ctx.treasuryId);
        return {
          treasuryId: ctx.treasuryId,
          entries: rows.map((r) => ({
            id: r.id,
            label: r.label,
            recipientAddress: r.recipientAddress,
            tokenMint: r.tokenMint,
            notes: r.notes,
            preApproved: r.preApproved,
            createdAt: r.createdAt.toISOString(),
            // M4 PR 2 review #8 — surface updatedAt so the model can
            // answer "when did I last change Acme?" without a separate
            // tool. ISO string matches createdAt's shape.
            updatedAt: r.updatedAt.toISOString(),
          })),
        };
      },
    }),
    getTransactionHistory: tool({
      description:
        "Read-only listing of the treasury's recent proposed actions (deposit, withdraw, rebalance, transfer) — newest first. Call this when the user asks 'what did I do last week?', 'show my recent transfers', 'when did I deposit to kamino?', 'did the $5k to Acme go through?', etc. Optional filters: `kind` (one of deposit/withdraw/rebalance/transfer), `status` (one of pending/approved/executing/executed/failed/denied), `sinceDays` (look back window — server filters to actions created within that many days; omit for no time bound). `limit` defaults to 20 and caps at 50; for broad surveys prefer a larger limit + filter rather than multiple calls. Each entry includes `kind`, `status`, `amountUsdc`, `venue` (deposit/withdraw/rebalance), `toVenue` (rebalance only), `recipientAddress` + `recipientLabel` (transfer; label is resolved server-side from the current address book — if you see a label, prefer it in your response), `memo` (transfer), `txSignature` (executed/failed rows that broadcasted), `createdAt`, `executedAt`, and `failureReason` (failed rows only). This tool cannot edit history — it's purely a read.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).optional(),
        kind: z.enum(['deposit', 'withdraw', 'rebalance', 'transfer']).optional(),
        status: z
          .enum(['pending', 'approved', 'executing', 'denied', 'executed', 'failed'])
          .optional(),
        sinceDays: z.number().int().min(1).max(365).optional(),
      }),
      execute: async (input) => {
        // No cursor here — the chat tool returns one bounded slice per
        // call. If the model wants older actions it can ask the user
        // to bump `sinceDays` or `limit`.
        const rows = await listTransactionHistory(db, {
          treasuryId: ctx.treasuryId,
          limit: input.limit ?? 20,
          ...(input.kind && { kind: input.kind }),
          ...(input.status && { status: input.status }),
        });
        // sinceDays applied in JS (the DB query doesn't accept a time
        // floor — adding one to listTransactionHistory would muddy the
        // cursor pagination contract). Rows are already
        // createdAt-descending; truncate when we cross the boundary.
        const filtered = input.sinceDays
          ? (() => {
              const floor = Date.now() - input.sinceDays * 24 * 60 * 60 * 1000;
              const idx = rows.findIndex((r) => r.createdAt.getTime() < floor);
              return idx < 0 ? rows : rows.slice(0, idx);
            })()
          : rows;

        const failedIds = filtered.filter((r) => r.status === 'failed').map((r) => r.id);
        const [bookRows, failureReasons] = await Promise.all([
          listAddressBookEntries(db, ctx.treasuryId),
          failedIds.length > 0 ? getFailureReasons(db, failedIds) : Promise.resolve(new Map()),
        ]);
        const labels = new Map<string, string>();
        for (const b of bookRows) labels.set(b.recipientAddress, b.label);

        return {
          treasuryId: ctx.treasuryId,
          count: filtered.length,
          entries: filtered.map((r) => {
            const p = r.payload;
            const venue =
              p.kind === 'deposit' || p.kind === 'withdraw'
                ? p.venue
                : p.kind === 'rebalance'
                  ? p.fromVenue
                  : null;
            const toVenue = p.kind === 'rebalance' ? p.toVenue : null;
            const recipientAddress = p.kind === 'transfer' ? p.recipientAddress : null;
            const recipientLabel =
              p.kind === 'transfer' ? (labels.get(p.recipientAddress) ?? null) : null;
            const memo = p.kind === 'transfer' ? (p.memo ?? null) : null;
            return {
              id: r.id,
              kind: p.kind,
              status: r.status,
              amountUsdc: r.amountUsdc,
              venue,
              toVenue,
              recipientAddress,
              recipientLabel,
              memo,
              txSignature: r.txSignature,
              createdAt: r.createdAt.toISOString(),
              executedAt: r.executedAt ? r.executedAt.toISOString() : null,
              failureReason: r.status === 'failed' ? (failureReasons.get(r.id) ?? null) : null,
            };
          }),
        };
      },
    }),
    getRunway: tool({
      description:
        "Compute the treasury's runway: total liquid USDC (wallet + every yield-venue position) divided by the average daily outflow over the past `windowDays` (default 90). Call this when the user asks 'how long do I have', 'what's my runway', 'can I afford X', 'will I run out before Y', 'monthly burn', etc. Returns `totalLiquidUsdc`, `avgDailyOutflowUsdc`, `runwayMonths` (null when there's been zero outflow in the window — explain to the user that runway is indefinite at current spend), `windowDays` echoed back, and `asOf` ISO timestamp. For 'can I afford $X' style questions, compare X against totalLiquidUsdc directly AND mention the impact on runwayMonths (subtract X from totalLiquidUsdc, divide by avgDailyOutflowUsdc × 30). Outflow is the sum of executed `transfer` actions only — deposits and rebalances stay inside the treasury so they don't reduce runway.",
      inputSchema: z.object({
        windowDays: z.number().int().min(7).max(365).optional(),
      }),
      execute: async (input) => {
        const windowDays = input.windowDays ?? 90;
        // Position fan-out mirrors getTreasurySnapshot above: Kamino +
        // Save are mature and fail loud; Jupiter SDK is pre-1.0 and
        // wrapped in allSettled so its hiccups don't sink the runway
        // number. Wallet read always runs.
        const [walletUsdc, kaminoPos, savePos] = await Promise.all([
          getWalletUsdcBalance(ctx.connection, ctx.treasuryAddress),
          getKaminoUsdcPosition(ctx.connection, ctx.treasuryAddress),
          getSaveUsdcPosition(ctx.connection, ctx.treasuryAddress),
        ]);
        const [jupiterPosResult] = await Promise.allSettled([
          getJupiterUsdcPosition(ctx.connection, ctx.treasuryAddress),
        ]);
        if (jupiterPosResult.status === 'rejected') {
          console.warn('[runway] jupiter position read failed:', jupiterPosResult.reason);
        }
        const jupiterUsdc =
          jupiterPosResult.status === 'fulfilled' ? jupiterPosResult.value.amountUsdc : '0';

        return computeRunway(db, {
          treasuryId: ctx.treasuryId,
          walletUsdc: walletUsdc.amountUsdc,
          kaminoUsdc: kaminoPos.amountUsdc,
          saveUsdc: savePos.amountUsdc,
          jupiterUsdc,
          windowDays,
        });
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
