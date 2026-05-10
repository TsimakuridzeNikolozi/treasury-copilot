-- M2 PR 3 — snapshot Telegram chat id onto the action row.
--
-- Bot writes this column when it posts the approval card; the post-execution
-- edit reads it back. Without the snapshot, an owner reconfiguring
-- treasuries.telegram_chat_id between post and execution would silently
-- break editMessageText (the message_id only exists in the original chat).
--
-- Nullable: pre-existing rows + auto-approved actions + rows that were
-- never posted (treasury had no chat configured at post time) leave it NULL.

ALTER TABLE "proposed_actions" ADD COLUMN "telegram_chat_id" text;
