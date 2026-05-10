import type { ProposedActionRow } from '@tc/db';
import type { ExecuteResult } from '@tc/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks so they're available to vi.mock() factory callbacks.
const mocks = vi.hoisted(() => ({
  getTreasuryForRouting: vi.fn(),
  getActionById: vi.fn(),
  recordApproval: vi.fn(),
  sendMessage: vi.fn(),
  editMessageText: vi.fn(),
}));

// grammy's Bot is just a constructor; we substitute one whose `api` exposes
// the two methods bot.ts calls. The callback / command registrations
// happen during module load and are no-ops here.
vi.mock('grammy', () => {
  class Bot {
    api = {
      sendMessage: mocks.sendMessage,
      editMessageText: mocks.editMessageText,
    };
    command() {
      // no-op
    }
    callbackQuery() {
      // no-op
    }
    catch() {
      // no-op
    }
  }
  class InlineKeyboard {
    text() {
      return this;
    }
  }
  return { Bot, InlineKeyboard };
});

vi.mock('./env', () => ({
  env: { TELEGRAM_BOT_TOKEN: 'fake-token' },
}));

vi.mock('./db', () => ({
  db: {},
}));

vi.mock('@tc/db', async () => {
  // Re-export types as-is — the runtime values are stubbed via mocks.
  const actual = await vi.importActual<typeof import('@tc/db')>('@tc/db');
  return {
    ...actual,
    getTreasuryForRouting: mocks.getTreasuryForRouting,
    getActionById: mocks.getActionById,
    recordApproval: mocks.recordApproval,
  };
});

const { postApprovalCard, editApprovalCardWithExecution } = await import('./bot');

const TREASURY_ID = '00000000-0000-4000-8000-000000000aaa';
const ACTION_ID = '00000000-0000-4000-8000-0000000000bb';

function makeActionRow(overrides: Partial<ProposedActionRow> = {}): ProposedActionRow {
  return {
    id: ACTION_ID,
    treasuryId: TREASURY_ID,
    payload: {
      kind: 'deposit',
      treasuryId: TREASURY_ID,
      venue: 'kamino',
      amountUsdc: '5000',
      sourceWallet: 'So11111111111111111111111111111111111111112',
    },
    status: 'pending',
    amountUsdc: '5000.000000',
    venue: 'kamino',
    proposedBy: 'session',
    policyDecision: { kind: 'requires_approval', reason: 'over threshold' },
    telegramMessageId: null,
    telegramChatId: null,
    txSignature: null,
    rebalanceIntermediateSignature: null,
    createdAt: new Date(),
    executedAt: null,
    ...overrides,
  };
}

function treasuryCfg(chatId: string | null, approverIds: string[] = []) {
  return {
    id: TREASURY_ID,
    name: 'T',
    walletAddress: 'W11111111111111111111111111111111111111111',
    turnkeySubOrgId: 'sub',
    turnkeyWalletId: null,
    signerBackend: 'turnkey',
    telegramChatId: chatId,
    telegramApproverIds: approverIds,
    createdAt: new Date(),
    createdBy: null,
  };
}

beforeEach(() => {
  // Spy on console.warn so the once-per-boot warning assertion is observable
  // without polluting test output.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('postApprovalCard', () => {
  it('posts to the per-treasury chat id and returns the (messageId, chatId) snapshot pair', async () => {
    mocks.getTreasuryForRouting.mockResolvedValue(treasuryCfg('-1001'));
    mocks.sendMessage.mockResolvedValue({ message_id: 42 });

    const posted = await postApprovalCard(makeActionRow());
    expect(posted).toEqual({ messageId: 42, chatId: '-1001' });
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage.mock.calls[0]?.[0]).toBe('-1001');
  });

  it('returns null without calling sendMessage when chat id is null', async () => {
    mocks.getTreasuryForRouting.mockResolvedValue(treasuryCfg(null));

    const posted = await postApprovalCard(makeActionRow());
    expect(posted).toBeNull();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('warns once per boot for a treasury without chat configured', async () => {
    // Random id per run so the module-level warned-set in bot.ts is
    // guaranteed empty for this test. A hardcoded id would silently break
    // the assertion if any future test in this suite reuses it.
    const FRESH_TREASURY_ID = crypto.randomUUID();
    mocks.getTreasuryForRouting.mockImplementation(async () => ({
      id: FRESH_TREASURY_ID,
      name: 'T',
      walletAddress: 'W11111111111111111111111111111111111111111',
      turnkeySubOrgId: 'sub',
      turnkeyWalletId: null,
      signerBackend: 'turnkey',
      telegramChatId: null,
      telegramApproverIds: [],
      createdAt: new Date(),
      createdBy: null,
    }));
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>;
    warn.mockClear();

    await postApprovalCard(makeActionRow({ treasuryId: FRESH_TREASURY_ID }));
    await postApprovalCard(
      makeActionRow({
        treasuryId: FRESH_TREASURY_ID,
        id: '00000000-0000-4000-8000-0000000000cc',
      }),
    );
    // Second call with the same treasuryId shouldn't re-warn — the in-process
    // Set guards against tick-loop spam.
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('editApprovalCardWithExecution', () => {
  it('uses the snapshotted chat id, not the latest treasury config', async () => {
    // Row was originally posted to chat A; mid-flight, the treasury was
    // reconfigured to chat B. The edit must still target chat A.
    mocks.getTreasuryForRouting.mockResolvedValue(treasuryCfg('-2002')); // current cfg, irrelevant
    mocks.editMessageText.mockResolvedValue(undefined);

    const row = makeActionRow({ telegramMessageId: 42, telegramChatId: '-1001' });
    const result: ExecuteResult = { kind: 'success', txSignature: 'sig' };
    await editApprovalCardWithExecution(row, result, null);

    expect(mocks.editMessageText).toHaveBeenCalledTimes(1);
    expect(mocks.editMessageText.mock.calls[0]?.[0]).toBe('-1001');
    expect(mocks.editMessageText.mock.calls[0]?.[1]).toBe(42);
  });

  it('skips edit silently for an auto-approved row (no telegram routing)', async () => {
    const row = makeActionRow({
      telegramMessageId: null,
      telegramChatId: null,
      policyDecision: {
        kind: 'allow',
        action: makeActionRow().payload,
      },
    });
    const result: ExecuteResult = { kind: 'success', txSignature: 'sig' };
    await editApprovalCardWithExecution(row, result, null);
    expect(mocks.editMessageText).not.toHaveBeenCalled();
  });
});
