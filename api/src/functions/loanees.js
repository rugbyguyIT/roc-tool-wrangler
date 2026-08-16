// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — loanees (the people who borrow; they never log in)
//   GET    /api/loanees              any signed-in role
//   GET    /api/loanees/lookup?q=    any  (powers the picker)
//   GET    /api/loanees/{id}         any
//   GET    /api/loanees/{id}/history any
//   POST   /api/loanees              admin
//   PATCH  /api/loanees/{id}         admin
//   PATCH  /api/loanees/{id}/groups  admin
//   DELETE /api/loanees/{id}         admin (soft delete)
// ──────────────────────────────────────────────────────────
const { app } = require('@azure/functions');
const { query, withTransaction } = require('../db');
const {
  json, err, requireAuth, requireRole, logAudit, readJson, qs, uuidOrNull,
} = require('../middleware');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Phone numbers arrive from a dozen sources in a dozen shapes. Store
// digits only so the soft dedupe key in the importer has something
// stable to match on; the UI formats for display.
function normPhone(v) {
  if (!v) return null;
  const d = String(v).replace(/\D/g, '');
  if (!d) return null;
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

app.http('loaneesList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'loanees',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const p = qs(request);
    const q = (p.get('q') || '').trim();
    const groupId = uuidOrNull(p.get('group_id'));
    const sub = p.get('sub_committee');
    const st = ['active', 'inactive'].includes(p.get('status')) ? p.get('status') : 'active';
    const limit = Math.min(parseInt(p.get('limit') || '100', 10) || 100, 500);
    const offset = Math.max(parseInt(p.get('offset') || '0', 10) || 0, 0);

    const where = `
      WHERE ln.status = $1
        AND ($2::text IS NULL OR ln.full_name ILIKE '%'||$2||'%' OR ln.email ILIKE '%'||$2||'%'
             OR ln.sub_committee ILIKE '%'||$2||'%' OR ln.phone_mobile LIKE '%'||$2||'%')
        AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM public.group_members gm
                                         WHERE gm.loanee_id = ln.id AND gm.group_id = $3))
        AND ($4::text IS NULL OR ln.sub_committee = $4)`;
    const params = [st, q || null, groupId, sub || null];

    const rows = await query(
      `SELECT ln.*,
              (SELECT count(*) FROM public.loan_items li
                 JOIN public.loans l ON l.id = li.loan_id
                WHERE l.loanee_id = ln.id AND li.checked_in_at IS NULL)::int AS items_out,
              COALESCE((SELECT array_agg(g.name ORDER BY g.name)
                        FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id
                        WHERE gm.loanee_id = ln.id), '{}') AS group_names
       FROM public.loanees ln ${where}
       ORDER BY ln.last_name, ln.first_name
       LIMIT $5 OFFSET $6`, [...params, limit, offset]);
    const total = await query(`SELECT count(*)::int AS n FROM public.loanees ln ${where}`, params);
    return json({ rows: rows.rows, total: total.rows[0].n });
  },
});

// Type-ahead for the check-out counter. Returns `exact` separately from
// `matches` so the picker can auto-select on an exact hit + Enter —
// which is exactly what a keyboard-wedge barcode scanner produces.
app.http('loaneesLookup', {
  methods: ['GET'], authLevel: 'anonymous', route: 'loanees/lookup',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const q = (qs(request).get('q') || '').trim();
    if (q.length < 2) return json({ exact: null, matches: [] });

    const r = await query(
      `SELECT ln.id, ln.full_name, ln.first_name, ln.last_name, ln.email, ln.phone_mobile,
              ln.position, ln.sub_committee,
              (lower(coalesce(ln.email,'')) = lower($1)) AS is_exact,
              (SELECT count(*) FROM public.loan_items li
                 JOIN public.loans l ON l.id = li.loan_id
                WHERE l.loanee_id = ln.id AND li.checked_in_at IS NULL)::int AS items_out,
              COALESCE((SELECT array_agg(g.name ORDER BY g.name)
                        FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id
                        WHERE gm.loanee_id = ln.id), '{}') AS group_names
       FROM public.loanees ln
       WHERE ln.status = 'active'
         AND ( lower(coalesce(ln.email,'')) = lower($1)
            OR ln.full_name ILIKE '%'||$1||'%'
            OR ln.last_name ILIKE $1||'%'
            OR ( regexp_replace($1, '\\D', '', 'g') <> ''
                 AND regexp_replace(coalesce(ln.phone_mobile,''), '\\D', '', 'g')
                     LIKE '%'||regexp_replace($1, '\\D', '', 'g')||'%' ) )
       ORDER BY is_exact DESC, similarity(ln.full_name, $1) DESC, ln.last_name
       LIMIT 10`, [q]);

    const exact = r.rows.find(x => x.is_exact) || null;
    return json({ exact, matches: r.rows });
  },
});

app.http('loaneesGet', {
  methods: ['GET'], authLevel: 'anonymous', route: 'loanees/{id}',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const id = request.params.id;
    const r = await query(`SELECT * FROM public.loanees WHERE id = $1`, [id]);
    if (!r.rows.length) return err('Loanee not found', 404);
    const groups = await query(
      `SELECT g.id, g.name FROM public.group_members gm
       JOIN public.groups g ON g.id = gm.group_id
       WHERE gm.loanee_id = $1 ORDER BY g.name`, [id]);
    const open = await query(
      `SELECT * FROM public.v_open_loan_items WHERE loanee_id = $1 ORDER BY checked_out_at DESC`, [id]);
    return json({ ...r.rows[0], groups: groups.rows, open_items: open.rows });
  },
});

app.http('loaneesHistory', {
  methods: ['GET'], authLevel: 'anonymous', route: 'loanees/{id}/history',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const p = qs(request);
    const r = await query(
      `SELECT li.id, li.checked_out_at, li.due_at, li.checked_in_at,
              li.out_condition, li.in_condition, li.in_notes,
              a.asset_tag, a.title AS asset_title, c.name AS category,
              po.full_name AS checked_out_by, pi.full_name AS checked_in_by,
              ROUND(EXTRACT(EPOCH FROM (COALESCE(li.checked_in_at, now()) - li.checked_out_at))/3600.0, 1) AS hours_held,
              (li.checked_in_at IS NULL) AS still_out,
              (li.checked_in_at IS NOT NULL AND li.due_at IS NOT NULL AND li.checked_in_at > li.due_at) AS returned_late
       FROM public.loan_items li
       JOIN public.loans   l ON l.id = li.loan_id
       JOIN public.assets  a ON a.id = li.asset_id
       LEFT JOIN public.asset_categories c ON c.id = a.category_id
       LEFT JOIN public.profiles po ON po.id = l.checked_out_by
       LEFT JOIN public.profiles pi ON pi.id = li.checked_in_by
       WHERE l.loanee_id = $1
         AND ($2::timestamptz IS NULL OR li.checked_out_at >= $2)
         AND ($3::timestamptz IS NULL OR li.checked_out_at <  $3)
       ORDER BY li.checked_out_at DESC
       LIMIT 500`,
      [request.params.id, p.get('from') || null, p.get('to') || null]);
    return json(r.rows);
  },
});

app.http('loaneesCreate', {
  methods: ['POST'], authLevel: 'anonymous', route: 'loanees',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const { first_name, last_name, email, phone_mobile, position, sub_committee, notes, group_ids } = body || {};
    if (!first_name || !last_name) return err('First and last name are required');
    if (email && !EMAIL_RE.test(String(email))) return err('That email address does not look right');

    try {
      const created = await withTransaction(async (client) => {
        const full = `${String(first_name).trim()} ${String(last_name).trim()}`;
        const r = await client.query(
          `INSERT INTO public.loanees
             (first_name, last_name, full_name, email, phone_mobile, position, sub_committee, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [String(first_name).trim(), String(last_name).trim(), full,
           email ? String(email).toLowerCase().trim() : null, normPhone(phone_mobile),
           position || null, sub_committee || null, notes || null, user.sub]);
        const loanee = r.rows[0];
        for (const gid of (group_ids || [])) {
          await client.query(
            `INSERT INTO public.group_members (group_id, loanee_id, added_by)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [gid, loanee.id, user.sub]);
        }
        return loanee;
      });
      await logAudit(request, {
        profile_id: user.sub, email: user.email,
        action: 'loanee_created', detail: created.full_name,
      });
      return json(created, 201);
    } catch (e) {
      if (e.code === '23505') return err('A loanee with that email address already exists', 409);
      throw e;
    }
  },
});

app.http('loaneesUpdate', {
  methods: ['PATCH'], authLevel: 'anonymous', route: 'loanees/{id}',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const id = request.params.id;
    const { body, bad } = await readJson(request); if (bad) return bad;

    const cur = await query(`SELECT * FROM public.loanees WHERE id = $1`, [id]);
    if (!cur.rows.length) return err('Loanee not found', 404);
    const before = cur.rows[0];

    const sets = []; const vals = []; let i = 1;
    const push = (col, val) => { sets.push(`${col} = $${i++}`); vals.push(val); };

    if (body.first_name !== undefined) push('first_name', String(body.first_name).trim());
    if (body.last_name !== undefined) push('last_name', String(body.last_name).trim());
    if (body.first_name !== undefined || body.last_name !== undefined) {
      const fn = body.first_name !== undefined ? String(body.first_name).trim() : before.first_name;
      const ln = body.last_name !== undefined ? String(body.last_name).trim() : before.last_name;
      push('full_name', `${fn} ${ln}`.trim());
    }
    if (body.email !== undefined) {
      if (body.email && !EMAIL_RE.test(String(body.email))) return err('That email address does not look right');
      push('email', body.email ? String(body.email).toLowerCase().trim() : null);
    }
    if (body.phone_mobile !== undefined) push('phone_mobile', normPhone(body.phone_mobile));
    for (const f of ['position', 'sub_committee', 'notes']) {
      if (body[f] !== undefined) push(f, body[f] || null);
    }
    if (body.status !== undefined) {
      if (!['active', 'inactive'].includes(body.status)) return err('Status must be active or inactive');
      push('status', body.status);
    }
    if (!sets.length) return err('Nothing to update');
    sets.push(`updated_at = now()`);
    vals.push(id);

    try {
      const r = await query(`UPDATE public.loanees SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
      await logAudit(request, {
        profile_id: user.sub, email: user.email,
        action: 'loanee_updated', detail: `${before.full_name}: ${Object.keys(body).join(', ')}`,
      });
      return json(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') return err('Another loanee already has that email address', 409);
      throw e;
    }
  },
});

app.http('loaneesSetGroups', {
  methods: ['PATCH'], authLevel: 'anonymous', route: 'loanees/{id}/groups',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const id = request.params.id;
    const { body, bad } = await readJson(request); if (bad) return bad;
    const ids = Array.isArray(body?.group_ids) ? body.group_ids : null;
    if (!ids) return err('group_ids must be an array (send [] to clear)');

    // Full replace, not a merge — the UI presents this as a checklist,
    // so "what I see is what is saved" has to hold.
    const groups = await withTransaction(async (client) => {
      await client.query(`DELETE FROM public.group_members WHERE loanee_id = $1`, [id]);
      for (const gid of ids) {
        await client.query(
          `INSERT INTO public.group_members (group_id, loanee_id, added_by)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [gid, id, user.sub]);
      }
      const r = await client.query(
        `SELECT g.id, g.name FROM public.group_members gm
         JOIN public.groups g ON g.id = gm.group_id WHERE gm.loanee_id = $1 ORDER BY g.name`, [id]);
      return r.rows;
    });
    await logAudit(request, {
      profile_id: user.sub, email: user.email,
      action: 'loanee_groups_changed', detail: `${id} → ${groups.map(g => g.name).join(', ') || '(none)'}`,
    });
    return json({ groups });
  },
});

// Soft delete. Refused while the person is still holding something —
// deactivating someone mid-loan would drop their name off the board and
// quietly orphan the equipment.
app.http('loaneesDelete', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'loanees/{id}',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const id = request.params.id;
    const open = await query(
      `SELECT count(*)::int AS n FROM public.loan_items li
       JOIN public.loans l ON l.id = li.loan_id
       WHERE l.loanee_id = $1 AND li.checked_in_at IS NULL`, [id]);
    if (open.rows[0].n > 0) {
      return err(`They still have ${open.rows[0].n} item(s) checked out — check those in first`, 409);
    }
    const r = await query(
      `UPDATE public.loanees SET status = 'inactive', updated_at = now() WHERE id = $1 RETURNING full_name`, [id]);
    if (!r.rows.length) return err('Loanee not found', 404);
    await logAudit(request, {
      profile_id: user.sub, email: user.email,
      action: 'loanee_deactivated', detail: r.rows[0].full_name,
    });
    return json({ ok: true });
  },
});

module.exports = {};
