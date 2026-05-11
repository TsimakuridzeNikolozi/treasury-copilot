-- M4 PR 2 — safety gate that blocks transfers to addresses NOT in the
-- per-treasury address book.
--
-- Default TRUE so the safer behavior applies on day one, including to
-- pre-existing policy rows (Postgres backfills NOT NULL DEFAULT in-place
-- on add-column for non-volatile defaults — no table rewrite). Operators
-- who explicitly want the previous "send to any base58" workflow can
-- flip the toggle off in /settings → Policy.
--
-- Why this matters: the chat agent has NO write tool for the address
-- book by design (deliberate prompt-injection guard). Requiring book
-- membership for transfers means a prompt-injection that gets the model
-- to call `proposeTransfer` against an attacker-controlled address
-- cannot succeed — the policy engine denies before the signer sees it.
-- The auto-approval window (up to maxAutoApprovedUsdcPer24h, default
-- $5k/day) is the surface that drops to zero with this on.
--
-- The check fires only for kind='transfer'. Deposit / withdraw /
-- rebalance are venue-bound and unaffected.

ALTER TABLE "policies"
  ADD COLUMN "require_address_book_for_transfers" boolean NOT NULL DEFAULT true;
