// ═══════════════════════════════════════════════════════════════════════
// Repairs — an asset physically away being fixed.
//   GET  /api/repairs                 staff+  open by default, ?state=closed|all
//   POST /api/repairs                 staff+  send an asset out
//   POST /api/repairs/{id}/return     staff+  receive it back
//   GET  /api/repair-shops            staff+  who does the work
//   POST /api/repair-shops            admin   add a shop
//   PATCH /api/repair-shops/{id}      admin   rename / deactivate
//
// A repair is NOT a loan. Nobody borrowed the forklift; it is at Buildings
// and Grounds because it is broken. Modelling it as a check-out would put
// B&G in every loanee report and make two real questions unanswerable:
// how often does this asset break, and who had it when it broke.
//
// While away the asset sits at 'maintenance', which the existing
// eligibility rules already exclude from check-out — so nothing else in
// the app needed to learn about repairs to stop handing out a broken tool.
// ═══════════════════════════════════════════════════════════════════════
const { app } = require('@azure/functions');
const { query, withTransaction } = require('../db');
const {
  json, err, requireRole, logAudit, readJson, qs, uuidOrNull,
} = require('../middleware');
const core = require('../assets-core');

const OUTCOMES = ['repaired', 'no_fault_found', 'beyond_repair', 'returned_unrepaired'];

// ═══ LIST ══════════════════════════════════════════════════════════════
app.http('repairsList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'repairs',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'staff', 'admin', 'leader');
    if (error) return err(error, status);
    const p = qs(request);
    const state = p.get('state') || 'open';

    if (state === 'open') {
      const r = await query(`SELECT * FROM public.v_open_repairs ORDER BY sent_at`);
      return json({ rows: r.rows, state });
    }

    const closedOnly = state === 'closed';
    const r = await query(
      `SELECT r.*, a.asset_tag, a.title AS asset_title,
              s.name AS shop_name, ln.full_name AS last_held_by,
              ps.full_name AS sent_by_name, pr.full_name AS received_by_name
       FROM public.asset_repairs r
       JOIN public.assets a           ON a.id  = r.asset_id
       LEFT JOIN public.repair_shops s ON s.id = r.shop_id
       LEFT JOIN public.loanees ln     ON ln.id = r.loanee_id
       LEFT JOIN public.profiles ps    ON ps.id = r.sent_by
       LEFT JOIN public.profiles pr    ON pr.id = r.received_by
       WHERE ($1::bool IS FALSE OR r.returned_at IS NOT NULL)
       ORDER BY r.sent_at DESC LIMIT 500`, [closedOnly]);
    return json({ rows: r.rows, state });
  },
});

// ═══ SEND FOR REPAIR ═══════════════════════════════════════════════════
app.http('repairSend', {
  methods: ['POST'], authLevel: 'anonymous', route: 'repairs',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'staff', 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;

    const assetId = uuidOrNull(body?.asset_id);
    const shopId = uuidOrNull(body?.shop_id);
    const fault = String(body?.reported_fault || '').trim();

    if (!assetId) return err('Which asset is going out?');
    if (!fault) return err('Describe what is wrong with it — the shop needs to know, and so does whoever reads this in six months.');

    try {
      const out = await withTransaction(async (client) => {
        const a = await client.query(
          `SELECT id, asset_tag, title, status FROM public.assets WHERE id = $1 FOR UPDATE`, [assetId]);
        if (!a.rows.length) throw { status: 404, message: 'That asset no longer exists.' };
        const asset = a.rows[0];

        if (asset.status === 'retired') {
          throw { status: 409, message: `${asset.asset_tag} is retired — un-retire it first if it is coming back into service.` };
        }
        if (asset.status === 'checked_out') {
          throw { status: 409, message: `${asset.asset_tag} is still checked out. Check it in first, marking it damaged, then send it for repair.` };
        }
        // The partial unique index enforces this too; checking here means a
        // readable message instead of a constraint violation.
        const open = await client.query(
          `SELECT id FROM public.asset_repairs WHERE asset_id = $1 AND returned_at IS NULL`, [assetId]);
        if (open.rows.length) {
          throw { status: 409, message: `${asset.asset_tag} is already away for repair.` };
        }

        const r = await client.query(
          `INSERT INTO public.asset_repairs
             (asset_id, shop_id, reported_fault, loanee_id, expected_back, sent_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [assetId, shopId, fault, uuidOrNull(body.loanee_id),
           body.expected_back ? new Date(body.expected_back) : null, user.sub]);

        await client.query(
          `UPDATE public.assets SET status = 'maintenance', updated_at = now() WHERE id = $1`, [assetId]);

        await core.writeEvent(client, {
          asset_id: assetId, loanee_id: uuidOrNull(body.loanee_id),
          event: 'sent_for_repair', actor: user, reason: fault,
          payload: { from_status: asset.status, to_status: 'maintenance', shop_id: shopId,
                     expected_back: body.expected_back || null },
        });
        // Paired so the asset's own history reads as one timeline.
        await core.writeEvent(client, {
          asset_id: assetId, event: 'maintenance_start', actor: user, reason: fault,
        });

        return r.rows[0];
      });

      await logAudit(request, {
        profile_id: user.sub, email: user.email, full_name: user.name,
        action: 'asset_sent_for_repair', detail: `${assetId} — ${fault}`,
      });
      return json({ repair: out }, 201);
    } catch (e) {
      if (e && e.status) return err(e.message, e.status);
      throw e;
    }
  },
});

// ═══ RECEIVE BACK ══════════════════════════════════════════════════════
app.http('repairReturn', {
  methods: ['POST'], authLevel: 'anonymous', route: 'repairs/{id}/return',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'staff', 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;

    const repairId = uuidOrNull(request.params.id);
    if (!repairId) return err('Which repair?');

    const outcome = String(body?.outcome || 'repaired');
    if (!OUTCOMES.includes(outcome)) {
      return err(`Outcome must be one of: ${OUTCOMES.join(', ')}`);
    }

    try {
      const out = await withTransaction(async (client) => {
        const r = await client.query(
          `SELECT * FROM public.asset_repairs WHERE id = $1 FOR UPDATE`, [repairId]);
        if (!r.rows.length) throw { status: 404, message: 'That repair record no longer exists.' };
        const repair = r.rows[0];
        if (repair.returned_at) throw { status: 409, message: 'That asset has already been received back.' };

        await client.query(
          `UPDATE public.asset_repairs
           SET returned_at = now(), work_done = $2, outcome = $3,
               cost_cents = $4, received_by = $5, updated_at = now()
           WHERE id = $1`,
          [repairId, body.work_done || null, outcome,
           Number.isFinite(body.cost_cents) ? body.cost_cents : null, user.sub]);

        // Beyond repair means it is not going back on the shelf. Retiring
        // it here rather than leaving it 'available' is the whole point of
        // asking for an outcome.
        const nextStatus = outcome === 'beyond_repair' ? 'retired' : 'available';
        await client.query(
          `UPDATE public.assets SET status = $2, updated_at = now() WHERE id = $1`,
          [repair.asset_id, nextStatus]);

        await core.writeEvent(client, {
          asset_id: repair.asset_id, event: 'returned_from_repair', actor: user,
          reason: body.work_done || null,
          payload: { outcome, to_status: nextStatus, cost_cents: body.cost_cents ?? null,
                     days_out: null },
        });
        await core.writeEvent(client, {
          asset_id: repair.asset_id, event: 'maintenance_end', actor: user,
          reason: body.work_done || null,
        });
        if (nextStatus === 'retired') {
          await core.writeEvent(client, {
            asset_id: repair.asset_id, event: 'retired', actor: user,
            reason: 'Beyond repair',
          });
        }

        return { repair_id: repairId, asset_id: repair.asset_id, status: nextStatus, outcome };
      });

      await logAudit(request, {
        profile_id: user.sub, email: user.email, full_name: user.name,
        action: 'asset_returned_from_repair', detail: `${out.asset_id} — ${outcome}`,
      });
      return json(out);
    } catch (e) {
      if (e && e.status) return err(e.message, e.status);
      throw e;
    }
  },
});

// ═══ SHOPS ═════════════════════════════════════════════════════════════
app.http('repairShopsList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'repair-shops',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'staff', 'admin', 'leader');
    if (error) return err(error, status);
    const includeInactive = qs(request).get('all') === '1';
    const r = await query(
      `SELECT id, name, contact, is_internal, active, notes
       FROM public.repair_shops
       WHERE ($1::bool IS TRUE OR active) ORDER BY is_internal DESC, name`, [includeInactive]);
    return json({ rows: r.rows });
  },
});

app.http('repairShopCreate', {
  methods: ['POST'], authLevel: 'anonymous', route: 'repair-shops',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const name = String(body?.name || '').trim();
    if (!name) return err('Give the shop a name');
    try {
      const r = await query(
        `INSERT INTO public.repair_shops (name, contact, is_internal, notes, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [name, body.contact || null, body.is_internal !== false, body.notes || null, user.sub]);
      return json({ shop: r.rows[0] }, 201);
    } catch (e) {
      if (e.code === '23505') return err(`There is already a shop called "${name}".`, 409);
      throw e;
    }
  },
});

app.http('repairShopUpdate', {
  methods: ['PATCH'], authLevel: 'anonymous', route: 'repair-shops/{id}',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const id = uuidOrNull(request.params.id);
    if (!id) return err('Which shop?');

    const sets = []; const vals = [id];
    for (const f of ['name', 'contact', 'notes']) {
      if (body[f] !== undefined) { vals.push(body[f] || null); sets.push(`${f} = $${vals.length}`); }
    }
    for (const f of ['is_internal', 'active']) {
      if (body[f] !== undefined) { vals.push(!!body[f]); sets.push(`${f} = $${vals.length}`); }
    }
    if (!sets.length) return err('Nothing to update');

    try {
      const r = await query(
        `UPDATE public.repair_shops SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
      if (!r.rows.length) return err('That shop no longer exists.', 404);
      return json({ shop: r.rows[0] });
    } catch (e) {
      if (e.code === '23505') return err('There is already a shop with that name.', 409);
      throw e;
    }
  },
});
