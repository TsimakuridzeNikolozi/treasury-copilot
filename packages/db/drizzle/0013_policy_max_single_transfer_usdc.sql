-- M4 PR 1 — per-treasury hard cap for `transfer` (and future
-- `transfer_batch`) actions.
--
-- The existing `max_single_action_usdc` cap (default $10k) is too tight
-- for transfers — a payroll-sized outflow would be hard-DENIED (not just
-- sent to approval). Carve out a separate cap so transfers can grow
-- independently while deposit/withdraw/rebalance keep their tighter
-- single-action ceiling.
--
-- Default $10,000 mirrors max_single_action_usdc — the operator
-- explicitly bumps this per-treasury once transfers are a real workflow.
-- NOT NULL + DEFAULT means every existing row is backfilled in-place
-- during the column add (Postgres >= 11 does this without a table rewrite).
--
-- Why a separate column and not "interpret max_single_action_usdc as
-- per-kind"? Because the existing cap's intent ("largest yield move I'll
-- ever auto-execute") is operationally distinct from "largest outflow
-- I'll ever sign". Bundling them would force every operator to widen one
-- to widen the other.

ALTER TABLE "policies"
  ADD COLUMN "max_single_transfer_usdc" numeric(20, 6) NOT NULL DEFAULT 10000;
