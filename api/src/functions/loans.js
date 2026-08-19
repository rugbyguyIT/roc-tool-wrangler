// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — custody
//   POST /api/checkout                staff, admin
//   POST /api/checkin                 staff, admin
//   POST /api/loans/{id}/checkin-all  staff, admin
//   POST /api/loans/{id}/extend       staff, admin
//   GET  /api/loans                   any
//   GET  /api/loans/open              any   ← the leader board
//   GET  /api/loans/{id}              any
//   GET  /api/eligibility             staff, admin
//
// All the interesting logic lives in assets-core.js. These handlers do
// input shaping, the default-due-date rule, and audit logging.
// ─────────────────────────────────────────────────────────────
const { app } = require('@azure/functions');
const { query } = require('../db');
const {
  json, err, errFromThrow, requireAuth, requireRole, logAudit, readJson, qs, uuidOrNull,
} = require('../middleware');
const core = require('../assets-core');

// The 12-hour rule. If the client sends no due_at at all we apply the
// configured default (app_settings.default_loan_hours, 12 by default).
// Sending due_at: null EXPLICITLY means indefinite, and is honoured —
// that distinction is why this checks `undefined`, not falsiness.
const FALLBACK_LOAN_HOURS = 12;

async function resolveDueAt(body) {
  if (body.due_at !== undefined) return body.due_at || null;
  const s = await query(`SELECT default_loan_hours FROM public.app_settings WHERE id = 1`);
  // A missing settings row falls back to 12 rather than to "indefinite".
  // Silently handing out equipment with no due date because a config row
  // vanished is exactly the failure this app exists to prevent; an
  // explicit `due_at: null` from the client is still honoured above.
  const hours = s.rows[0]?.default_loan_hours ?? FALLBACK_LOAN_HOURS;
  if (hours <= 0) return null;
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

app.http('checkout', {
  methods: ['POST'], authLevel: 'anonymous', route: 'checkout',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'staff', 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const { loanee_id } = body || {};
    if (!loanee_id) return err('Choose who is taking the equipment');

    // Accept either a plain list of ids or per-item detail; normalize to
    // per-item so the core only has one shape to think about.
    const items = Array.isArray(body.items) && body.items.length
      ? body.items
      : (body.asset_ids || []).map(id => ({ asset_id: id }));
    if (!items.length) return err('Add at least one item to the cart');

    const due_at = await resolveDueAt(body);

    try {
      const result = await core.performCheckout(loanee_id, items, user, { due_at, notes: body.notes });
      await logAudit(request, {
        profile_id: user.sub, email: user.email, action: 'checkout',
        detail: `${result.items.length} item(s) to ${result.loanee.full_name}: ${result.items.map(i => i.asset_tag).join(', ')}`,
      });
      return json(result, 201);
    } catch (e) { return errFromThrow(e); }
  },
});

app.http('checkin', {
  methods: ['POST'], authLevel: 'anonymous', route: 'checkin',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'staff', 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const ids = Array.isArray(body?.loan_item_ids) ? body.loan_item_ids : [];
    if (!ids.length) return err('Select at least one item to check in');
    try {
      const result = await core.performCheckin(ids, user, {
        in_condition: body.in_condition, in_notes: body.in_notes,
        to_status: body.to_status, per_item: body.per_item,
      });
      await logAudit(request, {
        profile_id: user.sub, email: user.email, action: 'checkin',
        detail: `${result.checked_in.length} item(s): ${result.checked_in.map(i => i.asset_tag).join(', ')}`,
      });
      return json(result);
    } catch (e) { return errFromThrow(e); }
  },
});

app.http('loanCheckinAll', {
  methods: ['POST'], authLevel: 'anonymous', route: 'loans/{id}/checkin-all',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'staff', 'admin');
    if (error) return err(error, status);
    const { body } = await readJson(request);
    const open = await query(
      `SELECT id FROM public.loan_items WHERE loan_id = $1 AND checked_in_at IS NULL`, [request.params.id]);
    if (!open.rows.length) return err('Nothing left open on that loan', 409);
    try {
      const result = await core.performCheckin(open.rows.map(r => r.id), user, {
        in_condition: body?.in_condition, in_notes: body?.in_notes,
      });
      await logAudit(request, {
        profile_id: user.sub, email: user.email, action: 'checkin_all',
        detail: `loan ${request.params.id}: ${result.checked_in.length} item(s)` });
      return json(result);
    } catch (e) { return errFromThrow(e); }
  },
});

app.http('loanExtend', {
  methods: ['POST'], authLevel: 'anonymous', route: 'loans/{id}/extend',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'staff', 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    if (body.due_at === undefined) return err('due_at is required (send null for indefinite)');
    try {
      const result = await core.performExtend(request.params.id, body.due_at, user, {
        loan_item_ids: body.loan_item_ids, reason: body.reason,
      });
      await logAudit(request, {
        profile_id: user.sub, email: user.email, action: 'loan_extended',
        detail: `loan ${request.params.id} → ${body.due_at || 'indefinite'}` });
      return json(result);
    } catch (e) { return errFromThrow(e); }
  },
});

// Everything currently out. This is what the leader PWA polls, so it is
// readable by every role including the read-only leader.
// ═════════════════════════════════════════════════════════════════════
// 'loans/open' and 'loans/{id}' both match GET /api/loans/open, and the
// host does NOT reliably prefer the literal — in production the template
// won, so the board's request arrived here as id="open" and Postgres
// answered "invalid input syntax for type uuid". A 500 on the one screen
// leadership opens, and on the counter.
//
// Rather than depend on route precedence, the literal handler is a plain
// function that BOTH registrations call. Whichever way the host resolves
// it, the same code runs. The same shape is used in loanees.js and
// assets.js, which had the identical collision.
// ═════════════════════════════════════════════════════════════════════
async function openLoansHandler(request) {
  {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const p = qs(request);
    const r = await query(
      `SELECT v.* FROM public.v_open_loan_items v
       WHERE ($1::uuid IS NULL OR v.asset_id IN (SELECT id FROM public.assets WHERE category_id = $1))
         AND ($2::text IS NULL OR v.sub_committee = $2)
         AND ($3::boolean IS NOT TRUE OR v.overdue)
       ORDER BY v.overdue DESC, v.due_at ASC NULLS LAST, v.checked_out_at DESC`,
      [uuidOrNull(p.get('category_id')), p.get('sub_committee') || null, p.get('overdue') === '1']);
    const stats = await query(
      `SELECT
         (SELECT count(*) FROM public.v_open_loan_items)::int                    AS out_now,
         (SELECT count(*) FROM public.v_open_loan_items WHERE overdue)::int      AS overdue,
         (SELECT count(*) FROM public.assets WHERE status='available')::int      AS available,
         (SELECT count(*) FROM public.assets WHERE status='maintenance')::int    AS maintenance`);
    return json({ rows: r.rows, stats: stats.rows[0] });
  }
}

app.http('loansOpen', {
  methods: ['GET'], authLevel: 'anonymous', route: 'loans/open',
  handler: openLoansHandler,
});

app.http('loansList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'loans',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const p = qs(request);
    const limit = Math.min(parseInt(p.get('limit') || '100', 10) || 100, 500);
    const offset = Math.max(parseInt(p.get('offset') || '0', 10) || 0, 0);
    const where = `
      WHERE ($1::uuid IS NULL OR l.loanee_id = $1)
        AND ($2::boolean IS NOT TRUE OR l.closed_at IS NULL)
        AND ($3::timestamptz IS NULL OR l.checked_out_at >= $3)
        AND ($4::timestamptz IS NULL OR l.checked_out_at <  $4)`;
    const params = [uuidOrNull(p.get('loanee_id')), p.get('open') === '1', p.get('from') || null, p.get('to') || null];

    const rows = await query(
      `SELECT l.*, ln.full_name AS loanee_name, ln.sub_committee, p.full_name AS checked_out_by_name,
              (SELECT count(*) FROM public.loan_items li WHERE li.loan_id = l.id)::int AS item_count,
              (SELECT count(*) FROM public.loan_items li
                WHERE li.loan_id = l.id AND li.checked_in_at IS NULL)::int AS open_count,
              COALESCE((SELECT json_agg(json_build_object(
                          'id', li.id, 'asset_id', li.asset_id, 'asset_tag', a.asset_tag,
                          'asset_title', a.title, 'due_at', li.due_at,
                          'checked_in_at', li.checked_in_at, 'in_condition', li.in_condition)
                        ORDER BY a.asset_tag)
                       FROM public.loan_items li JOIN public.assets a ON a.id = li.asset_id
                       WHERE li.loan_id = l.id), '[]'::json) AS items
       FROM public.loans l
       JOIN public.loanees ln ON ln.id = l.loanee_id
       LEFT JOIN public.profiles p ON p.id = l.checked_out_by
       ${where}
       ORDER BY l.checked_out_at DESC LIMIT $5 OFFSET $6`, [...params, limit, offset]);
    const total = await query(`SELECT count(*)::int AS n FROM public.loans l ${where}`, params);
    return json({ rows: rows.rows, total: total.rows[0].n });
  },
});

app.http('loansGet', {
  methods: ['GET'], authLevel: 'anonymous', route: 'loans/{id}',
  handler: async (request) => {
    // See the note above openLoansHandler: this template also matches
    // /api/loans/open, and in production it is the one that wins.
    if (request.params.id === 'open') return openLoansHandler(request);

    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    // Anything that is not a UUID cannot be a loan id. Answer 404 rather
    // than handing it to Postgres, which raises 22P02 and surfaces as a
    // 500 with a database error message in it.
    if (!uuidOrNull(request.params.id)) return err('Loan not found', 404);
    const r = await query(
      `SELECT l.*, ln.full_name AS loanee_name, ln.email AS loanee_email,
              ln.phone_mobile AS loanee_phone, ln.sub_committee, ln.position,
              p.full_name AS checked_out_by_name
       FROM public.loans l
       JOIN public.loanees ln ON ln.id = l.loanee_id
       LEFT JOIN public.profiles p ON p.id = l.checked_out_by
       WHERE l.id = $1`, [request.params.id]);
    if (!r.rows.length) return err('Loan not found', 404);
    const items = await query(
      `SELECT li.*, a.asset_tag, a.title AS asset_title, a.primary_photo_url,
              c.name AS category, pi.full_name AS checked_in_by_name,
              (li.checked_in_at IS NULL AND li.due_at IS NOT NULL AND li.due_at < now()) AS overdue
       FROM public.loan_items li
       JOIN public.assets a ON a.id = li.asset_id
       LEFT JOIN public.asset_categories c ON c.id = a.category_id
       LEFT JOIN public.profiles pi ON pi.id = li.checked_in_by
       WHERE li.loan_id = $1 ORDER BY a.asset_tag`, [request.params.id]);
    return json({ ...r.rows[0], items: items.rows });
  },
});

// Live cart validation. The cart calls this every time an item is added
// so a blocked row shows its reason inline instead of at submit time.
app.http('eligibility', {
  methods: ['GET'], authLevel: 'anonymous', route: 'eligibility',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'staff', 'admin');
    if (error) return err(error, status);
    const p = qs(request);
    const ids = (p.get('asset_ids') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return json([]);
    return json(await core.checkEligibility(uuidOrNull(p.get('loanee_id')), ids));
  },
});

module.exports = {};
