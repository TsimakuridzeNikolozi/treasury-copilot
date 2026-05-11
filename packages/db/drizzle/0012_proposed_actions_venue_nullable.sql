-- M4 PR 1 — `transfer` action kind support.
--
-- `transfer` rows have no venue: they move USDC from the treasury wallet
-- directly to a third party. The existing NOT NULL on proposed_actions.venue
-- would block such rows from being inserted. Drop it.
--
-- Deposit/withdraw/rebalance rows still populate the column via venueFor()
-- in packages/db/src/queries/actions.ts — only transfer rows produce NULL.
-- The existing CHECK on the text enum (VENUE_VALUES) is preserved.
--
-- Safe under load: DROP NOT NULL only updates the column's catalog flag;
-- it does NOT rewrite the table. No existing rows are affected (they all
-- have a venue today).

ALTER TABLE "proposed_actions" ALTER COLUMN "venue" DROP NOT NULL;
