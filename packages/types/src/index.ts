import { z } from 'zod';

export const VENUES = ['kamino', 'save', 'drift', 'marginfi'] as const;
export const VenueSchema = z.enum(VENUES);
export type Venue = z.infer<typeof VenueSchema>;

const UsdcAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'amount must be a decimal string with up to 6 fraction digits');

const SolanaAddressSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a base58 Solana address');

export const DepositActionSchema = z.object({
  kind: z.literal('deposit'),
  venue: VenueSchema,
  amountUsdc: UsdcAmountSchema,
  sourceWallet: SolanaAddressSchema,
});
export type DepositAction = z.infer<typeof DepositActionSchema>;

export const WithdrawActionSchema = z.object({
  kind: z.literal('withdraw'),
  venue: VenueSchema,
  amountUsdc: UsdcAmountSchema,
  destinationWallet: SolanaAddressSchema,
});
export type WithdrawAction = z.infer<typeof WithdrawActionSchema>;

export const RebalanceActionSchema = z.object({
  kind: z.literal('rebalance'),
  fromVenue: VenueSchema,
  toVenue: VenueSchema,
  amountUsdc: UsdcAmountSchema,
});
export type RebalanceAction = z.infer<typeof RebalanceActionSchema>;

export const ProposedActionSchema = z.discriminatedUnion('kind', [
  DepositActionSchema,
  WithdrawActionSchema,
  RebalanceActionSchema,
]);
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
