import {
  type ApprovalAttribution,
  type ProposedActionRow,
  TransitionConflictError,
  getActionById,
  getTreasuryForRouting,
  recordApproval,
} from '@tc/db';
import type { ExecuteResult } from '@tc/types';
import { Bot, InlineKeyboard } from 'grammy';
import { db } from './db';
import { env } from './env';

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

// `/whoami` is intentionally unscoped — operators legitimately use it during
// onboarding to find their numeric Telegram id (which they'll then paste into
// /settings → Telegram → Approvers). Replying with the user's own id to the
// user who asked isn't an info leak; finding the bot in the directory and
// running it is the same as visiting @userinfobot. We removed `/ping` because
// `pong` had no operator value and was the only command that confirmed the
// bot exists to a stranger without giving them anything they didn't ask for.
bot.command('whoami', (ctx) => ctx.reply(`Your Telegram id: ${ctx.from?.id}`));

// UUID v4 shape — action ids are uuid-defaultRandom in the schema. Tightening
// the regex means a malformed callback (we change the keyboard generator,
// someone pokes the bot manually) never reaches recordApproval as a no-op DB
// miss — it's silently rejected as an unmatched update instead.
//
// Per-callback authorization (PR 3): the bot was previously gated by a
// global APPROVER_TELEGRAM_IDS allowlist. Routing is now per-treasury, so
// authorization runs *inside* the handler — load the action row, look up
// the treasury's approver list, accept the click only if the clicker is in
// it. A single bot instance can serve multiple treasuries with disjoint
// approver groups.
bot.callbackQuery(
  /^(approve|deny):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  async (ctx) => {
    const decision = ctx.match[1] as 'approve' | 'deny';
    const actionId = ctx.match[2];
    if (!actionId) return;
    const approverId = ctx.from?.id;
    if (!approverId) return;

    // Look up the action's treasury_id, then the treasury's approver list.
    // The original handler skipped this read and authorized against a
    // module-level set; with per-treasury routing we need the row first.
    const action = await getActionById(db, actionId);
    if (!action) {
      await ctx.answerCallbackQuery({ text: 'Action not found', show_alert: true });
      return;
    }
    const cfg = await getTreasuryForRouting(db, action.treasuryId);
    if (!cfg) {
      // Treasury vanished between proposal and click. FKs (NO ACTION) make
      // this impossible in M2 — log it so an operator catches the
      // surprise during M3 when delete UX lands. The toast intentionally
      // matches the unauthorized case (avoids leaking treasury existence).
      console.error(
        `[bot] treasury ${action.treasuryId} not found for action ${actionId}; rejecting click`,
      );
      await ctx.answerCallbackQuery({
        text: 'Not authorized for this treasury',
        show_alert: true,
      });
      return;
    }
    // Compare as strings to match the storage shape: telegram_approver_ids
    // is text[]. Telegram user ids fit in JS Number safely today, but the
    // storage shape is the contract — Set lookup is also O(1) vs. parse +
    // filter + linear scan.
    const approverIds = new Set(cfg.telegramApproverIds);
    if (!approverIds.has(String(approverId))) {
      await ctx.answerCallbackQuery({
        text: 'Not authorized for this treasury',
        show_alert: true,
      });
      return;
    }

    // Acknowledge IMMEDIATELY — Telegram shows a spinner on the button until
    // the callback is answered. Do this before the DB work so a slow query
    // doesn't make the UI feel stuck.
    await ctx.answerCallbackQuery({ text: `Recording ${decision}…` });

    try {
      const { action: updated } = await recordApproval(db, {
        actionId,
        approverTelegramId: String(approverId),
        decision,
        ...(ctx.from?.username ? { meta: { username: ctx.from.username } } : {}),
      });

      await ctx.editMessageText(formatResolved(updated, decision, ctx.from?.username, approverId), {
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

// Truncate a base58 address for display: first 6 + last 6 chars. 6+6 gives
// the approver enough entropy to visually distinguish addresses; full address
// is available on click-to-copy.
function shortAddr(addr: string): string {
  return addr.length <= 16 ? addr : `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

function summaryLine(action: ProposedActionRow['payload']): string {
  switch (action.kind) {
    case 'deposit':
      return `<b>Deposit</b> ${action.amountUsdc} USDC → ${escapeHtml(action.venue)}`;
    case 'withdraw':
      return `<b>Withdraw</b> ${action.amountUsdc} USDC ← ${escapeHtml(action.venue)}`;
    case 'rebalance':
      // Wallet line included for transparency — rebalance touches funds in
      // the wallet (withdraw → wallet ATA → deposit), and the approver
      // should see the address being signed for.
      return [
        `<b>Rebalance</b> ${action.amountUsdc} USDC: ${escapeHtml(action.fromVenue)} → ${escapeHtml(action.toVenue)}`,
        `<i>wallet</i> <code>${escapeHtml(action.wallet)}</code>`,
      ].join('\n');
    case 'transfer': {
      // M4 PR 1 — transfer card. Includes the source wallet line
      // (mirrors rebalance) — transfer is the highest-risk action type
      // (arbitrary outflow to a third-party address), and the approver
      // needs to see which wallet they're authorising a debit from
      // before clicking approve. The recipient is truncated by shortAddr;
      // full address-book label resolution lands with M4-2.
      const lines = [
        `<b>Transfer</b> ${action.amountUsdc} USDC → <code>${escapeHtml(shortAddr(action.recipientAddress))}</code>`,
        `<i>to</i> <code>${escapeHtml(action.recipientAddress)}</code>`,
        `<i>wallet</i> <code>${escapeHtml(action.sourceWallet)}</code>`,
      ];
      if (action.memo !== undefined && action.memo.length > 0) {
        lines.push(`<i>memo</i> ${escapeHtml(action.memo)}`);
      }
      return lines.join('\n');
    }
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

// Set of treasury ids we've already warned about for missing chat config.
// findPendingForTelegram filters those rows out at the query level, so this
// path normally never fires — but it's a defense-in-depth log if a row
// somehow slips through (race between query and update, future code change).
// The Set bound is per-process: a worker reboot resets it, which is fine.
const warnedNoChatTreasuries = new Set<string>();

// Returns null when the treasury has no chat configured (poller short-circuits
// without persisting a message id, row stays pending); otherwise the
// (messageId, chatId) pair the poller snapshots onto the row via
// setTelegramRouting.
export async function postApprovalCard(
  row: ProposedActionRow,
): Promise<{ messageId: number; chatId: string } | null> {
  const cfg = await getTreasuryForRouting(db, row.treasuryId);
  const chatId = cfg?.telegramChatId ?? null;
  if (!chatId) {
    if (!warnedNoChatTreasuries.has(row.treasuryId)) {
      console.warn(
        `[bot] treasury ${row.treasuryId} has no telegram_chat_id; action ${row.id} stays pending until configured`,
      );
      warnedNoChatTreasuries.add(row.treasuryId);
    }
    return null;
  }
  // Owner just configured a chat after a previous miss — clear the warned
  // flag so a subsequent reconfig-to-null logs once again.
  warnedNoChatTreasuries.delete(row.treasuryId);

  const keyboard = new InlineKeyboard()
    .text('✅ Approve', `approve:${row.id}`)
    .text('❌ Deny', `deny:${row.id}`);

  const msg = await bot.api.sendMessage(chatId, formatPending(row), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
  return { messageId: msg.message_id, chatId };
}

// Non-approval message helper. Same chat transport as postApprovalCard
// (`bot.api.sendMessage`) but without the inline approve/deny keyboard —
// used by the M3 notification dispatcher (yield-drift alerts, idle-capital
// nudges, weekly digest, anomaly callouts). HTML parse mode matches the
// approval card formatter so message bodies can include the same escapeHtml
// inline-tag style.
export async function sendPlainMessage(
  chatId: string,
  htmlBody: string,
): Promise<{ messageId: number; chatId: string }> {
  const msg = await bot.api.sendMessage(chatId, htmlBody, { parse_mode: 'HTML' });
  return { messageId: msg.message_id, chatId };
}

export async function editApprovalCardWithExecution(
  row: ProposedActionRow,
  result: TerminalExecuteResult,
  attribution: ApprovalAttribution | null,
): Promise<void> {
  if (!row.telegramMessageId || !row.telegramChatId) {
    // Auto-approved rows (policy `allow`) never get a Telegram card — they go
    // straight from insert to status=approved. Skip silently. A missing id on
    // a `requires_approval` row is a real bug (manual DB edit, or a Telegram
    // approval path nobody told bot.ts about), so still surface that case.
    if (row.policyDecision?.kind !== 'allow') {
      console.warn(
        `[bot] action ${row.id} reached executor with no telegram routing (messageId=${row.telegramMessageId}, chatId=${row.telegramChatId})`,
      );
    }
    return;
  }
  // Use the snapshotted chat id (PR 3): the row carries the chat the message
  // was originally posted to, so an owner reconfiguring the treasury's
  // chat_id mid-flight doesn't break this edit.
  await bot.api.editMessageText(
    row.telegramChatId,
    row.telegramMessageId,
    formatExecuted(row, result, attribution),
    { parse_mode: 'HTML' },
  );
}
