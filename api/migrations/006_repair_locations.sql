-- ═══════════════════════════════════════════════════════════════════════
-- 006 — Keep repair destinations out of the asset form.
--
-- Idempotent:  psql "$DATABASE_URL" -f api/migrations/006_repair_locations.sql
--
-- "EAC/ADC" and the maintenance barn were seeded as ordinary LOCATIONS,
-- so they appear in the Location picker when creating an asset. They are
-- not places an asset lives — they are where it goes when it breaks, and
-- an asset gets there by being sent for repair, which already records who
-- has it. Offering them as a home location invites a parallel, unreliable
-- way of recording the same fact.
--
-- Flagged rather than deleted or deactivated: assets already filed at one
-- of them keep a readable location, and reports over past data still
-- resolve the name.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.asset_locations
  ADD COLUMN IF NOT EXISTS is_repair_destination BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.asset_locations
   SET is_repair_destination = TRUE
 WHERE is_repair_destination = FALSE
   AND (   name ILIKE '%eac%'
        OR name ILIKE '%adc%'
        OR name ILIKE '%b&g%'
        OR name ILIKE '%buildings and grounds%'
        OR name ILIKE '%maintenance barn%'
        OR name ILIKE '%shop / maintenance%');

COMMENT ON COLUMN public.asset_locations.is_repair_destination IS
  'Where equipment goes to be fixed, not where it lives. Hidden from the asset form; still shown on existing records and in reports.';
