import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyBearer: vi.fn(),
  resolveActiveTreasury: vi.fn(),
  updateTelegramConfig: vi.fn(),
}));

vi.mock('@/lib/privy', () => ({
  verifyBearer: mocks.verifyBearer,
  privy: {},
  PRIVY_COOKIE: 'privy-token',
}));

vi.mock('@/lib/active-treasury', () => ({
  resolveActiveTreasury: mocks.resolveActiveTreasury,
}));

vi.mock('@/lib/db', () => ({
  db: {},
}));

vi.mock('@tc/db', () => ({
  updateTelegramConfig: mocks.updateTelegramConfig,
}));

const { PATCH } = await import('./route');

const TREASURY_ID = '00000000-0000-4000-8000-000000000aaa';

const VALID_PATCH = {
  treasuryId: TREASURY_ID,
  telegramChatId: '-1001234567890',
  telegramApproverIds: ['111', '222'],
};

function patchReq(body: unknown): Request {
  return new Request('http://localhost/api/treasury/telegram-config', {
    method: 'PATCH',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/treasury/telegram-config', () => {
  it('401 on missing bearer', async () => {
    mocks.verifyBearer.mockResolvedValue(null);
    const res = await PATCH(patchReq(VALID_PATCH));
    expect(res.status).toBe(401);
  });

  it('400 on malformed chat_id', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const res = await PATCH(patchReq({ ...VALID_PATCH, telegramChatId: 'foo' }));
    expect(res.status).toBe(400);
  });

  it('400 on >50 approver ids', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const ids = Array.from({ length: 51 }, (_, i) => String(i + 1));
    const res = await PATCH(patchReq({ ...VALID_PATCH, telegramApproverIds: ids }));
    expect(res.status).toBe(400);
  });

  it('400 on non-numeric approver id', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const res = await PATCH(patchReq({ ...VALID_PATCH, telegramApproverIds: ['111', 'foo'] }));
    expect(res.status).toBe(400);
  });

  it('400 on too-short channel username', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    const res = await PATCH(patchReq({ ...VALID_PATCH, telegramChatId: '@x' }));
    expect(res.status).toBe(400);
  });

  it('403 when role is not owner', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      // M3 anticipated: M2 CHECK is 'owner' only, but the runtime gate is
      // wired now so this test stays meaningful when roles expand.
      role: 'approver',
    });
    const res = await PATCH(patchReq(VALID_PATCH));
    expect(res.status).toBe(403);
  });

  it('409 active_treasury_changed when body treasuryId mismatches resolved', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: '00000000-0000-4000-8000-00000000bbbb' },
      role: 'owner',
    });
    const res = await PATCH(patchReq(VALID_PATCH));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('active_treasury_changed');
  });

  it('204 on happy path; updateTelegramConfig called with the resolved treasury', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    const res = await PATCH(patchReq(VALID_PATCH));
    expect(res.status).toBe(204);
    expect(mocks.updateTelegramConfig).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        treasuryId: TREASURY_ID,
        chatId: '-1001234567890',
        approverIds: ['111', '222'],
        updatedBy: 'did:privy:x',
      }),
    );
  });

  it('null chat id is allowed (clears routing)', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    const res = await PATCH(patchReq({ ...VALID_PATCH, telegramChatId: null }));
    expect(res.status).toBe(204);
    expect(mocks.updateTelegramConfig).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ chatId: null }),
    );
  });

  it('@channel_username (valid) is accepted', async () => {
    mocks.verifyBearer.mockResolvedValue({ userId: 'did:privy:x' });
    mocks.resolveActiveTreasury.mockResolvedValue({
      treasury: { id: TREASURY_ID },
      role: 'owner',
    });
    const res = await PATCH(patchReq({ ...VALID_PATCH, telegramChatId: '@treasury_alerts' }));
    expect(res.status).toBe(204);
  });
});
