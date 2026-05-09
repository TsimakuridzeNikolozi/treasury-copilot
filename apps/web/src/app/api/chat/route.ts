import { env } from '@/env';
import { type ModelProvider, isModelProvider, modelFor } from '@/lib/ai/model';
import { verifyBearer } from '@/lib/privy';
import { Connection, PublicKey } from '@solana/web3.js';
import { buildTools } from '@tc/agent-tools';
import { createDb } from '@tc/db';
import { type UIMessage, convertToModelMessages, stepCountIs, streamText } from 'ai';

// postgres-js uses Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 60;

// Module-scoped so HMR and concurrent requests share one postgres pool. Calling
// createDb per request would open a fresh pool of 10 connections each time and
// exhaust Postgres `max_connections` within a few dev reloads.
const db = createDb(env.DATABASE_URL);

// Module-scoped Connection — read tools share one across requests; cheap and
// avoids re-resolving DNS / TLS each chat turn.
const connection = new Connection(env.SOLANA_RPC_URL, { commitment: 'confirmed' });
const treasuryAddress = new PublicKey(env.TREASURY_PUBKEY_BASE58);

const SYSTEM_PROMPT = `You are Treasury Copilot, an AI assistant for managing a startup or DAO's USDC across Solana yield venues (kamino, save).

You have read tools and proposal tools.

- For read intents ("show my positions", "what's my APY", "compare yields"), call \`getTreasurySnapshot\` and report the numbers. Render APYs as percentages with two decimals (e.g. 0.0523 → "5.23%").
- For write intents (deposit, withdraw, rebalance), use \`proposeDeposit\`, \`proposeWithdraw\`, or \`proposeRebalance\`. Never describe an action in prose without proposing it. Wallet addresses are configured server-side — do not ask the user for them and do not include them in the tool input (they are not part of the input schema).
- Before proposing a rebalance, ALWAYS call \`getTreasurySnapshot\` first so the user sees the supply + APY context that justifies the move.

After a proposal tool returns, briefly summarise the policy decision based ONLY on what the tool result contains:
- "allow" / status "approved" → tell the user the action was recorded as approved and is queued for execution.
- "requires_approval" / status "pending" → tell the user the action was recorded and is awaiting human approval before it can execute.
- "deny" / status "denied" → tell the user the policy denied it and report the reason.

The proposal tools only write a row to the database. They do NOT move funds, send notifications, page approvers, post to Telegram, contact any external system, or trigger any downstream process. Never claim or imply otherwise — describe only what the tool result shows.`;

interface ChatRequest {
  messages: UIMessage[];
  provider?: string;
}

export async function POST(req: Request) {
  // The middleware already redirects/401s missing cookies, but only the
  // strict in-route check verifies the JWT signature, expiry, and issuer —
  // never trust a cookie's mere presence.
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const { messages, provider }: ChatRequest = await req.json();

  // Untrusted client input — fall back to the env default if it's missing or
  // not one of the three supported providers.
  const effectiveProvider: ModelProvider = isModelProvider(provider)
    ? provider
    : env.MODEL_PROVIDER;

  const result = streamText({
    model: modelFor(effectiveProvider),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools: buildTools(db, {
      proposedBy: auth.userId,
      modelProvider: effectiveProvider,
      connection,
      treasuryAddress,
    }),
    // Allow the model to call a tool, observe the result, and respond — without
    // this the stream ends right after the first tool call.
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse();
}
