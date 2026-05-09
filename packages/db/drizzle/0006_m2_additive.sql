-- M2 Migration A — additive only.
--
-- Creates the multi-tenant tables (users, treasuries, treasury_memberships)
-- and adds nullable `treasury_id` columns to existing tables. Does NOT yet
-- drop the policies singleton CHECK or rekey policies onto treasury_id —
-- those happen in Migration B (0007), after the seed script (db:seed-m2)
-- has populated a seed treasuries row and backfilled all treasury_id
-- columns + the legacy proposed_actions.payload jsonb.
--
-- Operator flow to upgrade from M1:
--   1) pnpm db:migrate    (applies 0006; 0007 will fail without seed)
--   2) pnpm db:seed-m2    (inserts seed + backfills)
--   3) pnpm db:migrate    (applies 0007)
--
-- For fresh installs with no M1 data, 0007 succeeds end-to-end without
-- requiring step 2; the seed script's idempotent insert can run at any time.

CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privy_did" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "users_privy_did_unique" UNIQUE("privy_did")
);
--> statement-breakpoint
CREATE INDEX "users_privy_did_idx" ON "users" USING btree ("privy_did");
--> statement-breakpoint
CREATE TABLE "treasuries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"wallet_address" text NOT NULL,
	"turnkey_sub_org_id" text NOT NULL,
	"turnkey_wallet_id" text,
	"signer_backend" text NOT NULL,
	"telegram_chat_id" text,
	"telegram_approver_ids" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "treasuries_wallet_address_unique" UNIQUE("wallet_address"),
	CONSTRAINT "treasuries_signer_backend_chk" CHECK ("treasuries"."signer_backend" IN ('local', 'turnkey'))
);
--> statement-breakpoint
ALTER TABLE "treasuries" ADD CONSTRAINT "treasuries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "treasuries_created_by_idx" ON "treasuries" USING btree ("created_by");
--> statement-breakpoint
CREATE TABLE "treasury_memberships" (
	"treasury_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treasury_memberships_treasury_id_user_id_pk" PRIMARY KEY("treasury_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "treasury_memberships" ADD CONSTRAINT "treasury_memberships_treasury_id_treasuries_id_fk" FOREIGN KEY ("treasury_id") REFERENCES "public"."treasuries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "treasury_memberships" ADD CONSTRAINT "treasury_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "treasury_memberships_user_treasury_idx" ON "treasury_memberships" USING btree ("user_id","treasury_id");
--> statement-breakpoint

-- Add NULLABLE treasury_id columns. Migration B sets NOT NULL on
-- proposed_actions and approvals after the seed script backfills them.
-- audit_logs.treasury_id stays nullable forever (system-level events).
ALTER TABLE "proposed_actions" ADD COLUMN "treasury_id" uuid;
--> statement-breakpoint
ALTER TABLE "proposed_actions" ADD CONSTRAINT "proposed_actions_treasury_id_treasuries_id_fk" FOREIGN KEY ("treasury_id") REFERENCES "public"."treasuries"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "proposed_actions_treasury_id_status_idx" ON "proposed_actions" USING btree ("treasury_id","status");
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "treasury_id" uuid;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_treasury_id_treasuries_id_fk" FOREIGN KEY ("treasury_id") REFERENCES "public"."treasuries"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "approvals_treasury_id_idx" ON "approvals" USING btree ("treasury_id");
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "treasury_id" uuid;
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_treasury_id_treasuries_id_fk" FOREIGN KEY ("treasury_id") REFERENCES "public"."treasuries"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "audit_logs_treasury_id_created_at_idx" ON "audit_logs" USING btree ("treasury_id","created_at");
--> statement-breakpoint

-- Add nullable treasury_id to policies. The PK swap (drop id PK, drop
-- singleton CHECK, promote treasury_id to PK) happens in Migration B
-- after the seed script populates this column on the existing row.
ALTER TABLE "policies" ADD COLUMN "treasury_id" uuid;
--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_treasury_id_treasuries_id_fk" FOREIGN KEY ("treasury_id") REFERENCES "public"."treasuries"("id") ON DELETE cascade ON UPDATE no action;
