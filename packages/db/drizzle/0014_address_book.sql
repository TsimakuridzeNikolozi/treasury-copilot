-- M4 PR 2 — per-treasury address book.
--
-- Stores named recipients so the chat agent can resolve a label ("send
-- 100 to Acme") to a base58 address, AND so the policy engine can
-- bypass the approval gate for transfers above
-- `require_approval_above_usdc` when the recipient has been explicitly
-- pre-approved by the owner. The velocity cap still applies — a
-- pre-approved recipient cannot exhaust an unbounded daily budget.
--
-- Two unique constraints on the same parent column:
--   (treasury_id, recipient_address) — one entry per recipient.
--     Editing a row changes label/notes/pre_approved in place; the
--     address itself is immutable post-create (a new address = new entry).
--   (treasury_id, label) — labels are human pointers and must be
--     disambiguable inside a treasury, otherwise the chat
--     "send 100 to Acme" resolution is ambiguous.
--
-- `token_mint` defaults to USDC mainnet — the only mint the signer
-- accepts today. Kept as a column (not implied) so multi-asset support
-- later is a server-side gate, not a schema change.
--
-- ON DELETE cascade on treasury_id: deleting a treasury takes its
-- address book with it. Entries are configuration (the audit_logs
-- table is the history), mirroring policies / alert_subscriptions.

CREATE TABLE "address_book_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"treasury_id" uuid NOT NULL,
	"label" text NOT NULL,
	"recipient_address" text NOT NULL,
	"token_mint" text DEFAULT 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' NOT NULL,
	"notes" text,
	"pre_approved" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "address_book_entries" ADD CONSTRAINT "address_book_entries_treasury_id_treasuries_id_fk" FOREIGN KEY ("treasury_id") REFERENCES "public"."treasuries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "address_book_entries_treasury_id_created_at_idx" ON "address_book_entries" USING btree ("treasury_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "address_book_entries_treasury_address_uq" ON "address_book_entries" USING btree ("treasury_id","recipient_address");
--> statement-breakpoint
CREATE UNIQUE INDEX "address_book_entries_treasury_label_uq" ON "address_book_entries" USING btree ("treasury_id","label");
