-- M3 PR 1 — proactive intelligence foundation.
--
-- Adds two tables:
--   * notifications   — outbound non-approval messages (alerts, digests,
--                       anomaly callouts). Distinct from approval cards on
--                       proposed_actions.telegram_message_id; that path is
--                       human-in-the-loop, this one is fire-and-record.
--   * apy_snapshots   — cross-treasury, append-only APY time series.
--                       Hourly collector populates one row per wired
--                       venue per tick. Drift checks, idle nudges, and
--                       the weekly digest all read here instead of
--                       fanning out live SDK calls.
--
-- Plus one new enum:
--   * notification_status — queued | sent | failed | skipped.
--
-- No backfill needed (both tables start empty). Safe inside the migrator's
-- wrapping transaction.

CREATE TYPE "notification_status" AS ENUM ('queued', 'sent', 'failed', 'skipped');
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"treasury_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb,
	"channel" text DEFAULT 'telegram' NOT NULL,
	"telegram_chat_id" text,
	"telegram_message_id" integer,
	"dedupe_key" text,
	"status" "notification_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_treasury_id_treasuries_id_fk" FOREIGN KEY ("treasury_id") REFERENCES "public"."treasuries"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "notifications_treasury_id_created_at_idx" ON "notifications" USING btree ("treasury_id","created_at");
--> statement-breakpoint
-- Dedupe lookup index. Non-unique by design: the cooldown contract is
-- time-bounded (e.g. yield_drift can re-fire after 24h), so a hard UNIQUE
-- on (treasury_id, dedupe_key) would break re-sends. Time-window check
-- lives in findRecentByDedupeKey.
CREATE INDEX "notifications_dedupe_idx" ON "notifications" USING btree ("treasury_id","dedupe_key","created_at");
--> statement-breakpoint
CREATE INDEX "notifications_status_idx" ON "notifications" USING btree ("status");
--> statement-breakpoint
CREATE TABLE "apy_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"venue" text NOT NULL,
	"apy_decimal" numeric(10, 8) NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "apy_snapshots_venue_captured_at_idx" ON "apy_snapshots" USING btree ("venue","captured_at");
