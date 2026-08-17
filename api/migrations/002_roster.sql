-- ═══════════════════════════════════════════════════════════════════════
-- 002 — Roster import support.
--
-- Adds what's needed to load the Rodeo Operations roster export and, more
-- importantly, to RE-load it at any time and apply only the differences.
--
-- Every statement is IF NOT EXISTS / idempotent, same as 001, so this is
-- safe to run repeatedly:
--
--   psql "$DATABASE_URL" -f api/migrations/002_roster.sql
-- ═══════════════════════════════════════════════════════════════════════

-- ── The diff key ───────────────────────────────────────────────────────
-- Customer Number from the roster export, surfaced everywhere in the UI as
-- "Member Number". This is what every re-import matches on: names change
-- (marriage, preferred name), emails change, committees change — the
-- customer number does not. Matching on name would create duplicates the
-- first time someone's preferred name changed.
--
-- Nullable because loanees can still be added by hand for people who
-- aren't on the roster (a contractor, a one-off volunteer); those simply
-- never participate in roster diffs.
ALTER TABLE public.loanees ADD COLUMN IF NOT EXISTS member_number TEXT;
ALTER TABLE public.loanees ADD COLUMN IF NOT EXISTS title         TEXT;

-- Partial unique index rather than a UNIQUE constraint: hand-added loanees
-- have NULL here and there can be many of those.
CREATE UNIQUE INDEX IF NOT EXISTS loanees_member_number_uniq
  ON public.loanees (member_number)
  WHERE member_number IS NOT NULL AND member_number <> '';

-- Roster re-imports look up by member number on every row, 493 at a time.
CREATE INDEX IF NOT EXISTS idx_loanees_member_number
  ON public.loanees (member_number)
  WHERE member_number IS NOT NULL AND member_number <> '';

-- ── The same key on login accounts ─────────────────────────────────────
-- A roster row can produce BOTH a loanee (someone equipment is checked out
-- to) and a profile (someone who signs in). Carrying the member number on
-- the profile too means a re-import can find the account it created
-- earlier even if the person's email changed in the roster.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS member_number TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_member_number_uniq
  ON public.profiles (member_number)
  WHERE member_number IS NOT NULL AND member_number <> '';

-- ── One-time group seeding ─────────────────────────────────────────────
-- Groups are created from the distinct Subcommittee 1 values on the FIRST
-- roster import only. After that, groups are managed by hand: a new
-- subcommittee appearing in the spreadsheet later is reported in the
-- preview but does not silently create a group, because by then the group
-- list has been curated (renamed, merged, deactivated) and a spreadsheet
-- should not be able to undo that.
--
-- Stored as a timestamp rather than a boolean so the admin can see WHEN it
-- happened, and so clearing it (to deliberately re-seed) is an obvious,
-- deliberate act.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS roster_groups_seeded_at TIMESTAMPTZ;

-- ── Roster import provenance ───────────────────────────────────────────
-- Which roster file a loanee last came from, and when. Makes "why did this
-- person change?" answerable without digging through audit logs.
ALTER TABLE public.loanees ADD COLUMN IF NOT EXISTS roster_synced_at TIMESTAMPTZ;

-- ── Deactivation reason ────────────────────────────────────────────────
-- When someone drops off the roster they are marked inactive rather than
-- deleted, so their loan history survives. This records that the change
-- came from a roster import and not from a person clicking something —
-- which matters when they reappear next month and someone asks why they
-- were switched off.
ALTER TABLE public.loanees ADD COLUMN IF NOT EXISTS status_reason TEXT;

COMMENT ON COLUMN public.loanees.member_number IS
  'Customer Number from the roster export. Shown as "Member Number". The key every roster re-import matches on.';
COMMENT ON COLUMN public.loanees.title IS
  'Title from the roster export (Committee Member, Captain, Chairman, ...).';
COMMENT ON COLUMN public.loanees.status_reason IS
  'Why status last changed, e.g. "absent from roster import 2026-08-16".';
COMMENT ON COLUMN public.profiles.member_number IS
  'Links a login account back to the roster row that created it, so re-imports can find it even if the email changed.';

-- ── Widen the import constraints ───────────────────────────────────────
-- The roster is a fourth kind of import, and it needs two verdicts the
-- original three kinds never had: 'unchanged' (matched, nothing differs —
-- the overwhelmingly common case on a re-import, and worth showing so the
-- admin can see the import really did look at everyone) and 'deactivate'
-- (present in the app, absent from this file).
ALTER TABLE public.import_batches DROP CONSTRAINT IF EXISTS import_batches_kind_check;
ALTER TABLE public.import_batches ADD  CONSTRAINT import_batches_kind_check
  CHECK (kind IN ('loanees','assets','group_members','roster'));

ALTER TABLE public.import_rows DROP CONSTRAINT IF EXISTS import_rows_verdict_check;
ALTER TABLE public.import_rows ADD  CONSTRAINT import_rows_verdict_check
  CHECK (verdict IN ('create','update','skip_duplicate','error','unchanged','deactivate'));

-- Which fields a roster row actually changed, so the preview can show
-- "phone and committee" rather than a bare "update", and so the committed
-- batch remains a readable record of what moved.
ALTER TABLE public.import_rows ADD COLUMN IF NOT EXISTS changes JSONB;
