-- M2 PR 5: per-user onboarding gate.
--
-- Adds two nullable columns to `users`:
--   * onboarded_at  — timestamp marking the user finished the wizard.
--                     null means "not done yet" (or "user predates PR 5").
--   * onboarding_step — smallint 1..5 marking resume position. Null means
--                       not started or already onboarded (disambiguated
--                       via onboarded_at).
--
-- Backfill: set onboarded_at = NOW() on every pre-existing user row
-- so that accounts created before PR 5 skip the wizard entirely.
-- Users with no treasury membership (orphans — stage-3 bootstrap
-- failed pre-PR-5, or membership manually cleaned up) are included;
-- page.tsx's orphan guard (onboarded_at non-null AND memberships = 0)
-- redirects them to /onboarding so the wizard heals them from step 1.
--
-- Why this UPDATE is safe inside the migrator's wrapping transaction:
-- both columns stay NULLABLE. Drizzle-orm's migrator runs all pending
-- migrations in one transaction; a NOT NULL flip would not see its own
-- UPDATE because the constraint is checked at COMMIT time. PR 1's
-- structural flips needed a separate seed-script stage for that reason.
-- Here, since neither column is NOT NULL, the same trap does not apply.

ALTER TABLE "users" ADD COLUMN "onboarded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarding_step" smallint;
--> statement-breakpoint
UPDATE "users" SET "onboarded_at" = NOW()
WHERE "onboarded_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_onboarding_step_range_chk"
  CHECK ("onboarding_step" IS NULL OR ("onboarding_step" >= 1 AND "onboarding_step" <= 5));
