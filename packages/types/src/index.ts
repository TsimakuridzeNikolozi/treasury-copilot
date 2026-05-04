import { z } from 'zod';

// TODO(phase-1): replace stubs with real domain types as the protocol/policy layer lands.

export const ProposedActionSchema = z.object({
  kind: z.literal('proposed-action'),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

export const PolicyDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allow') }),
  z.object({ kind: z.literal('deny'), reason: z.string() }),
  z.object({ kind: z.literal('requires_approval'), reason: z.string() }),
]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export interface ToolCall {
  name: string;
  input: unknown;
}
