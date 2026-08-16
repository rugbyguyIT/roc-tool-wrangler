-- ══════════════════════════════════════════════════════════════════════════════
-- HLSR Asset Tracker — schema rev 1
--
-- Run MANUALLY (8 Seconds convention — nothing in this app auto-runs SQL):
--
--   psql 'postgresql://USER:PASSWORD@HOST:5432/postgres?sslmode=require' \
--     -f api/migrations/001_schema.sql
--
-- Single-quote the URL. Every statement is IF NOT EXISTS / OR REPLACE
-- guarded, so re-running is safe and idempotent.
--
-- PREREQUISITE: on Azure Database for PostgreSQL Flexible Server the
-- extensions below must be allow-listed BEFORE this file will run:
--   Portal → your server → Server parameters → azure.extensions
--   → tick PGCRYPTO and PG_TRGM → Save → restart the server.
-- Without that, CREATE EXTENSION fails and nothing else in this file runs.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy asset/loanee search


-- ══ 1. APP USERS — the people who log in ═══════════════════════════════
-- Three roles, all password-authenticated, all created by an admin.
-- There is no self-service signup and no OTP/PIN/MFA path anywhere.
--   admin  — catalog, people, groups, users, settings, reports
--   staff  — the check-out / check-in counter
--   leader — read-only; the phone PWA view of what's out right now
CREATE TABLE IF NOT EXISTS public.profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  first_name    TEXT NOT NULL DEFAULT '',
  last_name     TEXT NOT NULL DEFAULT '',
  full_name     TEXT NOT NULL,           -- denormalized "First Last"; the API recomputes on every write
  phone_mobile  TEXT,
  role          TEXT NOT NULL CHECK (role IN ('admin','staff','leader')),
  photo_url     TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  password_hash TEXT,                    -- bcrypt; required for all three roles
  token_version INT  NOT NULL DEFAULT 1, -- bump = instant force-logout everywhere
  last_login_at TIMESTAMPTZ,
  created_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles (role) WHERE status = 'active';


-- ══ 2. LOANEES — the people who borrow; they never log in ══════════════
-- Deliberately a separate table from profiles. A loanee has no password,
-- no token_version, no role and no session. Folding ~2,000 volunteers into
-- the auth table as a fourth "loanee" role would put rows that can never
-- authenticate in front of every JWT check and every "list users" screen.
-- If loanees ever need self-service ("what do I have out?"), the migration
-- is additive: a nullable loanees.profile_id link, not a table merge.
CREATE TABLE IF NOT EXISTS public.loanees (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  full_name     TEXT NOT NULL,           -- denormalized, recomputed on write
  email         TEXT,                    -- optional: many volunteers have none on file
  phone_mobile  TEXT,                    -- "cell"
  position      TEXT,
  sub_committee TEXT,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Email is the dedupe key WHEN PRESENT. Blank emails must not collide with
-- each other, so this is a partial index rather than a plain UNIQUE column.
CREATE UNIQUE INDEX IF NOT EXISTS loanees_email_uniq
  ON public.loanees (lower(email)) WHERE email IS NOT NULL AND email <> '';
CREATE INDEX IF NOT EXISTS idx_loanees_name_trgm     ON public.loanees USING gin (full_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_loanees_subcommittee  ON public.loanees (sub_committee);
CREATE INDEX IF NOT EXISTS idx_loanees_active        ON public.loanees (status) WHERE status = 'active';
-- Soft dedupe key used by the importer when a row has no email:
-- first + last + last four digits of the phone number.
CREATE INDEX IF NOT EXISTS idx_loanees_softkey ON public.loanees (
  lower(first_name),
  lower(last_name),
  right(regexp_replace(coalesce(phone_mobile,''), '\D', '', 'g'), 4)
);


-- ══ 3. GROUPS — contain LOANEES; they gate who may RECEIVE an asset ════
CREATE TABLE IF NOT EXISTS public.groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS groups_name_uniq ON public.groups (lower(name));

CREATE TABLE IF NOT EXISTS public.group_members (
  group_id   UUID NOT NULL REFERENCES public.groups(id)  ON DELETE CASCADE,
  loanee_id  UUID NOT NULL REFERENCES public.loanees(id) ON DELETE CASCADE,
  added_by   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, loanee_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_loanee ON public.group_members (loanee_id);


-- ══ 4. LOOKUPS — admin-managed lists ═══════════════════════════════
CREATE TABLE IF NOT EXISTS public.asset_categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  icon       TEXT,                        -- Font Awesome class, e.g. 'fa-screwdriver-wrench'
  sort_order INT  NOT NULL DEFAULT 100,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS asset_categories_name_uniq ON public.asset_categories (lower(name));

CREATE TABLE IF NOT EXISTS public.asset_locations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  notes      TEXT,
  sort_order INT  NOT NULL DEFAULT 100,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS asset_locations_name_uniq ON public.asset_locations (lower(name));


-- ══ 5. ASSETS ══════════════════════════════════════════════════════════
-- status is a DENORMALIZED fast read for list screens. The source of truth
-- for custody is loan_items (§6) — assets-core.js writes both inside one
-- transaction so they can never disagree.
CREATE TABLE IF NOT EXISTS public.assets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_tag         TEXT NOT NULL,        -- the human / scannable identifier, e.g. ROCFEL05
  title             TEXT NOT NULL,
  description       TEXT,
  category_id       UUID REFERENCES public.asset_categories(id) ON DELETE SET NULL,
  location_id       UUID REFERENCES public.asset_locations(id)  ON DELETE SET NULL,
  serial            TEXT,
  notes             TEXT,
  status            TEXT NOT NULL DEFAULT 'available'
                      CHECK (status IN ('available','checked_out','maintenance','retired')),
  primary_photo_url TEXT,                 -- denormalized from asset_photos for list screens
  purchase_date     DATE,
  value_cents       INT,
  created_by        UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS assets_tag_uniq ON public.assets (lower(asset_tag));
CREATE INDEX IF NOT EXISTS idx_assets_status      ON public.assets (status);
CREATE INDEX IF NOT EXISTS idx_assets_category    ON public.assets (category_id);
CREATE INDEX IF NOT EXISTS idx_assets_location    ON public.assets (location_id);
CREATE INDEX IF NOT EXISTS idx_assets_title_trgm  ON public.assets USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_assets_tag_trgm    ON public.assets USING gin (asset_tag gin_trgm_ops);

-- Restriction join. ZERO rows for an asset means UNRESTRICTED — anyone may
-- receive it. One or more rows means the loanee must be in at least one of
-- the listed groups. See asset_eligible() in §11.
CREATE TABLE IF NOT EXISTS public.asset_groups (
  asset_id   UUID NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  group_id   UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_groups_group ON public.asset_groups (group_id);

CREATE TABLE IF NOT EXISTS public.asset_photos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id   UUID NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  caption    TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INT NOT NULL DEFAULT 100,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asset_photos_asset ON public.asset_photos (asset_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS asset_photos_one_primary
  ON public.asset_photos (asset_id) WHERE is_primary;


-- ══ 6. LOANS — header + lines ══════════════════════════════════════
-- Cart-style checkout (several assets to one loanee in one handoff) with
-- item-by-item check-in needs both halves:
--   loans      — one row per handoff: who got it, who handed it over, when
--   loan_items — one row per asset: its own due date, condition, return
CREATE TABLE IF NOT EXISTS public.loans (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loanee_id      UUID NOT NULL REFERENCES public.loanees(id),
  checked_out_by UUID NOT NULL REFERENCES public.profiles(id),  -- the staff member at the counter
  checked_out_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at         TIMESTAMPTZ,             -- NULL = indefinite; copied down to each line at creation
  notes          TEXT,
  closed_at      TIMESTAMPTZ,             -- set when the LAST line is checked in
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loans_loanee ON public.loans (loanee_id, checked_out_at DESC);
CREATE INDEX IF NOT EXISTS idx_loans_open   ON public.loans (checked_out_at DESC) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.loan_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id         UUID NOT NULL REFERENCES public.loans(id) ON DELETE CASCADE,
  asset_id        UUID NOT NULL REFERENCES public.assets(id),
  checked_out_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at          TIMESTAMPTZ,            -- per-item override; defaults to loans.due_at
  out_condition   TEXT CHECK (out_condition IN ('good','fair','damaged','needs_service')),
  out_notes       TEXT,
  checked_in_at   TIMESTAMPTZ,
  checked_in_by   UUID REFERENCES public.profiles(id),
  in_condition    TEXT CHECK (in_condition IN ('good','fair','damaged','needs_service','missing')),
  in_notes        TEXT,
  returned_status TEXT CHECK (returned_status IN ('available','maintenance'))
);
-- ★ THE integrity guarantee: an asset can be on at most ONE open loan line.
--   Two staff checking out the same forklift at the same instant produce a
--   23505 unique violation, which assets-core.js maps to a clean HTTP 409.
--   This is a database-level invariant, not an application-level hope.
CREATE UNIQUE INDEX IF NOT EXISTS loan_items_one_open_per_asset
  ON public.loan_items (asset_id) WHERE checked_in_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_loan_items_loan  ON public.loan_items (loan_id);
CREATE INDEX IF NOT EXISTS idx_loan_items_asset ON public.loan_items (asset_id, checked_out_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_items_open  ON public.loan_items (due_at) WHERE checked_in_at IS NULL;


-- ══ 7. APPEND-ONLY EVENT LOG ══════════════════════════════════════════
-- Every state change writes a row here naming the actor. Nothing ever
-- updates or deletes from this table — it is the custody paper trail.
CREATE TABLE IF NOT EXISTS public.asset_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     UUID NOT NULL REFERENCES public.assets(id) ON DELETE CASCADE,
  loan_id      UUID REFERENCES public.loans(id)      ON DELETE SET NULL,
  loan_item_id UUID REFERENCES public.loan_items(id) ON DELETE SET NULL,
  loanee_id    UUID REFERENCES public.loanees(id)    ON DELETE SET NULL,
  event        TEXT NOT NULL CHECK (event IN (
                 'created','updated','checked_out','checked_in','maintenance_start',
                 'maintenance_end','retired','unretired','photo_added','photo_removed',
                 'location_changed','note_added','due_extended','groups_changed','imported')),
  actor_id     UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  actor_role   TEXT,
  reason       TEXT,
  payload      JSONB,   -- {from_status,to_status,due_at,condition,from_location,to_location,…}
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asset_events_asset  ON public.asset_events (asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_events_loanee ON public.asset_events (loanee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_events_time   ON public.asset_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_events_event  ON public.asset_events (event);


-- ══ 8. NOTIFICATION OUTBOX — schema only in rev 1 ════════════════════
-- No sender ships in rev 1. The table exists now so that adding email or
-- push later is a code change, not a migration against a live production
-- database. The UNIQUE constraint is the dedupe guarantee that makes
-- at-least-once delivery safe.
CREATE TABLE IF NOT EXISTS public.notification_outbox (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_event_id UUID REFERENCES public.asset_events(id) ON DELETE CASCADE,
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('profile','loanee')),
  recipient_id   UUID NOT NULL,
  channel        TEXT NOT NULL CHECK (channel IN ('push','email','sms')),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts       INT NOT NULL DEFAULT 0,
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_event_id, recipient_kind, recipient_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON public.notification_outbox (created_at) WHERE status = 'pending';


-- ══ 9. IMPORT STAGING — dry-run preview + permanent audit trail ════════
CREATE TABLE IF NOT EXISTS public.import_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('loanees','assets','group_members')),
  filename        TEXT,
  target_group_id UUID REFERENCES public.groups(id) ON DELETE SET NULL,  -- group_members imports
  options         JSONB,                 -- {apply_updates, create_missing_loanees, …}
  status          TEXT NOT NULL DEFAULT 'preview'
                    CHECK (status IN ('preview','committed','abandoned')),
  row_count       INT NOT NULL DEFAULT 0,
  ok_count        INT NOT NULL DEFAULT 0,
  dup_count       INT NOT NULL DEFAULT 0,
  error_count     INT NOT NULL DEFAULT 0,
  created_by      UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_import_batches_time ON public.import_batches (created_at DESC);

CREATE TABLE IF NOT EXISTS public.import_rows (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id   UUID NOT NULL REFERENCES public.import_batches(id) ON DELETE CASCADE,
  row_number INT NOT NULL,        -- 1-based line in the source file, so errors point at a real row
  raw        JSONB NOT NULL,      -- exactly what the client parsed out of the sheet
  normalized JSONB,               -- the server's cleaned view
  verdict    TEXT NOT NULL CHECK (verdict IN ('create','update','skip_duplicate','error')),
  message    TEXT,
  result_id  UUID                 -- loanee/asset id, stamped at commit
);
CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON public.import_rows (batch_id, row_number);


-- ══ 10. SECURITY / OPS TABLES ══════════════════════════════════
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID,
  email      TEXT,
  full_name  TEXT,
  action     TEXT,
  detail     TEXT,
  ip         TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_profile_id ON public.audit_logs (profile_id);

CREATE TABLE IF NOT EXISTS public.app_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level      TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  event      TEXT NOT NULL,
  detail     TEXT,
  profile_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  email      TEXT,
  page_url   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_logs_level      ON public.app_logs (level);
CREATE INDEX IF NOT EXISTS idx_app_logs_created_at ON public.app_logs (created_at DESC);

-- Singleton settings row (id is pinned to 1 by the CHECK).
CREATE TABLE IF NOT EXISTS public.app_settings (
  id                    SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  org_display_name      TEXT NOT NULL DEFAULT 'Houston Livestock Show and Rodeo',
  app_display_name      TEXT NOT NULL DEFAULT 'HLSR Asset Tracker',
  support_phone         TEXT,
  support_email         TEXT,
  -- The default loan length. 12 hours: the checkout form pre-fills
  -- now() + this, staff can override it or clear it for an indefinite loan.
  default_loan_hours    INT NOT NULL DEFAULT 12,
  -- Grace period before an item past its due date is reported as overdue.
  overdue_grace_hours   INT NOT NULL DEFAULT 0,
  require_out_condition BOOLEAN NOT NULL DEFAULT FALSE,
  pilot_mode            BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by            UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;


-- ══ 11. ELIGIBILITY — ONE definition, used by API, pickers and reports ══
-- An asset with no group restrictions is open to everyone. Otherwise the
-- loanee must belong to at least one of the asset's restricting groups.
-- Defined here rather than in JS so the checkout guard, the asset picker
-- and the reports can never drift apart.
CREATE OR REPLACE FUNCTION public.asset_eligible(p_asset UUID, p_loanee UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.asset_groups ag WHERE ag.asset_id = p_asset)
      OR EXISTS (
           SELECT 1
           FROM public.asset_groups ag
           JOIN public.group_members gm ON gm.group_id = ag.group_id
           WHERE ag.asset_id = p_asset AND gm.loanee_id = p_loanee
         );
$$;


-- ══ 12. THE VIEW behind the leader board, out-now and overdue ════════
-- "Overdue" is COMPUTED here, never stored. Storing it would need a timer
-- to flip the flag, and Azure Static Web Apps' managed Functions are
-- HTTP-only — there is no timer trigger to run one.
CREATE OR REPLACE VIEW public.v_open_loan_items AS
SELECT li.id            AS loan_item_id,
       li.loan_id,
       li.asset_id,
       li.checked_out_at,
       li.due_at,
       li.out_condition,
       li.out_notes,
       (li.due_at IS NOT NULL AND li.due_at < now()) AS overdue,
       CASE WHEN li.due_at IS NULL THEN NULL
            ELSE ROUND(EXTRACT(EPOCH FROM (now() - li.due_at)) / 3600.0, 1) END AS hours_overdue,
       ROUND(EXTRACT(EPOCH FROM (now() - li.checked_out_at)) / 3600.0, 1)       AS hours_out,
       a.asset_tag, a.title AS asset_title, a.serial, a.primary_photo_url,
       c.name AS category, c.icon AS category_icon,
       loc.name AS home_location,
       l.loanee_id, ln.full_name AS loanee_name, ln.phone_mobile AS loanee_phone,
       ln.email AS loanee_email, ln.position, ln.sub_committee,
       l.checked_out_by, p.full_name AS checked_out_by_name,
       l.notes AS loan_notes
FROM public.loan_items li
JOIN public.loans   l   ON l.id  = li.loan_id
JOIN public.loanees ln  ON ln.id = l.loanee_id
JOIN public.assets  a   ON a.id  = li.asset_id
LEFT JOIN public.asset_categories c   ON c.id   = a.category_id
LEFT JOIN public.asset_locations  loc ON loc.id = a.location_id
LEFT JOIN public.profiles p ON p.id = l.checked_out_by
WHERE li.checked_in_at IS NULL;


-- ══ 13. SEED — starter lookups, all editable in Admin → Lookups ════════
INSERT INTO public.asset_categories (name, icon, sort_order) VALUES
  ('Hand Tools',       'fa-screwdriver-wrench', 10),
  ('Power Tools',      'fa-plug-circle-bolt',   20),
  ('Carts',            'fa-cart-flatbed',       30),
  ('Golf Carts',       'fa-car-side',           40),
  ('Forklifts',        'fa-truck-ramp-box',     50),
  ('Front End Loaders','fa-tractor',            60),
  ('Radios',           'fa-walkie-talkie',      70),
  ('AV Equipment',     'fa-display',            80),
  ('Safety Equipment', 'fa-helmet-safety',      90),
  ('Keys & Access',    'fa-key',               100),
  ('Ladders',          'fa-stairs',            110),
  ('Generators',       'fa-charging-station',  120),
  ('Other',            'fa-box',               999)
ON CONFLICT DO NOTHING;

INSERT INTO public.asset_locations (name, sort_order) VALUES
  ('ROC Haybarn',                  10),
  ('NRG Center',                   20),
  ('NRG Arena',                    30),
  ('NRG Stadium',                  40),
  ('EAC/ADC',                      50),
  ('Shop / Maintenance Barn',      60),
  ('Warehouse',                    70),
  ('Off-site',                     90)
ON CONFLICT DO NOTHING;

INSERT INTO public.groups (name, description) VALUES
  ('Forklift Certified', 'Loanees with a current forklift operator certification'),
  ('Radio Authorized',   'Loanees cleared to carry event radios'),
  ('Grounds Crew',       'Grounds and setup sub-committee members')
ON CONFLICT DO NOTHING;

-- First admin: POST /api/auth/bootstrap with the BOOTSTRAP_SECRET app
-- setting (see SETUP-GUIDE.md step 4), then DELETE that app setting —
-- removing it permanently disables the endpoint. Alternatively generate a
-- hash with `node scripts/hash-password.js '<password>'` and INSERT by hand.
