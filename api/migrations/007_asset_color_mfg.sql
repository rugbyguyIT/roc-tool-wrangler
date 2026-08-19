-- ═══════════════════════════════════════════════════════════════════════
-- 007 — Colour and manufacturer on an asset.
--
-- Idempotent:  psql "$DATABASE_URL" -f api/migrations/007_asset_color_mfg.sql
--
-- Two carts with sequential tags are indistinguishable across a shed. The
-- thing staff actually say out loud is "the white one" or "the Club Car",
-- so those are the two facts worth storing: they are how a person tells
-- one unit from another when the tag has rubbed off, which on this
-- equipment it does.
--
-- On EVERY asset, not just carts. Manufacturer is how you find the right
-- charger for a radio and the right filter for a loader, and a
-- category-specific field would mean building a custom-field system to
-- hold two columns. If carts later need something genuinely cart-only,
-- that is the point to build it — not now.
--
-- Nullable with no default: blank means nobody has recorded it, which is
-- true of every row that exists today and honest about the ones that come
-- in from an import with the column missing.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.assets
  ADD COLUMN IF NOT EXISTS color        TEXT,
  ADD COLUMN IF NOT EXISTS manufacturer TEXT;

-- Manufacturer is searchable from the asset list and the check-out picker,
-- which is a prefix/substring match over what will be a few hundred rows.
-- The index earns its keep once the catalog is loaded; before that it costs
-- nothing.
CREATE INDEX IF NOT EXISTS idx_assets_manufacturer
  ON public.assets (lower(manufacturer))
  WHERE manufacturer IS NOT NULL;
