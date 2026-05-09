CREATE TABLE "policies" (
	"id" text PRIMARY KEY NOT NULL,
	"require_approval_above_usdc" numeric(20, 6) NOT NULL,
	"max_single_action_usdc" numeric(20, 6) NOT NULL,
	"max_auto_approved_usdc_per_24h" numeric(20, 6) NOT NULL,
	"allowed_venues" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "policies_singleton" CHECK ("policies"."id" = 'default')
);
