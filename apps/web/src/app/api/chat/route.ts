import { env } from '@/env';
import { resolveActiveTreasury } from '@/lib/active-treasury';
import { type ModelProvider, isModelProvider, modelFor } from '@/lib/ai/model';
import { db } from '@/lib/db';
import { verifyBearer } from '@/lib/privy';
import { Connection, PublicKey } from '@solana/web3.js';
import { buildTools } from '@tc/agent-tools';
import { type UIMessage, convertToModelMessages, stepCountIs, streamText } from 'ai';
import { z } from 'zod';

// postgres-js uses Node APIs not available in the Edge runtime.
export const runtime = 'nodejs';
export const maxDuration = 60;
// Per-user resolution via cookie isn't part of Next 15's URL-based cache
// key. Force-dynamic so streaming responses don't accidentally cross
// users on a stale prerender.
export const dynamic = 'force-dynamic';

// Module-scoped Connection — read tools share one across requests; cheap and
// avoids re-resolving DNS / TLS each chat turn.
const connection = new Connection(env.SOLANA_RPC_URL, { commitment: 'confirmed' });

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

// Zod schema. UIMessage is a structured shape from the AI SDK — we trust
// the SDK's downstream parser there and only validate the fields we
// directly use server-side. `treasuryId` is the body-vs-cookie 409
// contract; missing / non-uuid 400s before reaching the cookie compare.
const ChatRequestSchema = z.object({
  messages: z.array(z.unknown()).min(1),
  provider: z.string().optional(),
  treasuryId: z.string().uuid('treasuryId must be a uuid'),
});

export async function POST(req: Request) {
  // The middleware already redirects/401s missing cookies, but only the
  // strict in-route check verifies the JWT signature, expiry, and issuer —
  // never trust a cookie's mere presence.
  const auth = await verifyBearer(req);
  if (!auth) return new Response('unauthorized', { status: 401 });

  const raw = await req.json().catch(() => null);
  const parsed = ChatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: 'invalid_body', detail: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { messages, provider, treasuryId: bodyTreasuryId } = parsed.data;

  // Resolve the active treasury via cookie + membership lookup. May
  // return a Set-Cookie if the cookie was present-but-invalid (resolver
  // re-points it to the user's first remaining membership).
  const resolved = await resolveActiveTreasury(req, db, auth.userId);
  if ('onboardingRequired' in resolved) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (resolved.setCookieHeader) headers['set-cookie'] = resolved.setCookieHeader;
    return new Response(JSON.stringify({ error: 'no_active_treasury' }), {
      status: 409,
      headers,
    });
  }

  // Body-vs-cookie 409: a stale tab whose remembered treasuryId doesn't
  // match the current cookie/membership. Force a reload so the client
  // re-renders with the correct activeTreasuryId.
  if (bodyTreasuryId !== resolved.treasury.id) {
    return Response.json({ error: 'active_treasury_changed' }, { status: 409 });
  }

  // Untrusted client input — fall back to the env default if it's missing or
  // not one of the supported providers.
  const effectiveProvider: ModelProvider = isModelProvider(provider)
    ? provider
    : env.MODEL_PROVIDER;

  const result = streamText({
    model: modelFor(effectiveProvider),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages as UIMessage[]),
    tools: buildTools(db, {
      proposedBy: auth.userId,
      modelProvider: effectiveProvider,
      connection,
      treasuryAddress: new PublicKey(resolved.treasury.walletAddress),
      treasuryId: resolved.treasury.id,
    }),
    // Allow the model to call a tool, observe the result, and respond — without
    // this the stream ends right after the first tool call.
    stopWhen: stepCountIs(5),
  });

  // Attach the resolver's Set-Cookie (when present) to the streaming
  // response so the browser updates `tc_active_treasury` on the same
  // request that returned the stale-cookie fallback.
  const response = result.toUIMessageStreamResponse();
  if (resolved.setCookieHeader) {
    response.headers.append('set-cookie', resolved.setCookieHeader);
  }
  return response;
}
