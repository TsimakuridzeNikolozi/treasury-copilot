-- M2 PR 5: per-user onboarding gate.
--
-- Adds two nullable columns to `users`:
--   * onboarded_at  — timestamp marking the user finished the wizard.
--                     null means "not done yet" (or "user predates PR 5").
--   * onboarding_step — smallint 1..5 marking resume position. Null means
--                       not started or already onboarded (disambiguated
--                       via onboarded_at).
--
-- Backfill: set onboarded_at = NOW() on every pre-existing user that
-- already has at least one treasury membership. Those users went
-- through the old auto-bootstrap flow and should not be bounced into
-- the wizard. Users WITHOUT a membership are orphans (stage-3
-- bootstrap failed pre-PR-5, or membership was manually cleaned up)
-- and need to walk through the wizard from step 1; leaving their
-- onboarded_at NULL routes them to /onboarding, where step 1's
-- (idempotent) bootstrap call will heal the orphan.
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
WHERE "onboarded_at" IS NULL
  AND "id" IN (SELECT DISTINCT "user_id" FROM "treasury_memberships");
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_onboarding_step_range_chk"
  CHECK ("onboarding_step" IS NULL OR ("onboarding_step" >= 1 AND "onboarding_step" <= 5));
