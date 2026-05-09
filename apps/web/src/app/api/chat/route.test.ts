import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  resolveActiveTreasury: vi.fn(),
  buildTools: vi.fn(),
  streamText: vi.fn(),
  toUIMessageStreamResponse: vi.fn(),
}));

vi.mock('@/lib/privy', () => ({
  verifyBearer: mocks.verifyBearer,
  privy: {},
  PRIVY_COOKIE: 'privy-token',
}));

vi.mock('@/lib/active-treasury', () => ({
  resolveActiveTreasury: mocks.resolveActiveTreasury,
}));

vi.mock('@/env', () => ({
  env: {
    SOLANA_RPC_URL: 'http://localhost',
    MODEL_PROVIDER: 'anthropic',
  },
}));

vi.mock('@/lib/ai/model', () => ({
  modelFor: vi.fn(() => ({})),
  isModelProvider: () => true,
  MODEL_PROVIDERS: ['anthropic', 'openai'],
}));

vi.mock('@/lib/db', () => ({
  db: {},
}));

vi.mock('@tc/agent-tools', () => ({
  buildTools: mocks.buildTools,
}));

vi.mock('ai', () => ({
  streamText: () => ({
    toUIMessageStreamResponse: () =>
      new Response('streamed', { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  }),
  convertToModelMessages: async (m: unknown) => m,
  stepCountIs: (n: number) => n,
}));

const { POST } = await import('./route');

const TREASURY_ID = '00000000-0000-4000-8000-000000000aaa';

function chatReq(body: unknown): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/chat', () => {
  it('401 on missing bearer', async () => {
    mocks.verifyBearer.mockResolvedValue(null);
    const res = await POST(chatReq({ messages: [{ role: 'user' }], treasuryId: TREASURY_ID }));
    expect(res.status).toBe(401);
  });

  it('400 on malformed body (missing treasuryId)', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const res = await POST(chatReq({ messages: [{ role: 'user' }] }));
    expect(res.status).toBe(400);
  });

  it('400 on malformed body (non-uuid treasuryId)', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const res = await POST(chatReq({ messages: [{ role: 'user' }], treasuryId: 'not-a-uuid' }));
    expect(res.status).toBe(400);
  });

  it('409 no_active_treasury when resolver reports onboarding required', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({ onboardingRequired: true });
    const res = await POST(chatReq({ messages: [{ role: 'user' }], treasuryId: TREASURY_ID }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('no_active_treasury');
  });

  it('409 active_treasury_changed when body treasuryId mismatches resolved', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID, walletAddress: 'So11111111111111111111111111111111111111112' },
      role: 'owner',
    });
    const res = await POST(
      chatReq({
        messages: [{ role: 'user' }],
        treasuryId: '00000000-0000-4000-8000-00000000bbbb',
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('active_treasury_changed');
  });

  it('happy path streams a 200 response', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID, walletAddress: 'So11111111111111111111111111111111111111112' },
      role: 'owner',
    });
    mocks.buildTools.mockReturnValue({});
    const res = await POST(chatReq({ messages: [{ role: 'user' }], treasuryId: TREASURY_ID }));
    expect(res.status).toBe(200);
  });
});
