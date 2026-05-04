---
name: grammy
description: grammy Telegram bot framework patterns — bot setup with long polling, inline keyboards for approve/deny callback flows, middleware for auth, error handling, and graceful shutdown. Use when working in `apps/worker/` on the Telegram approval bot. Triggers on "grammy", "telegram", "bot", "callback query", "inline keyboard", "approval bot", or any edits inside apps/worker/src/.
---

# grammy (Telegram Bot Framework)

> Canonical docs: https://grammy.dev — verify against latest when implementing. This skill captures patterns specific to the Treasury Copilot approval bot.

## Project context

The worker (`apps/worker`) is a long-running Node process on Railway. Its only job (phase-1) is the Telegram approval bot:

1. The web app's chat agent proposes a `requires_approval` action and writes a row to `proposed_actions`.
2. The worker polls (or is notified via DB) for pending actions and posts each one to a configured Telegram chat with **Approve** / **Deny** inline buttons.
3. An approver clicks a button → grammy receives a `callback_query` → the worker writes to `approvals`, transitions the `proposed_actions` row, and (if approved) hands off to `@tc/signer` to execute.
4. The worker edits the original Telegram message to show the resolution.

Long polling, not webhooks. Reasons: Railway gives us a stable process, no public URL needed, simpler ops, no signature-verification surface.

## Installation (when you build this)

```bash
pnpm --filter @tc/worker add grammy
```

`grammy` itself has no extra runtime deps. Plugins (`@grammyjs/conversations`, `@grammyjs/menu`, etc.) are separate packages.

## Minimum viable bot

```ts
// apps/worker/src/bot.ts
import { Bot } from 'grammy';
import { env } from './env';

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

bot.command('start', (ctx) => ctx.reply('Treasury Copilot approval bot. Awaiting actions.'));
bot.command('ping', (ctx) => ctx.reply('pong'));

bot.catch((err) => {
  console.error('[bot] unhandled error', err);
});
```

## The approval flow (the core of phase-1)

### Posting a pending action with approve/deny buttons

```ts
import { InlineKeyboard } from 'grammy';
import type { ProposedAction } from '@tc/db/schema';

export async function postApprovalRequest(action: ProposedAction): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text('✓ Approve', `approve:${action.id}`)
    .text('✗ Deny', `deny:${action.id}`);

  const text = formatActionMessage(action);  // pretty-printed action details

  const sent = await bot.api.sendMessage(env.TELEGRAM_APPROVAL_CHAT_ID, text, {
    reply_markup: keyboard,
    parse_mode: 'MarkdownV2',
  });

  // Persist the message id so we can edit it later when resolved.
  await db
    .update(proposedActions)
    .set({ telegramMessageId: sent.message_id })
    .where(eq(proposedActions.id, action.id));
}
```

Callback data limits: **64 bytes**. UUIDs (36 chars) + a short prefix fit. Anything longer, store in DB and reference by id.

### Handling the callback

```ts
bot.callbackQuery(/^(approve|deny):(.+)$/, async (ctx) => {
  const [, decision, actionId] = ctx.match;
  const approverTelegramId = String(ctx.from.id);

  // Acknowledge IMMEDIATELY — Telegram shows a loading spinner until you do.
  // Failure to acknowledge within ~10s causes the button to look broken.
  await ctx.answerCallbackQuery({ text: `Recording ${decision}...` });

  try {
    const result = await recordDecision({
      actionId,
      approverTelegramId,
      decision: decision as 'approve' | 'deny',
    });

    // Edit the original message to show the resolution.
    await ctx.editMessageText(formatResolvedMessage(result), {
      parse_mode: 'MarkdownV2',
      // Drop the inline keyboard — action is resolved.
    });
  } catch (err) {
    console.error('[bot] decision failed', err);
    await ctx.answerCallbackQuery({ text: 'Error recording decision', show_alert: true });
  }
});
```

**Always `answerCallbackQuery` first.** It's a Telegram requirement, not a nice-to-have. The button stays in a stuck "loading" state until acknowledged.

## Middleware

`bot.use(fn)` runs `fn` before any handler. Use it for cross-cutting concerns: auth, logging, rate limiting.

### Restricting the bot to one approval chat

```ts
const APPROVAL_CHAT_ID = env.TELEGRAM_APPROVAL_CHAT_ID;

bot.use(async (ctx, next) => {
  // Allow callback queries from approved users only (id check).
  if (ctx.callbackQuery) {
    const userId = ctx.from?.id;
    if (!userId || !isApprover(userId)) {
      await ctx.answerCallbackQuery({ text: 'Not authorized', show_alert: true });
      return;
    }
  }

  // Allow messages only from the configured approval chat.
  if (ctx.message && String(ctx.chat?.id) !== APPROVAL_CHAT_ID) {
    return;  // silently ignore — don't leak that the bot exists
  }

  await next();
});
```

Don't reply to unauthorized messages with "you're not allowed" — that confirms the bot exists to a stranger. Just `return` without calling `next()`.

### Allowlist helper

```ts
const APPROVERS = new Set(env.APPROVER_TELEGRAM_IDS.split(',').map(Number));
function isApprover(userId: number): boolean {
  return APPROVERS.has(userId);
}
```

Approvers should be configured via env (`APPROVER_TELEGRAM_IDS=12345,67890`) — never hardcoded.

## Filtering with `bot.on(...)` and `bot.chatType(...)`

```ts
bot.chatType('private').command('whoami', (ctx) => ctx.reply(`Your id: ${ctx.from.id}`));
bot.on('message:text', (ctx) => { /* only text messages */ });
bot.on(':new_chat_members', (ctx) => { /* people joining */ });
```

The filter syntax (`message:text`, `:new_chat_members`) is type-safe — `ctx` narrows to whatever the filter implies. Use this over manual `if (ctx.message?.text)` checks.

## Long polling and graceful shutdown

```ts
// apps/worker/src/index.ts
import { bot } from './bot';
import { env } from './env';
import { startActionPoller } from './poller';

console.log(`[worker] booting in ${env.NODE_ENV} mode`);

const stopPoller = startActionPoller();   // your DB poller for new pending actions

await bot.start({
  drop_pending_updates: env.NODE_ENV === 'development',
  onStart: (info) => console.log(`[worker] @${info.username} started`),
});

// bot.start() blocks until bot.stop() is called.

const shutdown = async (signal: string) => {
  console.log(`[worker] received ${signal}, shutting down`);
  stopPoller();
  await bot.stop();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

**`drop_pending_updates: true`** in dev so restarts don't replay every queued message. **`false` in prod** so a deploy doesn't lose approval clicks that arrived while the worker was restarting.

`bot.stop()` waits for in-flight updates to finish processing — Railway's graceful stop window (default 30s) is plenty.

## Error handling

```ts
import { GrammyError, HttpError } from 'grammy';

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[bot] error in update ${ctx.update.update_id}:`, err.error);

  if (err.error instanceof GrammyError) {
    // Telegram API rejected the request (e.g., chat not found, message too old to edit).
    console.error('[bot] telegram api error', err.error.description);
  } else if (err.error instanceof HttpError) {
    // Network failure reaching Telegram.
    console.error('[bot] network error', err.error);
  } else {
    // Bug in our handler.
    console.error('[bot] unknown error', err.error);
  }
});
```

Common `GrammyError` cases worth handling explicitly:
- `message is not modified` — you tried to `editMessageText` with the same content; ignore.
- `query is too old` — callback query expired (>48h); answer with a fresh message.
- `Bad Request: chat not found` — bot was kicked or chat id is wrong; alert the operator.

## Common pitfalls

### Forgetting `answerCallbackQuery`

The button shows a spinner forever. Always answer first, even if the work fails — `answerCallbackQuery({ text: 'Error', show_alert: true })`.

### Editing a message that's older than 48h

Telegram refuses. For long-lived approvals, reply with a fresh message instead of editing.

### Callback data over 64 bytes

Telegram silently truncates. Keep the encoded value short; use a UUID (36 chars) + small prefix, not JSON.

### Posting before bot is started

`bot.api.sendMessage(...)` works without `bot.start()` — it's just an HTTP call. But if you set up `bot.use()` middleware *after* `bot.start()`, those middlewares aren't registered. Wire all handlers and middleware before `bot.start()`.

### Deploying two worker instances

Long polling is single-consumer. If Railway scales to two replicas, both will fight for updates and you'll see duplicate processing. **Keep replicas at 1.** If you need HA, switch to webhooks with a load balancer (separate, more involved task).

### MarkdownV2 escape rules

Telegram's `MarkdownV2` requires escaping `_*[]()~\`>#+-=|{}.!`. Use a helper or grammy's `parse_mode: 'HTML'` (simpler escape rules — only `<`, `>`, `&`).

### Polling vs database notifications

Phase-1 can use a 5-second `setInterval` poll of `proposed_actions WHERE status = 'pending' AND telegram_message_id IS NULL`. When that becomes load-bearing, switch to Postgres `LISTEN/NOTIFY` (the `postgres` driver supports it) — pushes the new-action notification to the worker without polling.

## Treasury Copilot–specific patterns

**The bot is an output of policy decisions, not an input to them.** The bot collects approvals; it doesn't decide whether a thing is allowed. That logic lives in `@tc/policy`. Never put policy checks in the bot's middleware.

**The signer never lives in the worker process directly** — the worker writes `approvals.decision = 'approve'`, and a separate signer pipeline (could be in the worker, could be a future executor process) picks up approved actions and executes. Keep the signer call out of the bot handler so signing failures don't poison the bot.

**Logging**: every callback query handler should log the actor's Telegram id, the action id, and the decision. This is the user-visible part of the audit trail.
