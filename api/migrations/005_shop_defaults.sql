-- ═══════════════════════════════════════════════════════════════════════
-- 005 — A default repair shop per asset category.
--
-- Idempotent:  psql "$DATABASE_URL" -f api/migrations/005_shop_defaults.sql
--
-- Who fixes a thing depends on what the thing is: fuel carts go to
-- Buildings and Grounds, golf carts to ADC, forklifts to EAC. Staff should
-- not have to remember that at the counter, and a wrong choice sends
-- equipment to the wrong yard.
--
-- So the shop is a property of the CATEGORY, pre-selected when an asset is
-- sent out — and still overridable, because an outside vendor or a
-- one-off favour happens.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.asset_categories
  ADD COLUMN IF NOT EXISTS default_repair_shop_id UUID
    REFERENCES public.repair_shops(id) ON DELETE SET NULL;

-- ── The three shops ────────────────────────────────────────────────────
INSERT INTO public.repair_shops (name, is_internal, notes) VALUES
  ('Buildings and Grounds', TRUE, 'Internal maintenance department'),
  ('ADC',                   TRUE, 'Golf cart maintenance'),
  ('EAC',                   TRUE, 'Forklift and heavy equipment maintenance')
ON CONFLICT (lower(name)) DO NOTHING;

-- ── Wire the defaults ──────────────────────────────────────────────────
-- Matched on a LIKE rather than an exact name because the category list is
-- admin-editable and may read "Golf Carts", "Golf cart" or "Carts - Golf".
-- Only ever fills a category that has no default yet, so an admin's later
-- choice is never overwritten by re-running this.
UPDATE public.asset_categories c SET default_repair_shop_id = s.id
  FROM public.repair_shops s
 WHERE c.default_repair_shop_id IS NULL
   AND lower(s.name) = 'buildings and grounds'
   AND c.name ILIKE '%fuel%';

UPDATE public.asset_categories c SET default_repair_shop_id = s.id
  FROM public.repair_shops s
 WHERE c.default_repair_shop_id IS NULL
   AND lower(s.name) = 'adc'
   AND c.name ILIKE '%golf%';

UPDATE public.asset_categories c SET default_repair_shop_id = s.id
  FROM public.repair_shops s
 WHERE c.default_repair_shop_id IS NULL
   AND lower(s.name) = 'eac'
   AND (c.name ILIKE '%forklift%' OR c.name ILIKE '%fork lift%');

COMMENT ON COLUMN public.asset_categories.default_repair_shop_id IS
  'Where assets of this category go when they need fixing. Pre-selected at send-for-repair; always overridable.';
