// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — groups
//
// A group holds LOANEES, and an asset restricted to a group can only be
// checked out TO someone in that group. Groups do NOT restrict which
// staff member may operate the counter. (This is the "ROC Cart 01 —
// Kyle ONLY" pattern from the old system.)
//
//   GET    /api/groups                          any
//   POST   /api/groups                          admin
//   PATCH  /api/groups/{id}                     admin
//   DELETE /api/groups/{id}                     admin
//   GET    /api/groups/{id}/members             any
//   POST   /api/groups/{id}/members             admin
//   DELETE /api/groups/{id}/members/{loaneeId}  admin
//   GET    /api/groups/{id}/assets              any
// ─────────────────────────────────────────────────────────────
const { app } = require('@azure/functions');
const { query } = require('../db');
const { json, err, requireAuth, requireRole, logAudit, readJson, qs } = require('../middleware');

app.http('groupsList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'groups',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const r = await query(
      `SELECT g.*,
              (SELECT count(*) FROM public.group_members gm WHERE gm.group_id = g.id)::int AS member_count,
              (SELECT count(*) FROM public.asset_groups ag WHERE ag.group_id = g.id)::int  AS asset_count,
              -- How many people can sign in BECAUSE of this group, and
              -- would stop being able to if it were unticked. Counted here
              -- rather than in the browser so the warning on the form is
              -- about the real roster and not about whatever the page
              -- happened to have loaded.
              (SELECT count(*) FROM public.group_members gm
                 JOIN public.loanees  ln ON ln.id = gm.loanee_id
                 JOIN public.profiles p  ON p.member_number = ln.member_number
                WHERE gm.group_id = g.id
                  AND p.status = 'active' AND p.role <> 'admin'
                  AND ln.member_number IS NOT NULL)::int AS login_count
       FROM public.groups g ORDER BY g.active DESC, lower(g.name)`);
    return json(r.rows);
  },
});

app.http('groupsCreate', {
  methods: ['POST'], authLevel: 'anonymous', route: 'groups',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    if (!body?.name || !String(body.name).trim()) return err('A group name is required');
    try {
      const r = await query(
        `INSERT INTO public.groups (name, description, can_login, created_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        // Defaults OFF. Creating a group is a small deliberate act; "and
        // this one may also sign in to the app" should be a second one,
        // not something that happens because a field was left out.
        [String(body.name).trim(), body.description || null, !!body.can_login, user.sub]);
      await logAudit(request, {
        profile_id: user.sub, email: user.email, action: 'group_created', detail: r.rows[0].name });
      return json({ ...r.rows[0], member_count: 0, asset_count: 0 }, 201);
    } catch (e) {
      if (e.code === '23505') return err('A group with that name already exists', 409);
      throw e;
    }
  },
});

app.http('groupsUpdate', {
  methods: ['PATCH'], authLevel: 'anonymous', route: 'groups/{id}',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const sets = []; const vals = []; let i = 1;
    if (body.name !== undefined) { sets.push(`name = $${i++}`); vals.push(String(body.name).trim()); }
    if (body.description !== undefined) { sets.push(`description = $${i++}`); vals.push(body.description || null); }
    if (body.active !== undefined) { sets.push(`active = $${i++}`); vals.push(!!body.active); }
    if (body.can_login !== undefined) { sets.push(`can_login = $${i++}`); vals.push(!!body.can_login); }
    if (!sets.length) return err('Nothing to update');
    vals.push(request.params.id);
    try {
      const r = await query(`UPDATE public.groups SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
      if (!r.rows.length) return err('Group not found', 404);
      await logAudit(request, {
        profile_id: user.sub, email: user.email, action: 'group_updated', detail: r.rows[0].name });
      return json(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') return err('A group with that name already exists', 409);
      throw e;
    }
  },
});

// Deleting a group cascades its membership and its asset restrictions.
// Dropping the restrictions is the dangerous half: an asset that was
// "Forklift Certified only" silently becomes available to everyone. So
// this refuses unless the caller has seen the count and confirmed.
app.http('groupsDelete', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'groups/{id}',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const id = request.params.id;
    const confirm = qs(request).get('confirm') === '1';

    const g = await query(`SELECT name FROM public.groups WHERE id = $1`, [id]);
    if (!g.rows.length) return err('Group not found', 404);
    const used = await query(`SELECT count(*)::int AS n FROM public.asset_groups WHERE group_id = $1`, [id]);

    if (used.rows[0].n > 0 && !confirm) {
      return err(
        `${used.rows[0].n} asset(s) are restricted to this group. Deleting it makes them available to everyone.`,
        409, { requires_confirm: true, asset_count: used.rows[0].n });
    }
    await query(`DELETE FROM public.groups WHERE id = $1`, [id]);
    await logAudit(request, {
      profile_id: user.sub, email: user.email, action: 'group_deleted',
      detail: `${g.rows[0].name} (freed ${used.rows[0].n} asset restriction(s))` });
    return json({ ok: true });
  },
});

app.http('groupMembersList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'groups/{id}/members',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const q = (qs(request).get('q') || '').trim();
    const r = await query(
      `SELECT ln.id, ln.full_name, ln.first_name, ln.last_name, ln.email, ln.phone_mobile,
              ln.position, ln.sub_committee, ln.status, gm.created_at AS added_at
       FROM public.group_members gm
       JOIN public.loanees ln ON ln.id = gm.loanee_id
       WHERE gm.group_id = $1
         AND ($2::text IS NULL OR ln.full_name ILIKE '%'||$2||'%' OR ln.email ILIKE '%'||$2||'%')
       ORDER BY ln.last_name, ln.first_name`, [request.params.id, q || null]);
    return json(r.rows);
  },
});

app.http('groupMembersAdd', {
  methods: ['POST'], authLevel: 'anonymous', route: 'groups/{id}/members',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const ids = Array.isArray(body?.loanee_ids) ? body.loanee_ids : [];
    if (!ids.length) return err('loanee_ids must be a non-empty array');

    const r = await query(
      `INSERT INTO public.group_members (group_id, loanee_id, added_by)
       SELECT $1, x, $3 FROM unnest($2::uuid[]) AS x
       ON CONFLICT DO NOTHING RETURNING loanee_id`,
      [request.params.id, ids, user.sub]);
    await logAudit(request, {
      profile_id: user.sub, email: user.email, action: 'group_members_added',
      detail: `${r.rows.length} added to group ${request.params.id}` });
    return json({ added: r.rows.length, skipped: ids.length - r.rows.length });
  },
});

app.http('groupMembersRemove', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'groups/{id}/members/{loaneeId}',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    await query(`DELETE FROM public.group_members WHERE group_id = $1 AND loanee_id = $2`,
      [request.params.id, request.params.loaneeId]);
    await logAudit(request, {
      profile_id: user.sub, email: user.email, action: 'group_member_removed',
      detail: `${request.params.loaneeId} from ${request.params.id}` });
    return json({ ok: true });
  },
});

app.http('groupAssetsList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'groups/{id}/assets',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const r = await query(
      `SELECT a.id, a.asset_tag, a.title, a.status, a.primary_photo_url, c.name AS category
       FROM public.asset_groups ag
       JOIN public.assets a ON a.id = ag.asset_id
       LEFT JOIN public.asset_categories c ON c.id = a.category_id
       WHERE ag.group_id = $1 ORDER BY a.asset_tag`, [request.params.id]);
    return json(r.rows);
  },
});

module.exports = {};
