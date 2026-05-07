import {
  type ApprovalAttribution,
  type ProposedActionRow,
  TransitionConflictError,
  recordApproval,
} from '@tc/db';
import type { ExecuteResult } from '@tc/types';
import { Bot, InlineKeyboard } from 'grammy';
import { db } from './db';
import { env } from './env';

const APPROVERS = new Set(env.APPROVER_TELEGRAM_IDS.split(',').map(Number));
const APPROVAL_CHAT_ID = env.TELEGRAM_APPROVAL_CHAT_ID;

function isApprover(userId: number): boolean {
  return APPROVERS.has(userId);
}

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

// Allowlist + chat scoping middleware. Run before any handler.
//
// Callback queries (button clicks) are restricted to the approver allowlist —
// anyone else clicking a button gets an alert and the handler doesn't run.
//
// Plain messages from chats other than the configured approval chat are
// silently dropped. We don't reply with "not authorized" because that would
// confirm the bot exists to a stranger who happened to find it.
bot.use(async (ctx, next) => {
  if (ctx.callbackQuery) {
    const userId = ctx.from?.id;
    if (!userId || !isApprover(userId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized', show_alert: true });
      return;
    }
    if (String(ctx.chat?.id) !== APPROVAL_CHAT_ID) {
      await ctx.answerCallbackQuery({ text: 'Not authorized', show_alert: true });
      return;
    }
  }
  if (ctx.message && String(ctx.chat?.id) !== APPROVAL_CHAT_ID) {
    return;
  }
  await next();
});

bot.command('ping', (ctx) => ctx.reply('pong'));
bot.command('whoami', (ctx) => ctx.reply(`Your Telegram id: ${ctx.from?.id}`));

// UUID v4 shape — action ids are uuid-defaultRandom in the schema. Tightening
// the regex means a malformed callback (we change the keyboard generator,
// someone pokes the bot manually) never reaches recordApproval as a no-op DB
// miss — it's silently rejected as an unmatched update instead.
bot.callbackQuery(
  /^(approve|deny):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  async (ctx) => {
    const decision = ctx.match[1] as 'approve' | 'deny';
    const actionId = ctx.match[2];
    if (!actionId) return;
    const approverId = ctx.from?.id;
    if (!approverId) return;

    // Acknowledge IMMEDIATELY — Telegram shows a spinner on the button until
    // the callback is answered. Do this before the DB work so a slow query
    // doesn't make the UI feel stuck.
    await ctx.answerCallbackQuery({ text: `Recording ${decision}…` });

    try {
      const { action } = await recordApproval(db, {
        actionId,
        approverTelegramId: String(approverId),
        decision,
        ...(ctx.from?.username ? { meta: { username: ctx.from.username } } : {}),
      });

      await ctx.editMessageText(formatResolved(action, decision, ctx.from?.username, approverId), {
        parse_mode: 'HTML',
      });
    } catch (err) {
      if (err instanceof TransitionConflictError) {
        // A peer approver beat us to it (or the row vanished). Reflect the
        // current state instead of pretending our click resolved it.
        await ctx
          .editMessageText(`<i>Already resolved (${err.actualOrMissing ?? 'missing'}).</i>`, {
            parse_mode: 'HTML',
          })
          .catch(() => {
            // editMessageText fails if the message is older than 48h or already
            // edited to identical content. Either way, nothing useful left to do.
          });
        return;
      }
      console.error('[bot] decision failed', err);
      // The callback was already answered at the top of the handler — Telegram
      // rejects a second answer for the same callback ID. Surface the error by
      // editing the card instead.
      await ctx
        .editMessageText('<i>Error recording decision. Please try again.</i>', {
          parse_mode: 'HTML',
        })
        .catch(() => {
          // editMessageText can fail (>48h, identical content). Diagnostics
          // are already logged above; nothing useful left to do.
        });
    }
  },
);

bot.catch((err) => {
  console.error(`[bot] error in update ${err.ctx.update.update_id}:`, err.error);
});

// --- formatting helpers ---

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function summaryLine(action: ProposedActionRow['payload']): string {
  switch (action.kind) {
    case 'deposit':
      return `<b>Deposit</b> ${action.amountUsdc} USDC → ${escapeHtml(action.venue)}`;
    case 'withdraw':
      return `<b>Withdraw</b> ${action.amountUsdc} USDC ← ${escapeHtml(action.venue)}`;
    case 'rebalance':
      return `<b>Rebalance</b> ${action.amountUsdc} USDC: ${escapeHtml(action.fromVenue)} → ${escapeHtml(action.toVenue)}`;
  }
}

export function formatPending(row: ProposedActionRow): string {
  const reason =
    row.policyDecision?.kind === 'requires_approval'
      ? row.policyDecision.reason
      : 'awaiting approval';
  return [
    summaryLine(row.payload),
    `<i>Reason: ${escapeHtml(reason)}</i>`,
    `<code>${row.id}</code>`,
  ].join('\n');
}

function formatResolved(
  row: ProposedActionRow,
  decision: 'approve' | 'deny',
  username: string | undefined,
  approverId: number,
): string {
  const verb = decision === 'approve' ? '✅ <b>Approved</b>' : '❌ <b>Denied</b>';
  const who = username ? `@${escapeHtml(username)}` : `id ${approverId}`;
  return [summaryLine(row.payload), `<code>${row.id}</code>`, '', `${verb} by ${who}`].join('\n');
}

function formatAttribution(attribution: ApprovalAttribution | null): string {
  if (!attribution) return 'unknown approver';
  return attribution.username
    ? `@${escapeHtml(attribution.username)}`
    : `id ${escapeHtml(attribution.approverTelegramId)}`;
}

// `pending` is excluded — the executor never edits the card in that case
// (the row stays `executing` for boot recovery). Narrowing here keeps the
// formatter total over the cases it actually renders.
type TerminalExecuteResult = Exclude<ExecuteResult, { kind: 'pending' }>;

function formatExecuted(
  row: ProposedActionRow,
  result: TerminalExecuteResult,
  attribution: ApprovalAttribution | null,
): string {
  const lines = [summaryLine(row.payload), `<code>${row.id}</code>`, ''];
  lines.push(`✅ <b>Approved</b> by ${formatAttribution(attribution)}`);
  if (result.kind === 'success') {
    lines.push(`⛓️ <b>Executed</b> <code>${escapeHtml(result.txSignature)}</code>`);
  } else {
    lines.push(`❌ <b>Failed</b>: <i>${escapeHtml(result.error)}</i>`);
  }
  return lines.join('\n');
}

// --- public API used by the poller and the executor ---

export async function postApprovalCard(row: ProposedActionRow): Promise<number> {
  const keyboard = new InlineKeyboard()
    .text('✅ Approve', `approve:${row.id}`)
    .text('❌ Deny', `deny:${row.id}`);

  const msg = await bot.api.sendMessage(APPROVAL_CHAT_ID, formatPending(row), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
  return msg.message_id;
}

export async function editApprovalCardWithExecution(
  row: ProposedActionRow,
  result: TerminalExecuteResult,
  attribution: ApprovalAttribution | null,
): Promise<void> {
  if (!row.telegramMessageId) {
    // Auto-approved rows (policy `allow`) never get a Telegram card — they go
    // straight from insert to status=approved. Skip silently. A missing id on
    // a `requires_approval` row is a real bug (manual DB edit, or a Telegram
    // approval path nobody told bot.ts about), so still surface that case.
    if (row.policyDecision?.kind !== 'allow') {
      console.warn(`[bot] action ${row.id} reached executor with no telegramMessageId`);
    }
    return;
  }
  await bot.api.editMessageText(
    APPROVAL_CHAT_ID,
    row.telegramMessageId,
    formatExecuted(row, result, attribution),
    { parse_mode: 'HTML' },
  );
}
