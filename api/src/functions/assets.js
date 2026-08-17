// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — the catalog
//   GET    /api/assets                       any
//   GET    /api/assets/lookup?q=&for_loanee= staff, admin  (the picker)
//   GET    /api/assets/{id}                  any
//   GET    /api/assets/{id}/events           any
//   POST   /api/assets                       admin
//   PATCH  /api/assets/{id}                  admin
//   PATCH  /api/assets/{id}/groups           admin
//   POST   /api/assets/{id}/photos           admin
//   DELETE /api/assets/{id}/photos/{photoId} admin
//   POST   /api/assets/{id}/action           staff, admin
// ─────────────────────────────────────────────────────────────
const { app } = require('@azure/functions');
const { query, withTransaction } = require('../db');
const {
  json, err, errFromThrow, requireAuth, requireRole, logAudit, readJson, qs, uuidOrNull,
} = require('../middleware');
const blob = require('../blob');
const core = require('../assets-core');

const SELECT_LIST = `
  SELECT a.id, a.asset_tag, a.title, a.description, a.serial, a.status,
         a.primary_photo_url, a.notes, a.value_cents, a.purchase_date,
         a.category_id, c.name AS category, c.icon AS category_icon,
         -- Where this kind of thing goes when it breaks, so the
         -- send-for-repair form can pre-select without a second call.
         c.default_repair_shop_id, rs.name AS default_repair_shop,
         a.location_id, loc.name AS location,
         a.created_at, a.updated_at,
         (SELECT count(*) FROM public.asset_groups ag WHERE ag.asset_id = a.id)::int AS restriction_count,
         v.loanee_name AS current_loanee, v.loanee_id AS current_loanee_id,
         v.due_at AS current_due_at, v.overdue AS current_overdue,
         v.checked_out_at AS current_since
  FROM public.assets a
  LEFT JOIN public.asset_categories c   ON c.id   = a.category_id
  LEFT JOIN public.repair_shops     rs  ON rs.id  = c.default_repair_shop_id
  LEFT JOIN public.asset_locations  loc ON loc.id = a.location_id
  LEFT JOIN public.v_open_loan_items v  ON v.asset_id = a.id`;

app.http('assetsList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'assets',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const p = qs(request);
    const q = (p.get('q') || '').trim();
    const st = p.get('status');
    const limit = Math.min(parseInt(p.get('limit') || '200', 10) || 200, 1000);
    const offset = Math.max(parseInt(p.get('offset') || '0', 10) || 0, 0);

    const where = `
      WHERE ($1::text IS NULL OR a.status = $1)
        AND ($2::uuid IS NULL OR a.category_id = $2)
        AND ($3::uuid IS NULL OR a.location_id = $3)
        AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM public.asset_groups ag
                                         WHERE ag.asset_id = a.id AND ag.group_id = $4))
        AND ($5::text IS NULL OR a.asset_tag ILIKE '%'||$5||'%' OR a.title ILIKE '%'||$5||'%'
             OR a.serial ILIKE '%'||$5||'%' OR a.description ILIKE '%'||$5||'%')
        AND ($6::boolean IS NULL OR ($6 = TRUE) = EXISTS
              (SELECT 1 FROM public.asset_groups ag WHERE ag.asset_id = a.id))`;
    const restrictedOnly = p.get('restricted') === '1' ? true : (p.get('restricted') === '0' ? false : null);
    const params = [
      ['available', 'checked_out', 'maintenance', 'retired'].includes(st) ? st : null,
      uuidOrNull(p.get('category_id')), uuidOrNull(p.get('location_id')),
      uuidOrNull(p.get('group_id')), q || null, restrictedOnly,
    ];

    const rows = await query(
      `${SELECT_LIST} ${where} ORDER BY a.asset_tag LIMIT $7 OFFSET $8`, [...params, limit, offset]);
    const total = await query(`SELECT count(*)::int AS n FROM public.assets a ${where}`, params);
    const counts = await query(
      `SELECT status, count(*)::int AS n FROM public.assets GROUP BY status`);
    return json({
      rows: rows.rows,
      total: total.rows[0].n,
      by_status: Object.fromEntries(counts.rows.map(r => [r.status, r.n])),
    });
  },
});

// The picker behind both counter workflows. Returns `exact` separately
// so the client can auto-select on exact-match + Enter — which is what a
// keyboard-wedge barcode scanner produces, meaning handheld scanners
// work on day one even though camera scanning is out of scope for rev 1.
// `for_loanee` annotates every row with eligibility so ineligible items
// render disabled with a reason BEFORE anyone tries to hand them over.
app.http('assetsLookup', {
  methods: ['GET'], authLevel: 'anonymous', route: 'assets/lookup',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'staff', 'admin');
    if (error) return err(error, status);
    const p = qs(request);
    const q = (p.get('q') || '').trim();
    const forLoanee = uuidOrNull(p.get('for_loanee'));
    if (q.length < 2) return json({ exact: null, matches: [] });

    const r = await query(
      `SELECT a.id, a.asset_tag, a.title, a.serial, a.status, a.primary_photo_url,
              c.name AS category, c.icon AS category_icon,
              (lower(a.asset_tag) = lower($1) OR lower(coalesce(a.serial,'')) = lower($1)) AS is_exact,
              CASE WHEN $2::uuid IS NULL THEN TRUE ELSE public.asset_eligible(a.id, $2) END AS eligible,
              v.loanee_name AS current_loanee
       FROM public.assets a
       LEFT JOIN public.asset_categories c  ON c.id = a.category_id
       LEFT JOIN public.v_open_loan_items v ON v.asset_id = a.id
       WHERE a.status <> 'retired'
         AND ( lower(a.asset_tag) = lower($1)
            OR lower(coalesce(a.serial,'')) = lower($1)
            OR a.asset_tag ILIKE '%'||$1||'%'
            OR a.title ILIKE '%'||$1||'%'
            OR coalesce(a.serial,'') ILIKE '%'||$1||'%' )
       ORDER BY is_exact DESC, similarity(a.title, $1) DESC, a.asset_tag
       LIMIT 10`, [q, forLoanee]);

    const annotated = r.rows.map(a => {
      let blocked_reason = null;
      if (a.status !== 'available') {
        blocked_reason = a.current_loanee
          ? `Checked out to ${a.current_loanee}`
          : `Currently ${core.STATUS_LABEL[a.status] || a.status}`;
      } else if (!a.eligible) {
        blocked_reason = 'This person is not in a group allowed to receive it';
      }
      return { ...a, ok: !blocked_reason, blocked_reason };
    });
    return json({ exact: annotated.find(x => x.is_exact) || null, matches: annotated });
  },
});

app.http('assetsGet', {
  methods: ['GET'], authLevel: 'anonymous', route: 'assets/{id}',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const id = request.params.id;
    const r = await query(`${SELECT_LIST} WHERE a.id = $1`, [id]);
    if (!r.rows.length) return err('Asset not found', 404);
    const photos = await query(
      `SELECT id, url, caption, is_primary, sort_order FROM public.asset_photos
       WHERE asset_id = $1 ORDER BY is_primary DESC, sort_order, created_at`, [id]);
    const groups = await query(
      `SELECT g.id, g.name FROM public.asset_groups ag
       JOIN public.groups g ON g.id = ag.group_id WHERE ag.asset_id = $1 ORDER BY g.name`, [id]);
    const current = await query(
      `SELECT * FROM public.v_open_loan_items WHERE asset_id = $1`, [id]);
    return json({ ...r.rows[0], photos: photos.rows, groups: groups.rows, current: current.rows[0] || null });
  },
});

app.http('assetsEvents', {
  methods: ['GET'], authLevel: 'anonymous', route: 'assets/{id}/events',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const limit = Math.min(parseInt(qs(request).get('limit') || '100', 10) || 100, 500);
    const r = await query(
      `SELECT e.id, e.event, e.reason, e.payload, e.created_at, e.actor_role,
              p.full_name AS actor_name, ln.full_name AS loanee_name, ln.id AS loanee_id
       FROM public.asset_events e
       LEFT JOIN public.profiles p  ON p.id  = e.actor_id
       LEFT JOIN public.loanees  ln ON ln.id = e.loanee_id
       WHERE e.asset_id = $1 ORDER BY e.created_at DESC LIMIT $2`, [request.params.id, limit]);
    return json(r.rows);
  },
});

app.http('assetsCreate', {
  methods: ['POST'], authLevel: 'anonymous', route: 'assets',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const { asset_tag, title } = body || {};
    if (!asset_tag || !String(asset_tag).trim()) return err('An asset tag is required');
    if (!title || !String(title).trim()) return err('A title is required');
    if (String(asset_tag).length > 64) return err('Asset tag is too long (64 characters max)');

    try {
      const asset = await withTransaction(async (client) => {
        const r = await client.query(
          `INSERT INTO public.assets
             (asset_tag, title, description, category_id, location_id, serial, notes,
              purchase_date, value_cents, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [String(asset_tag).trim(), String(title).trim(), body.description || null,
           uuidOrNull(body.category_id), uuidOrNull(body.location_id), body.serial || null,
           body.notes || null, body.purchase_date || null, body.value_cents ?? null, user.sub]);
        const a = r.rows[0];
        for (const gid of (body.group_ids || [])) {
          await client.query(
            `INSERT INTO public.asset_groups (asset_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [a.id, gid]);
        }
        await core.writeEvent(client, {
          asset_id: a.id, event: 'created', actor: user,
          payload: { asset_tag: a.asset_tag, title: a.title },
        });
        return a;
      });
      await logAudit(request, {
        profile_id: user.sub, email: user.email,
        action: 'asset_created', detail: `${asset.asset_tag} — ${asset.title}` });
      return json(asset, 201);
    } catch (e) {
      if (e.code === '23505') return err(`Asset tag "${asset_tag}" is already in use`, 409);
      throw e;
    }
  },
});

app.http('assetsUpdate', {
  methods: ['PATCH'], authLevel: 'anonymous', route: 'assets/{id}',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const id = request.params.id;
    const { body, bad } = await readJson(request); if (bad) return bad;

    const cur = await query(
      `SELECT a.*, loc.name AS location_name FROM public.assets a
       LEFT JOIN public.asset_locations loc ON loc.id = a.location_id WHERE a.id = $1`, [id]);
    if (!cur.rows.length) return err('Asset not found', 404);
    const before = cur.rows[0];

    // status is deliberately NOT settable here. Every status change goes
    // through /assets/{id}/action → assets-core.performAction, so the
    // guarded transition and the event row can never be bypassed.
    if (body.status !== undefined) {
      return err('Use the maintenance / retire actions to change an asset\'s status', 400);
    }

    const sets = []; const vals = []; let i = 1;
    const push = (col, val) => { sets.push(`${col} = $${i++}`); vals.push(val); };
    if (body.asset_tag !== undefined) push('asset_tag', String(body.asset_tag).trim());
    if (body.title !== undefined) push('title', String(body.title).trim());
    for (const f of ['description', 'serial', 'notes']) if (body[f] !== undefined) push(f, body[f] || null);
    if (body.category_id !== undefined) push('category_id', uuidOrNull(body.category_id));
    if (body.location_id !== undefined) push('location_id', uuidOrNull(body.location_id));
    if (body.purchase_date !== undefined) push('purchase_date', body.purchase_date || null);
    if (body.value_cents !== undefined) push('value_cents', body.value_cents ?? null);
    if (!sets.length) return err('Nothing to update');
    sets.push(`updated_at = now()`);
    vals.push(id);

    try {
      const updated = await withTransaction(async (client) => {
        const r = await client.query(
          `UPDATE public.assets SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
        const a = r.rows[0];
        // A location move is its own event — "where has this thing been"
        // is a question people actually ask, and burying it inside a
        // generic 'updated' payload makes it unanswerable.
        const movedLocation = body.location_id !== undefined && body.location_id !== before.location_id;
        await core.writeEvent(client, {
          asset_id: id, event: movedLocation ? 'location_changed' : 'updated', actor: user,
          payload: movedLocation
            ? { from_location: before.location_name, to_location_id: a.location_id }
            : { fields: Object.keys(body) },
        });
        return a;
      });
      await logAudit(request, {
        profile_id: user.sub, email: user.email,
        action: 'asset_updated', detail: `${before.asset_tag}: ${Object.keys(body).join(', ')}` });
      return json(updated);
    } catch (e) {
      if (e.code === '23505') return err('That asset tag is already in use', 409);
      throw e;
    }
  },
});

app.http('assetsSetGroups', {
  methods: ['PATCH'], authLevel: 'anonymous', route: 'assets/{id}/groups',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const id = request.params.id;
    const { body, bad } = await readJson(request); if (bad) return bad;
    const ids = Array.isArray(body?.group_ids) ? body.group_ids : null;
    if (!ids) return err('group_ids must be an array (send [] to remove all restrictions)');

    const groups = await withTransaction(async (client) => {
      await client.query(`DELETE FROM public.asset_groups WHERE asset_id = $1`, [id]);
      for (const gid of ids) {
        await client.query(
          `INSERT INTO public.asset_groups (asset_id, group_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [id, gid]);
      }
      const r = await client.query(
        `SELECT g.id, g.name FROM public.asset_groups ag
         JOIN public.groups g ON g.id = ag.group_id WHERE ag.asset_id = $1 ORDER BY g.name`, [id]);
      await core.writeEvent(client, {
        asset_id: id, event: 'groups_changed', actor: user,
        payload: { groups: r.rows.map(g => g.name) },
      });
      return r.rows;
    });
    await logAudit(request, {
      profile_id: user.sub, email: user.email, action: 'asset_groups_changed',
      detail: `${id} → ${groups.map(g => g.name).join(', ') || '(unrestricted)'}` });
    return json({ groups });
  },
});

app.http('assetsPhotoAdd', {
  methods: ['POST'], authLevel: 'anonymous', route: 'assets/{id}/photos',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    if (!blob.configured()) {
      return err('Photo storage is not configured yet — add AZURE_STORAGE_CONNECTION_STRING', 503);
    }
    const id = request.params.id;
    const { body, bad } = await readJson(request); if (bad) return bad;
    if (!body?.data_url) return err('data_url is required');

    const exists = await query(`SELECT id FROM public.assets WHERE id = $1`, [id]);
    if (!exists.rows.length) return err('Asset not found', 404);

    let url;
    try { url = await blob.uploadDataUrl('asset', id, body.data_url); }
    catch (e) { return err(e.message, 400); }

    const photo = await withTransaction(async (client) => {
      // First photo on an asset becomes the primary automatically —
      // otherwise the list screens show a placeholder until someone
      // remembers to tick a box nobody knew about.
      const count = await client.query(
        `SELECT count(*)::int AS n FROM public.asset_photos WHERE asset_id = $1`, [id]);
      const makePrimary = body.is_primary === true || count.rows[0].n === 0;
      if (makePrimary) {
        await client.query(`UPDATE public.asset_photos SET is_primary = FALSE WHERE asset_id = $1`, [id]);
      }
      const r = await client.query(
        `INSERT INTO public.asset_photos (asset_id, url, caption, is_primary, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`, [id, url, body.caption || null, makePrimary, user.sub]);
      if (makePrimary) {
        await client.query(`UPDATE public.assets SET primary_photo_url = $2, updated_at = now() WHERE id = $1`, [id, url]);
      }
      await core.writeEvent(client, { asset_id: id, event: 'photo_added', actor: user, payload: { url } });
      return r.rows[0];
    });
    return json(photo, 201);
  },
});

app.http('assetsPhotoDelete', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'assets/{id}/photos/{photoId}',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const { id, photoId } = request.params;
    const gone = await withTransaction(async (client) => {
      const r = await client.query(
        `DELETE FROM public.asset_photos WHERE id = $1 AND asset_id = $2 RETURNING url, is_primary`,
        [photoId, id]);
      if (!r.rows.length) return null;
      if (r.rows[0].is_primary) {
        // Promote the next photo so the asset doesn't lose its thumbnail.
        const next = await client.query(
          `SELECT id, url FROM public.asset_photos WHERE asset_id = $1 ORDER BY sort_order, created_at LIMIT 1`, [id]);
        const url = next.rows[0]?.url || null;
        if (next.rows[0]) {
          await client.query(`UPDATE public.asset_photos SET is_primary = TRUE WHERE id = $1`, [next.rows[0].id]);
        }
        await client.query(`UPDATE public.assets SET primary_photo_url = $2, updated_at = now() WHERE id = $1`, [id, url]);
      }
      await core.writeEvent(client, { asset_id: id, event: 'photo_removed', actor: user });
      return r.rows[0];
    });
    if (!gone) return err('Photo not found', 404);
    await blob.remove(gone.url); // best effort; an orphaned blob is not an error
    return json({ ok: true });
  },
});

// The ONLY status-mutation path for the lifecycle actions.
app.http('assetsAction', {
  methods: ['POST'], authLevel: 'anonymous', route: 'assets/{id}/action',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'staff', 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const { action, reason, note } = body || {};
    if (!action) return err('action is required');
    try {
      const result = await core.performAction(request.params.id, action, user, { reason, note });
      await logAudit(request, {
        profile_id: user.sub, email: user.email,
        action: `asset_${action}`, detail: `${request.params.id}${reason ? ` — ${reason}` : ''}` });
      return json({ ok: true, ...result });
    } catch (e) { return errFromThrow(e); }
  },
});

module.exports = {};
