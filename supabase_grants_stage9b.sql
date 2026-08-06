-- Stage 9B: additional grants discovered while building Screen 5 (KPI Target
-- Setting). Same class of issue as the Stage 9A grants fix — dim_kpi and
-- kpi_target were never granted to anon. Run in the Supabase SQL editor.
--
-- Confirmed via direct REST probe: permission denied (42501) for dim_kpi
-- and kpi_target.

GRANT SELECT ON public.dim_kpi TO anon;
GRANT SELECT, INSERT, UPDATE ON public.kpi_target TO anon;

-- kpi_target's PK sequence needs USAGE/SELECT for inserts to get an id back,
-- same reasoning as integration_config's sequence grant.
DO $$
DECLARE
  seq_name text;
BEGIN
  SELECT pg_get_serial_sequence('public.kpi_target', 'target_id') INTO seq_name;
  IF seq_name IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON %s TO anon', seq_name);
  END IF;
END $$;

-- If RLS is enabled on either table, add permissive anon policies (same
-- rationale as the Stage 9A grants script: no real auth in this build).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'dim_kpi' AND relrowsecurity = true
  ) THEN
    DROP POLICY IF EXISTS "anon_read_dim_kpi" ON public.dim_kpi;
    CREATE POLICY "anon_read_dim_kpi" ON public.dim_kpi FOR SELECT TO anon USING (true);
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'kpi_target' AND relrowsecurity = true
  ) THEN
    DROP POLICY IF EXISTS "anon_read_kpi_target" ON public.kpi_target;
    CREATE POLICY "anon_read_kpi_target" ON public.kpi_target FOR SELECT TO anon USING (true);
    DROP POLICY IF EXISTS "anon_insert_kpi_target" ON public.kpi_target;
    CREATE POLICY "anon_insert_kpi_target" ON public.kpi_target FOR INSERT TO anon WITH CHECK (true);
    DROP POLICY IF EXISTS "anon_update_kpi_target" ON public.kpi_target;
    CREATE POLICY "anon_update_kpi_target" ON public.kpi_target FOR UPDATE TO anon USING (true);
  END IF;
END $$;
