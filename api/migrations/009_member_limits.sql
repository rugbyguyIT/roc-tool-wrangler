-- ══════════════════════════════════════════════════════════════════════
-- 009 — How much one ordinary member may hold at once.
--
-- Idempotent:  psql "$DATABASE_URL" -f api/migrations/009_member_limits.sql
--
-- The rule: someone whose roster TITLE marks them an ordinary member may
-- hold a limited number of items at a time. Anyone with any other title —
-- Chairman, Division Chairman, Captain, whatever the roster carries — is
-- unlimited, because the people who run a division genuinely do need six
-- radios and a loader at the same time.
--
-- Every part of it is a setting rather than a constant, because the right
-- answer is an operational judgement that will change between a build week
-- and show week, and changing it must not need a deploy:
--
--   member_limit_enabled       turn the whole rule off in one click
--   member_title               which title means "ordinary member"
--   member_item_limit          how many they may hold
--   member_limit_per_category  count per category, or across everything
--
-- per_category = FALSE is the stricter reading: one item, full stop.
-- per_category = TRUE  is "one forklift AND one cart" — the same limit
-- applied within each category instead of across the whole loan.
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS member_limit_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS member_title              TEXT    NOT NULL DEFAULT 'Committee Member',
  ADD COLUMN IF NOT EXISTS member_item_limit         INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS member_limit_per_category BOOLEAN NOT NULL DEFAULT FALSE;

-- A limit of zero would mean "nobody may borrow anything", which is never
-- what anyone means and is indistinguishable from a mis-typed form. The
-- off switch is member_limit_enabled; this column only says how many.
ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS app_settings_member_item_limit_check;
ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_member_item_limit_check
  CHECK (member_item_limit >= 1 AND member_item_limit <= 99);

-- The check-out guard asks "what does this person already hold, and in
-- which categories" on every handoff to an ordinary member, so the open
-- lines need to be reachable by loanee without a sequential scan once the
-- season is under way.
CREATE INDEX IF NOT EXISTS idx_loan_items_open_by_loan
  ON public.loan_items (loan_id) WHERE checked_in_at IS NULL;

-- pilot_mode goes. It has been in the schema since 001 and in the Settings
-- form since the console was built, and nothing has ever read it — there
-- was no banner, in this or any other version. A switch that does nothing
-- is worse than no switch: the next person to find it assumes the feature
-- is broken rather than absent. If a pilot banner is ever wanted it is one
-- column and one <div>, added then rather than left lying about now.
ALTER TABLE public.app_settings DROP COLUMN IF EXISTS pilot_mode;
