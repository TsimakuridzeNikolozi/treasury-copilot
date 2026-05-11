-- M3 PR 2 — per-treasury alert subscriptions.
--
-- One row per (treasury_id, kind). Backfilled with `enabled=false` for every
-- existing treasury × every alert kind currently shipping or planned, with
-- the M3-defined defaults in `config`. New treasuries created after this
-- migration get rows lazily — `getSubscription` returns the seeded default
-- when no row exists yet, and `upsertSubscription` fills it on the first
-- edit. The backfill is here (rather than in code) so the table is never
-- in a partially-seeded state from the worker's POV.
--
-- `enabled=false` is the safe default: nothing surprises users until they
-- visit /settings → Alerts and turn an alert on. Defaults match the plan:
--   yield_drift     { minDriftBps: 100, minOpportunityUsdcPerMonth: 25,
--                     sustainHours: 24, cooldownHours: 24 }
--   idle_capital    placeholder (M3-3 fills the runtime defaults)
--   anomaly         placeholder (M3-5)
--   concentration   placeholder (M5-1)
--   protocol_health placeholder (M5-2)
--
-- Why seed all five kinds now: lets each downstream PR (M3-3, M3-5, M5-1,
-- M5-2) ship without a migration of its own — just a SQL UPDATE to the
-- existing row's `config`. Keeps the per-treasury kind set fixed so the
-- settings form doesn't need a discover-then-render flow.

CREATE TABLE "alert_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"treasury_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "alert_subscriptions_kind_chk" CHECK ("kind" IN ('yield_drift', 'idle_capital', 'anomaly', 'concentration', 'protocol_health'))
);
--> statement-breakpoint
ALTER TABLE "alert_subscriptions" ADD CONSTRAINT "alert_subscriptions_treasury_id_treasuries_id_fk" FOREIGN KEY ("treasury_id") REFERENCES "public"."treasuries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "alert_subscriptions_treasury_kind_uq" ON "alert_subscriptions" USING btree ("treasury_id","kind");
--> statement-breakpoint
-- Backfill: one row per existing treasury × kind, disabled, with the
-- per-kind default config. INSERT … SELECT keeps the migration declarative
-- and avoids a separate seed step. Idempotent on re-run via the unique
-- index (ON CONFLICT DO NOTHING).
INSERT INTO "alert_subscriptions" ("treasury_id", "kind", "enabled", "config")
SELECT t.id, k.kind, false, k.default_config::jsonb
FROM "treasuries" t
CROSS JOIN (VALUES
	('yield_drift',     '{"minDriftBps":100,"minOpportunityUsdcPerMonth":25,"sustainHours":24,"cooldownHours":24}'),
	('idle_capital',    '{}'),
	('anomaly',         '{}'),
	('concentration',   '{}'),
	('protocol_health', '{}')
) AS k(kind, default_config)
ON CONFLICT ("treasury_id", "kind") DO NOTHING;
