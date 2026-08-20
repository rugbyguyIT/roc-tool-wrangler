-- ═════════════════════════════════════════════════════════════════════
-- 010 — Which groups may sign in to the app.
--
-- Idempotent:  psql "$DATABASE_URL" -f api/migrations/010_group_login.sql
--
-- Kyle's ask: "under the admin page in the groups section, I should be able
-- to check a box on if they can LOGIN to the App or not. that way I can
-- change it later if I want it."
--
-- So the rule is data, not code. A Base or Leadership account may sign in
-- only if that person's roster record sits in at least one ACTIVE group
-- with can_login = TRUE. Admins are never gated: a checkbox that can lock
-- you out of the console you would use to un-tick it is a trap, not a
-- feature.
--
-- THE DEFAULT MATTERS MORE THAN THE COLUMN.
--
-- A plain `DEFAULT FALSE` would lock out every existing login the instant
-- this ran — the app would deploy, the migration would go in, and the next
-- morning nobody at the counter could sign in, with nothing on screen to
-- say why. So existing groups are switched ON here, deliberately: running
-- this changes nothing about who can sign in today. Kyle then unticks what
-- he wants.
--
-- New groups still default FALSE, because creating a group is a small
-- deliberate act and "this one can also sign in" should be a second
-- deliberate act rather than something that happens by omission.
-- ═════════════════════════════════════════════════════════════════════

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS can_login BOOLEAN NOT NULL DEFAULT FALSE;

-- The high-water mark has to exist before the guard below can read it.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS group_login_seeded_at TIMESTAMPTZ;

INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Only on the FIRST run: everything that already exists keeps working.
-- Stamped so that re-running this file — which is the documented recovery
-- from a dropped Cloud Shell connection — does not helpfully tick every
-- group back on after Kyle has deliberately unticked some.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_settings
                 WHERE id = 1 AND group_login_seeded_at IS NOT NULL) THEN
    UPDATE public.groups SET can_login = TRUE;
    UPDATE public.app_settings SET group_login_seeded_at = now() WHERE id = 1;
  END IF;
END $$;

-- The sign-in check runs on every login attempt and asks "is this person in
-- any group that may sign in", so the membership lookup needs to be cheap
-- from the loanee side.
CREATE INDEX IF NOT EXISTS idx_group_members_loanee
  ON public.group_members (loanee_id);

CREATE INDEX IF NOT EXISTS idx_groups_can_login
  ON public.groups (id) WHERE can_login AND active;
