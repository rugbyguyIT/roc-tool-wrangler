-- ═══════════════════════════════════════════════════════════════════════
-- 008 — Colour and manufacturer on the open-items view.
--
-- Idempotent:  psql "$DATABASE_URL" -f api/migrations/008_open_items_markings.sql
--   Run 007 first; this reads the columns that one adds.
--
-- v_open_loan_items is what the leader board, the Out Now list on the
-- counter and the overdue report all read. Those are exactly the screens
-- where "which cart is that?" gets asked, so the two facts that answer it
-- have to be in the view, not just on the asset record.
--
-- The columns are APPENDED. CREATE OR REPLACE VIEW will not let an
-- existing column change name, type or position, so the block below is the
-- previous definition verbatim with two lines added at the end — not a
-- rewrite. Anything selecting * from this view keeps working unchanged.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.v_open_loan_items AS
 SELECT li.id AS loan_item_id,
    li.loan_id,
    li.asset_id,
    li.checked_out_at,
    li.due_at,
    li.out_condition,
    li.out_notes,
    li.due_at IS NOT NULL AND li.due_at < now() AS overdue,
        CASE
            WHEN li.due_at IS NULL THEN NULL::numeric
            ELSE round(EXTRACT(epoch FROM now() - li.due_at) / 3600.0, 1)
        END AS hours_overdue,
    round(EXTRACT(epoch FROM now() - li.checked_out_at) / 3600.0, 1) AS hours_out,
    a.asset_tag,
    a.title AS asset_title,
    a.serial,
    a.primary_photo_url,
    c.name AS category,
    c.icon AS category_icon,
    loc.name AS home_location,
    l.loanee_id,
    ln.full_name AS loanee_name,
    ln.phone_mobile AS loanee_phone,
    ln.email AS loanee_email,
    ln."position",
    ln.sub_committee,
    l.checked_out_by,
    p.full_name AS checked_out_by_name,
    l.notes AS loan_notes,
    a.color,
    a.manufacturer
   FROM loan_items li
     JOIN loans l ON l.id = li.loan_id
     JOIN loanees ln ON ln.id = l.loanee_id
     JOIN assets a ON a.id = li.asset_id
     LEFT JOIN asset_categories c ON c.id = a.category_id
     LEFT JOIN asset_locations loc ON loc.id = a.location_id
     LEFT JOIN profiles p ON p.id = l.checked_out_by
  WHERE li.checked_in_at IS NULL;
