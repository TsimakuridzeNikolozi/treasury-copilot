-- M3 PR 3 — idle-capital nudges.
--
-- The 0010 migration seeded one `idle_capital` row per treasury with
-- `config = '{}'` because no worker was wired to it yet. M3 PR 3 ships
-- the worker job and the editable thresholds, so existing empty configs
-- get the M3-defined defaults backfilled here. User-edited configs are
-- left alone via the `config = '{}'::jsonb` predicate (none should exist
-- yet — the UI editor for idle_capital is also new in PR 3 — but the
-- guard is cheap and keeps the migration safe to re-run).
--
-- Defaults (also defined in code as IDLE_CAPITAL_DEFAULT_CONFIG):
--   minIdleUsdc:   5000   — don't ping below this much in the wallet.
--   minDwellHours: 72     — 3-day default dwell before nudging.
--   cooldownHours: 48     — 2-day cooldown between repeat nudges.

UPDATE "alert_subscriptions"
SET "config" = '{"minIdleUsdc": 5000, "minDwellHours": 72, "cooldownHours": 48}'::jsonb
WHERE "kind" = 'idle_capital' AND "config" = '{}'::jsonb;
