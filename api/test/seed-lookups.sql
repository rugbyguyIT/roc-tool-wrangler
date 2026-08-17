-- Copied from api/migrations/001_schema.sql so the suites can restore the
-- lookup lists that TRUNCATE ... CASCADE removes.
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
