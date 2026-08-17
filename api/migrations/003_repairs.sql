-- ═══════════════════════════════════════════════════════════════════════
-- 003 — Repairs, and a saved roster column mapping.
--
-- Idempotent like 001 and 002:
--   psql "$DATABASE_URL" -f api/migrations/003_repairs.sql
--
-- REPAIRS. An asset away at Buildings and Grounds is not "checked out" —
-- nobody borrowed it, and treating it as a loan makes two questions
-- unanswerable later: "how often does this forklift break" and "who
-- actually had it when it broke". So repairs are their own record with
-- their own lifecycle, and the asset sits at 'maintenance' while away,
-- which the existing eligibility rules already exclude from check-out.
-- ═══════════════════════════════════════════════════════════════════════

-- ── Who does the work ──────────────────────────────────────────────────
-- A lookup rather than free text, so "Buildings and Grounds", "Bldg &
-- Grounds" and "B&G" don't become three different shops in the reports.
-- Admin-managed exactly like categories and locations.
CREATE TABLE IF NOT EXISTS public.repair_shops (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  contact     TEXT,                  -- phone, email or "ask for Dave"
  is_internal BOOLEAN NOT NULL DEFAULT TRUE,   -- department vs outside vendor
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS repair_shops_name_uniq
  ON public.repair_shops (lower(name));

INSERT INTO public.repair_shops (name, is_internal, notes)
VALUES ('Buildings and Grounds', TRUE, 'Internal maintenance department')
ON CONFLICT (lower(name)) DO NOTHING;

-- ── The repair itself ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.asset_repairs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       UUID NOT NULL REFERENCES public.assets(id)       ON DELETE CASCADE,
  shop_id        UUID          REFERENCES public.repair_shops(id) ON DELETE SET NULL,

  -- What's wrong, in the words of whoever noticed. Required: a repair with
  -- no reported fault is unactionable by the time it reaches the shop.
  reported_fault TEXT NOT NULL,

  -- Who last had it. Nullable because a fault is often found on the shelf,
  -- not at check-in — but when it IS found at check-in, recording the
  -- loanee is what makes "this keeps coming back damaged" visible.
  loanee_id      UUID REFERENCES public.loanees(id) ON DELETE SET NULL,

  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_back  TIMESTAMPTZ,
  returned_at    TIMESTAMPTZ,

  work_done      TEXT,
  cost_cents     INT,
  outcome        TEXT CHECK (outcome IN ('repaired','no_fault_found','beyond_repair','returned_unrepaired')),

  sent_by        UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  received_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asset_repairs_asset ON public.asset_repairs (asset_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_repairs_shop  ON public.asset_repairs (shop_id);
CREATE INDEX IF NOT EXISTS idx_asset_repairs_open  ON public.asset_repairs (returned_at) WHERE returned_at IS NULL;

-- One open repair per asset. Without this, two people at two ends of the
-- grounds can each send the same forklift out and the board shows it in
-- two places at once.
CREATE UNIQUE INDEX IF NOT EXISTS asset_repairs_one_open_per_asset
  ON public.asset_repairs (asset_id) WHERE returned_at IS NULL;

-- ── The board's "At repair" section reads this ─────────────────────────
-- Mirrors v_open_loan_items so the board can render both from the same
-- shape, and so "days out" means the same thing in both.
CREATE OR REPLACE VIEW public.v_open_repairs AS
SELECT r.id              AS repair_id,
       r.asset_id,
       a.asset_tag,
       a.title           AS asset_title,
       a.primary_photo_url,
       r.shop_id,
       s.name            AS shop_name,
       s.is_internal,
       r.reported_fault,
       r.loanee_id,
       ln.full_name      AS last_held_by,
       r.sent_at,
       r.expected_back,
       (r.expected_back IS NOT NULL AND r.expected_back < now()) AS overdue,
       EXTRACT(EPOCH FROM (now() - r.sent_at)) / 86400.0         AS days_out,
       p.full_name       AS sent_by_name
FROM public.asset_repairs r
JOIN public.assets a          ON a.id  = r.asset_id
LEFT JOIN public.repair_shops s ON s.id = r.shop_id
LEFT JOIN public.loanees ln     ON ln.id = r.loanee_id
LEFT JOIN public.profiles p     ON p.id  = r.sent_by
WHERE r.returned_at IS NULL;

-- ── Event kinds ────────────────────────────────────────────────────────
-- 'maintenance_start' and 'maintenance_end' already exist and are reused,
-- so an asset's history reads as one timeline rather than splitting into
-- loans-here and repairs-there. Two kinds are added for the parts that are
-- genuinely new.
ALTER TABLE public.asset_events DROP CONSTRAINT IF EXISTS asset_events_event_check;
ALTER TABLE public.asset_events ADD  CONSTRAINT asset_events_event_check
  CHECK (event IN (
    'created','updated','checked_out','checked_in','maintenance_start',
    'maintenance_end','retired','unretired','photo_added','photo_removed',
    'location_changed','note_added','due_extended','groups_changed','imported',
    'sent_for_repair','returned_from_repair'));

-- ── Saved roster column mapping ────────────────────────────────────────
-- {"Customer Number":"member_number","Preferred Name":"preferred_name",...}
-- Auto-detection still runs first; this is the override, saved on the
-- import the admin confirms, so a changed export format is a one-time fix
-- rather than a re-mapping chore every month.
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS roster_column_map     JSONB,
  ADD COLUMN IF NOT EXISTS roster_map_saved_at   TIMESTAMPTZ;

COMMENT ON TABLE  public.asset_repairs IS
  'An asset physically away being fixed. Distinct from a loan: nobody borrowed it, so it must not appear in loan history or count against a loanee.';
COMMENT ON INDEX public.asset_repairs_one_open_per_asset IS
  'Stops the same asset being sent out twice concurrently.';
COMMENT ON COLUMN public.app_settings.roster_column_map IS
  'Saved column mapping from the last confirmed roster import. Overrides auto-detection when the export format changes.';
