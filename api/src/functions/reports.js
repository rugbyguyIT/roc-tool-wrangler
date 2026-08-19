// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — reports
//   GET /api/reports/out-now     any    (the board needs it)
//   GET /api/reports/overdue     any    (the board needs it)
//   GET /api/reports/by-loanee   admin
//   GET /api/reports/by-asset    admin
//   GET /api/reports/inventory   admin
//   GET /api/reports/activity    admin
//
// Every report takes optional from/to (ISO timestamps) and returns plain
// JSON rows. CSV export happens client-side from exactly these rows
// (js/csv.js), so the exported file always matches what's on screen and
// there is no second copy of any of this SQL.
// ─────────────────────────────────────────────────────────────
const { app } = require('@azure/functions');
const { query } = require('../db');
const { json, err, requireAuth, requireRole, qs, uuidOrNull } = require('../middleware');

const MAX_ROWS = 5000;
function range(p) {
  return [p.get('from') || null, p.get('to') || null];
}
function limitOf(p, def = 2000) {
  return Math.min(parseInt(p.get('limit') || String(def), 10) || def, MAX_ROWS);
}

// ── Currently out ────────────────────────────────────────
app.http('reportOutNow', {
  methods: ['GET'], authLevel: 'anonymous', route: 'reports/out-now',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const p = qs(request); const [from, to] = range(p);
    const r = await query(
      `SELECT * FROM public.v_open_loan_items
       WHERE ($1::timestamptz IS NULL OR checked_out_at >= $1)
         AND ($2::timestamptz IS NULL OR checked_out_at <  $2)
         AND ($3::uuid IS NULL OR asset_id IN (SELECT id FROM public.assets WHERE category_id = $3))
         AND ($4::text IS NULL OR sub_committee = $4)
       ORDER BY overdue DESC, checked_out_at DESC
       LIMIT $5`,
      [from, to, uuidOrNull(p.get('category_id')), p.get('sub_committee') || null, limitOf(p)]);
    return json({ rows: r.rows, count: r.rows.length });
  },
});

// ── Overdue ────────────────────────────────────────────
// Grace is read from settings rather than hardcoded, so "we don't chase
// anything under an hour late" is a setting change, not a deploy.
app.http('reportOverdue', {
  methods: ['GET'], authLevel: 'anonymous', route: 'reports/overdue',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const p = qs(request);
    // Grace is read with a scalar subselect + COALESCE, deliberately NOT a
    // CROSS JOIN: a cross join against a missing settings row returns zero
    // rows, which would silently report "nothing is overdue" — the most
    // dangerous possible wrong answer from this particular endpoint.
    const r = await query(
      `SELECT v.*,
              COALESCE((SELECT overdue_grace_hours FROM public.app_settings WHERE id = 1), 0) AS overdue_grace_hours
       FROM public.v_open_loan_items v
       WHERE v.due_at IS NOT NULL
         AND v.due_at + make_interval(
               hours => COALESCE((SELECT overdue_grace_hours FROM public.app_settings WHERE id = 1), 0)
             ) < now()
         AND ($1::uuid IS NULL OR v.asset_id IN (SELECT id FROM public.assets WHERE category_id = $1))
       ORDER BY v.due_at ASC
       LIMIT $2`, [uuidOrNull(p.get('category_id')), limitOf(p)]);
    return json({ rows: r.rows, count: r.rows.length });
  },
});

// ── Usage by loanee — current AND historical ───────────────────
// One row per loan line. The UI computes its per-person rollup from
// these same rows, so the summary and the detail can never disagree and
// there's only one query to maintain.
app.http('reportByLoanee', {
  methods: ['GET'], authLevel: 'anonymous', route: 'reports/by-loanee',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const p = qs(request); const [from, to] = range(p);
    const r = await query(
      `SELECT ln.id AS loanee_id, ln.full_name, ln.sub_committee, ln.position,
              ln.email, ln.phone_mobile,
              a.asset_tag, a.title AS asset_title, c.name AS category,
              li.checked_out_at, li.due_at, li.checked_in_at,
              li.out_condition, li.in_condition, li.in_notes,
              CASE WHEN li.checked_in_at IS NULL THEN 'out' ELSE 'returned' END AS state,
              ROUND(EXTRACT(EPOCH FROM (COALESCE(li.checked_in_at, now()) - li.checked_out_at))/3600.0, 1) AS hours_held,
              (li.checked_in_at IS NULL AND li.due_at IS NOT NULL AND li.due_at < now()) AS currently_overdue,
              (li.checked_in_at IS NOT NULL AND li.due_at IS NOT NULL AND li.checked_in_at > li.due_at) AS returned_late,
              p.full_name AS checked_out_by
       FROM public.loan_items li
       JOIN public.loans   l  ON l.id  = li.loan_id
       JOIN public.loanees ln ON ln.id = l.loanee_id
       JOIN public.assets  a  ON a.id  = li.asset_id
       LEFT JOIN public.asset_categories c ON c.id = a.category_id
       LEFT JOIN public.profiles p ON p.id = l.checked_out_by
       WHERE ($1::uuid IS NULL OR ln.id = $1)
         AND ($2::timestamptz IS NULL OR li.checked_out_at >= $2)
         AND ($3::timestamptz IS NULL OR li.checked_out_at <  $3)
         AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM public.group_members gm
                                          WHERE gm.loanee_id = ln.id AND gm.group_id = $4))
         AND ($5::text IS NULL OR ln.sub_committee = $5)
       -- Chronological, not alphabetical. This is the report the Reports
       -- page opens on, and "who borrowed what, most recently" is the
       -- question it answers; sorting by name buried the newest activity
       -- somewhere under the letter M.
       --
       -- Returned rows lead. Items still out are by definition the newest
       -- checkouts, so a plain date sort would fill page one with exactly
       -- the rows already on Out Now and on the board. They are still in
       -- the report, at the end, flagged "Still out".
       ORDER BY (li.checked_in_at IS NULL), li.checked_out_at DESC
       LIMIT $6`,
      [uuidOrNull(p.get('loanee_id')), from, to,
       uuidOrNull(p.get('group_id')), p.get('sub_committee') || null, limitOf(p)]);
    return json({ rows: r.rows, count: r.rows.length });
  },
});

// ── Usage by asset — the full custody chain for one item ───────
app.http('reportByAsset', {
  methods: ['GET'], authLevel: 'anonymous', route: 'reports/by-asset',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const p = qs(request); const [from, to] = range(p);
    const assetId = uuidOrNull(p.get('asset_id'));
    const r = await query(
      `SELECT a.id AS asset_id, a.asset_tag, a.title, a.serial, a.status,
              c.name AS category, loc.name AS home_location,
              ln.full_name AS loanee_name, ln.sub_committee,
              li.checked_out_at, li.due_at, li.checked_in_at,
              li.out_condition, li.in_condition, li.out_notes, li.in_notes, li.returned_status,
              po.full_name AS checked_out_by, pi.full_name AS checked_in_by,
              ROUND(EXTRACT(EPOCH FROM (COALESCE(li.checked_in_at, now()) - li.checked_out_at))/3600.0, 1) AS hours_held,
              (li.checked_in_at IS NOT NULL AND li.due_at IS NOT NULL AND li.checked_in_at > li.due_at) AS returned_late
       FROM public.assets a
       LEFT JOIN public.asset_categories c   ON c.id   = a.category_id
       LEFT JOIN public.asset_locations  loc ON loc.id = a.location_id
       LEFT JOIN public.loan_items li ON li.asset_id = a.id
             AND ($2::timestamptz IS NULL OR li.checked_out_at >= $2)
             AND ($3::timestamptz IS NULL OR li.checked_out_at <  $3)
       LEFT JOIN public.loans   l  ON l.id  = li.loan_id
       LEFT JOIN public.loanees ln ON ln.id = l.loanee_id
       LEFT JOIN public.profiles po ON po.id = l.checked_out_by
       LEFT JOIN public.profiles pi ON pi.id = li.checked_in_by
       WHERE ($1::uuid IS NULL OR a.id = $1)
       ORDER BY a.asset_tag, li.checked_out_at DESC NULLS LAST
       LIMIT $4`, [assetId, from, to, limitOf(p)]);
    return json({ rows: r.rows, count: r.rows.length });
  },
});

// ── Inventory — one ROLLUP query, three views ──────────────────
// group_by chooses which projection the UI renders (status / category ×
// status / location × status) rather than issuing three queries.
app.http('reportInventory', {
  methods: ['GET'], authLevel: 'anonymous', route: 'reports/inventory',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const r = await query(
      `SELECT COALESCE(c.name, '(uncategorized)') AS category,
              COALESCE(loc.name, '(no location)') AS location,
              COUNT(*)::int                                              AS asset_count,
              COUNT(*) FILTER (WHERE a.status = 'available')::int        AS available,
              COUNT(*) FILTER (WHERE a.status = 'checked_out')::int      AS checked_out,
              COUNT(*) FILTER (WHERE a.status = 'maintenance')::int      AS maintenance,
              COUNT(*) FILTER (WHERE a.status = 'retired')::int          AS retired,
              ROUND(SUM(COALESCE(a.value_cents, 0)) / 100.0, 2)          AS total_value,
              GROUPING(c.name) AS g_category, GROUPING(loc.name) AS g_location
       FROM public.assets a
       LEFT JOIN public.asset_categories c   ON c.id   = a.category_id
       LEFT JOIN public.asset_locations  loc ON loc.id = a.location_id
       GROUP BY ROLLUP (c.name, loc.name)
       ORDER BY g_category, category NULLS LAST, g_location, location NULLS LAST`);
    return json({ rows: r.rows, count: r.rows.length });
  },
});

// ── Activity log ────────────────────────────────────────
app.http('reportActivity', {
  methods: ['GET'], authLevel: 'anonymous', route: 'reports/activity',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const p = qs(request); const [from, to] = range(p);
    const r = await query(
      `SELECT e.created_at, e.event, e.reason, e.payload, e.actor_role,
              a.asset_tag, a.title AS asset_title,
              ln.full_name AS loanee_name,
              p.full_name  AS actor_name
       FROM public.asset_events e
       JOIN public.assets a ON a.id = e.asset_id
       LEFT JOIN public.loanees  ln ON ln.id = e.loanee_id
       LEFT JOIN public.profiles p  ON p.id  = e.actor_id
       WHERE ($1::timestamptz IS NULL OR e.created_at >= $1)
         AND ($2::timestamptz IS NULL OR e.created_at <  $2)
         AND ($3::text IS NULL OR e.event = $3)
         AND ($4::uuid IS NULL OR e.actor_id = $4)
         AND ($5::uuid IS NULL OR e.asset_id = $5)
       ORDER BY e.created_at DESC
       LIMIT $6`,
      [from, to, p.get('event') || null, uuidOrNull(p.get('actor_id')),
       uuidOrNull(p.get('asset_id')), limitOf(p)]);
    return json({ rows: r.rows, count: r.rows.length });
  },
});

module.exports = {};
