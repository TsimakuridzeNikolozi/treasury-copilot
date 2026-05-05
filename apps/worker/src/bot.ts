import { type ProposedActionRow, TransitionConflictError, recordApproval } from '@tc/db';
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
  }
  if (ctx.message && String(ctx.chat?.id) !== APPROVAL_CHAT_ID) {
    return;
  }
  await next();
});

bot.command('ping', (ctx) => ctx.reply('pong'));
bot.command('whoami', (ctx) => ctx.reply(`Your Telegram id: ${ctx.from?.id}`));

bot.callbackQuery(/^(approve|deny):(.+)$/, async (ctx) => {
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

    await ctx.editMessageText(formatResolved(action, decision, ctx.from?.username), {
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
    await ctx.answerCallbackQuery({ text: 'Error recording decision', show_alert: true });
  }
});

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
      return `<b>Deposit</b> ${action.amountUsdc} USDC → ${action.venue}`;
    case 'withdraw':
      return `<b>Withdraw</b> ${action.amountUsdc} USDC ← ${action.venue}`;
    case 'rebalance':
      return `<b>Rebalance</b> ${action.amountUsdc} USDC: ${action.fromVenue} → ${action.toVenue}`;
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
): string {
  const verb = decision === 'approve' ? '✅ <b>Approved</b>' : '❌ <b>Denied</b>';
  const who = username ? `@${escapeHtml(username)}` : `id ${row.id}`;
  return [summaryLine(row.payload), `<code>${row.id}</code>`, '', `${verb} by ${who}`].join('\n');
}

// --- public API used by the poller ---

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
