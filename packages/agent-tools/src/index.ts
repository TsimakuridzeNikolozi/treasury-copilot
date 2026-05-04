// TODO(phase-1): define Vercel AI SDK tools (rebalance, get_yields, propose_move, etc.)
// Each tool's handler MUST: (1) build a ProposedAction, (2) run it through `@tc/policy`,
// (3) hand only `allow` decisions to `@tc/signer`. The agent never touches the signer directly.

export const tools = [] as const;
