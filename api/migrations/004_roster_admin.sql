-- ═══════════════════════════════════════════════════════════════════════
-- 004 — Bulk roster administration.
--
-- Idempotent:  psql "$DATABASE_URL" -f api/migrations/004_roster_admin.sql
-- ═══════════════════════════════════════════════════════════════════════

-- ── The clear-roster PIN ───────────────────────────────────────────────
-- Stored HASHED and checked on the server, deliberately. A PIN compared in
-- the browser is readable by anyone who opens developer tools, which makes
-- it decoration rather than a control. Here it is a real second factor on
-- top of the admin role and the typed confirmation.
--
-- Seeded to 1932. Change it with:
--   UPDATE public.app_settings
--      SET roster_clear_pin_hash = crypt('NEWPIN', gen_salt('bf'));
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS roster_clear_pin_hash TEXT;

UPDATE public.app_settings
   SET roster_clear_pin_hash = crypt('1932', gen_salt('bf'))
 WHERE id = 1 AND roster_clear_pin_hash IS NULL;

COMMENT ON COLUMN public.app_settings.roster_clear_pin_hash IS
  'bcrypt hash of the PIN required to clear the roster. Checked server-side so it is never present in the browser bundle.';
