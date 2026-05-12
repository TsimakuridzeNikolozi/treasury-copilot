-- Finalize the M2 policies table shape in the regular migration path.
--
-- Older M2 rollout notes moved this structural flip into db:seed-m2 so
-- legacy singleton data could be backfilled first. Fresh production
-- deployments do not necessarily run the local-mode seed script, which
-- leaves policies.id as the primary key. The web app writes policies by
-- treasury_id, so onboarding step 3 can 500 on INSERT unless this flip has
-- happened.

DO $$
DECLARE
  has_id_column boolean;
  treasury_count integer;
  only_treasury_id uuid;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'policies'
      AND column_name = 'id'
  )
  INTO has_id_column;

  IF has_id_column THEN
    SELECT COUNT(*), MIN(id)
    INTO treasury_count, only_treasury_id
    FROM treasuries;

    -- Preserve a legacy singleton row when there is exactly one treasury.
    -- Otherwise drop orphaned singleton rows; getPolicy falls back to
    -- DEFAULT_POLICY and the first PATCH recreates the per-treasury row.
    IF treasury_count = 1 THEN
      UPDATE policies
      SET treasury_id = only_treasury_id
      WHERE treasury_id IS NULL;
    ELSE
      DELETE FROM policies
      WHERE treasury_id IS NULL;
    END IF;

    ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_singleton;
    ALTER TABLE policies DROP CONSTRAINT IF EXISTS policies_pkey;
    ALTER TABLE policies ALTER COLUMN treasury_id SET NOT NULL;
    ALTER TABLE policies ADD CONSTRAINT policies_pkey PRIMARY KEY (treasury_id);
    ALTER TABLE policies DROP COLUMN id;
  END IF;
END $$;
