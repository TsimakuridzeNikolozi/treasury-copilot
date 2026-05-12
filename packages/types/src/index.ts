import { z } from 'zod';

export const VENUES = ['kamino', 'save', 'drift', 'marginfi', 'jupiter'] as const;
export const VenueSchema = z.enum(VENUES);
export type Venue = z.infer<typeof VenueSchema>;

const UsdcAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'amount must be a decimal string with up to 6 fraction digits');

export const SolanaAddressSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a base58 Solana address');

// M2 multi-tenancy: every action belongs to a treasury. The treasury id is
// a uuid; the chat tools strip-and-re-inject this server-side from the
// active-treasury cookie (same pattern as sourceWallet/destinationWallet).
// The AI never sets it — letting it would be a hallucination surface.
const TreasuryIdSchema = z.string().uuid();

export const DepositActionSchema = z.object({
  kind: z.literal('deposit'),
  treasuryId: TreasuryIdSchema,
  venue: VenueSchema,
  amountUsdc: UsdcAmountSchema,
  sourceWallet: SolanaAddressSchema,
});
export type DepositAction = z.infer<typeof DepositActionSchema>;

export const WithdrawActionSchema = z.object({
  kind: z.literal('withdraw'),
  treasuryId: TreasuryIdSchema,
  venue: VenueSchema,
  amountUsdc: UsdcAmountSchema,
  destinationWallet: SolanaAddressSchema,
});
export type WithdrawAction = z.infer<typeof WithdrawActionSchema>;

export const RebalanceActionSchema = z.object({
  kind: z.literal('rebalance'),
  treasuryId: TreasuryIdSchema,
  fromVenue: VenueSchema,
  toVenue: VenueSchema,
  amountUsdc: UsdcAmountSchema,
  // The wallet that holds the position. Both legs (withdraw fromVenue,
  // deposit toVenue) source/destination this address. Mirrors the
  // sourceWallet/destinationWallet pattern on deposit/withdraw — user-provided,
  // signer-verified per leg.
  wallet: SolanaAddressSchema,
});
export type RebalanceAction = z.infer<typeof RebalanceActionSchema>;

// M4 PR 1 — arbitrary outflow. Unlike deposit/withdraw/rebalance, transfer
// is venue-less: it moves USDC from the treasury wallet directly to a
// third-party address. Persisted as a `proposed_actions` row with `venue=NULL`
// (the column was made nullable in migration 0012).
//
// `tokenMint` is kept open in the schema (any base58 address) so future
// multi-asset support is a server-side gate, not a type change. The signer
// today rejects any mint other than USDC with a typed failure.
//
// `memo` is optional and capped at 180 chars to fit a single Solana memo ix
// without overflowing the tx size limit. UTF-8 — the on-chain memo program
// emits the bytes verbatim, no escaping.
export const TransferActionSchema = z.object({
  kind: z.literal('transfer'),
  treasuryId: TreasuryIdSchema,
  sourceWallet: SolanaAddressSchema,
  recipientAddress: SolanaAddressSchema,
  tokenMint: SolanaAddressSchema,
  amountUsdc: UsdcAmountSchema,
  memo: z.string().max(180).optional(),
});
export type TransferAction = z.infer<typeof TransferActionSchema>;

export const ProposedActionSchema = z
  .discriminatedUnion('kind', [
    DepositActionSchema,
    WithdrawActionSchema,
    RebalanceActionSchema,
    TransferActionSchema,
  ])
  .superRefine((data, ctx) => {
    if (data.kind === 'transfer' && data.recipientAddress === data.sourceWallet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'recipientAddress must differ from sourceWallet',
        path: ['recipientAddress'],
      });
    }
  });
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const PolicyDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allow'), action: ProposedActionSchema }),
  z.object({ kind: z.literal('deny'), reason: z.string() }),
  z.object({ kind: z.literal('requires_approval'), reason: z.string() }),
]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

// Outcome of `Signer.executeApproved`.
//
// `pending` is the ambiguous case: the tx was broadcast (so we have a
// signature) but the cluster's view is unsettled — either the confirmation
// race timed out and a follow-up status check returned `processed` / null,
// or for some other reason we can't yet say success or failure. The caller
// must NOT transition the row to a terminal state on `pending`; leave it in
// `executing` and let the next boot's recovery sweep finish it. Returning
// `failure` here would risk a double-execute if the tx eventually lands.
export const ExecuteResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('success'), txSignature: z.string() }),
  z.object({ kind: z.literal('failure'), error: z.string() }),
  z.object({ kind: z.literal('pending'), txSignature: z.string(), reason: z.string() }),
]);
export type ExecuteResult = z.infer<typeof ExecuteResultSchema>;

export interface ToolCall {
  name: string;
  input: unknown;
}
