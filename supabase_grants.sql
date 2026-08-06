-- Grants for the Nykaa MRS anon role.
-- Run in the Supabase SQL editor (Project → SQL Editor), connected as the
-- postgres/service role (the default for that editor).
--
-- Confirmed via direct REST probe on 2026-08-05:
--   permission denied (42501) for: users, dim_vertical, dim_location,
--   dim_channel, dim_investment_category, fact_investment, fact_return
--   already readable: dim_return_category, dim_brand, dim_source_system,
--   dim_product_category
-- Re-running GRANT on an already-granted table is a harmless no-op, so this
-- script covers all nine app tables for completeness.

-- 1. Reference/dimension tables — read-only for anon.
-- Used by SupabaseSelect and ActingUserPicker across every screen.
GRANT SELECT ON public.users TO anon;
GRANT SELECT ON public.dim_vertical TO anon;
GRANT SELECT ON public.dim_location TO anon;
GRANT SELECT ON public.dim_channel TO anon;
GRANT SELECT ON public.dim_product_category TO anon;
GRANT SELECT ON public.dim_brand TO anon;
GRANT SELECT ON public.dim_source_system TO anon;
GRANT SELECT ON public.dim_investment_category TO anon;
GRANT SELECT ON public.dim_return_category TO anon;

-- 2. Fact tables — anon needs SELECT (dashboards, verification queries) and
-- INSERT (the entry/upload screens write here). No UPDATE/DELETE: these
-- screens are append-only, entries aren't edited or removed from the UI.
GRANT SELECT, INSERT ON public.fact_investment TO anon;
GRANT SELECT, INSERT ON public.fact_return TO anon;

-- 3. If RLS is enabled on any of these tables, grants alone won't be enough —
-- Postgres checks RLS policies after table-level grants. Check first:
--   SELECT relname, relrowsecurity
--   FROM pg_class
--   WHERE relnamespace = 'public'::regnamespace
--     AND relname IN (
--       'users', 'dim_vertical', 'dim_location', 'dim_channel',
--       'dim_product_category', 'dim_brand', 'dim_source_system',
--       'dim_investment_category', 'dim_return_category',
--       'fact_investment', 'fact_return'
--     );
--
-- For any table where relrowsecurity = true, add a matching policy. This
-- build has no real auth (see ActingUserContext.jsx), so policies are
-- permissive by design — anon is the only role the app ever uses.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'dim_vertical', 'dim_location', 'dim_channel',
    'dim_product_category', 'dim_brand', 'dim_source_system',
    'dim_investment_category', 'dim_return_category'
  ]
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS "anon_read_%1$s" ON public.%1$s', t
    );
    EXECUTE format(
      'CREATE POLICY "anon_read_%1$s" ON public.%1$s FOR SELECT TO anon USING (true)',
      t
    );
  END LOOP;

  FOREACH t IN ARRAY ARRAY['fact_investment', 'fact_return']
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS "anon_read_%1$s" ON public.%1$s', t
    );
    EXECUTE format(
      'CREATE POLICY "anon_read_%1$s" ON public.%1$s FOR SELECT TO anon USING (true)',
      t
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS "anon_insert_%1$s" ON public.%1$s', t
    );
    EXECUTE format(
      'CREATE POLICY "anon_insert_%1$s" ON public.%1$s FOR INSERT TO anon WITH CHECK (true)',
      t
    );
  END LOOP;
END $$;
