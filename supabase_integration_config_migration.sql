-- Stage 9B: creates the integration_config table.
-- Run in the Supabase SQL editor (Project → SQL Editor), connected as the
-- postgres/service role (the default for that editor). Not run from the app.
--
-- Deliberate simplification: Stage 4's design called for an
-- integration_config table but the Stage 7 schema build didn't include one.
-- This adds it now, scoped to what Screen 4 (Integration Configuration)
-- needs: a setup/config record per feed, not a per-transaction table.

CREATE TABLE integration_config (
  integration_id BIGSERIAL PRIMARY KEY,
  integration_name TEXT NOT NULL,
  source_id BIGINT NOT NULL REFERENCES dim_source_system(source_id),
  api_endpoint TEXT NOT NULL,
  sync_frequency TEXT NOT NULL CHECK (sync_frequency IN ('Daily', 'Weekly')),
  default_vertical_id BIGINT NOT NULL REFERENCES dim_vertical(vertical_id),
  default_channel_id BIGINT NOT NULL REFERENCES dim_channel(channel_id),
  return_category_mapping TEXT, -- free text describing which ret_cat_id(s) this feed populates
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_sync_status TEXT,
  last_sync_at TIMESTAMPTZ,
  last_sync_row_count INTEGER,
  created_by BIGINT NOT NULL REFERENCES users(user_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE integration_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "select_all_anon_integration_config" ON integration_config FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "insert_all_anon_integration_config" ON integration_config FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_all_anon_integration_config" ON integration_config FOR UPDATE TO anon, authenticated USING (true);
GRANT SELECT, INSERT, UPDATE ON integration_config TO anon, authenticated;
GRANT USAGE, SELECT ON integration_config_integration_id_seq TO anon, authenticated;
