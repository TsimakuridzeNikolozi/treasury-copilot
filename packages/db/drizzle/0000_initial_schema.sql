CREATE TYPE "public"."action_status" AS ENUM('pending', 'approved', 'denied', 'executed', 'failed');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_id" uuid NOT NULL,
	"approver_telegram_id" text NOT NULL,
	"decision" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"action_id" uuid,
	"actor" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proposed_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "action_status" DEFAULT 'pending' NOT NULL,
	"amount_usdc" numeric(20, 6) NOT NULL,
	"venue" text NOT NULL,
	"proposed_by" text NOT NULL,
	"policy_decision" jsonb,
	"telegram_message_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_id_proposed_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."proposed_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_id_proposed_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."proposed_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_action_id_idx" ON "approvals" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_id_idx" ON "audit_logs" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "proposed_actions_status_idx" ON "proposed_actions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "proposed_actions_created_at_idx" ON "proposed_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "proposed_actions_status_created_at_idx" ON "proposed_actions" USING btree ("status","created_at");