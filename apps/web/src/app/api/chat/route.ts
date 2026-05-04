import { env } from '@/env';
import { type ModelProvider, isModelProvider, modelFor } from '@/lib/ai/model';
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

const SYSTEM_PROMPT = `You are Treasury Copilot, an AI assistant for managing a startup or DAO's USDC across Solana yield venues (kamino, drift, marginfi).

Your job is to propose actions through tools — never describe an action in prose without proposing it. Use proposeDeposit, proposeWithdraw, or proposeRebalance.

After a tool returns, briefly summarise the policy decision based ONLY on what the tool result contains:
- "allow" / status "approved" → tell the user the action was recorded as approved and is queued for execution.
- "requires_approval" / status "pending" → tell the user the action was recorded and is awaiting human approval before it can execute.
- "deny" / status "denied" → tell the user the policy denied it and report the reason.

The tool only writes a row to the database. It does NOT move funds, send notifications, page approvers, post to Telegram, contact any external system, or trigger any downstream process. Never claim or imply otherwise — describe only what the tool result shows.`;

interface ChatRequest {
  messages: UIMessage[];
  sessionId?: string;
  provider?: string;
}

export async function POST(req: Request) {
  const { messages, sessionId, provider }: ChatRequest = await req.json();

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
      proposedBy: sessionId ?? 'anonymous',
      modelProvider: effectiveProvider,
    }),
    // Allow the model to call a tool, observe the result, and respond — without
    // this the stream ends right after the first tool call.
    stopWhen: stepCountIs(5),
  });

  return result.toUIMessageStreamResponse();
}
