// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — categories and locations
// Two identical CRUD quartets over two lookup tables. GET is open to any
// signed-in role (every screen needs the labels); writes are admin.
//
//   GET/POST      /api/categories        /api/locations
//   PATCH/DELETE  /api/categories/{id}   /api/locations/{id}
// ─────────────────────────────────────────────────────────────
const { app } = require('@azure/functions');
const { query } = require('../db');
const { json, err, requireAuth, requireRole, logAudit, readJson, qs } = require('../middleware');

// table:      the lookup table
// fkColumn:   the assets column pointing at it (guards DELETE)
// extraCols:  columns beyond name/sort_order/active
const KINDS = {
  categories: { table: 'asset_categories', fk: 'category_id', extra: ['icon'],  label: 'Category' },
  locations:  { table: 'asset_locations',  fk: 'location_id', extra: ['notes'], label: 'Location' },
};

function register(kind) {
  const k = KINDS[kind];
  const cap = kind[0].toUpperCase() + kind.slice(1);

  app.http(`${kind}List`, {
    methods: ['GET'], authLevel: 'anonymous', route: kind,
    handler: async (request) => {
      const { error, status } = await requireAuth(request);
      if (error) return err(error, status);
      const includeInactive = qs(request).get('all') === '1';
      const r = await query(
        `SELECT t.*, (SELECT count(*) FROM public.assets a WHERE a.${k.fk} = t.id)::int AS asset_count
         FROM public.${k.table} t
         WHERE ($1::boolean OR t.active)
         ORDER BY t.sort_order, lower(t.name)`, [includeInactive]);
      return json(r.rows);
    },
  });

  app.http(`${kind}Create`, {
    methods: ['POST'], authLevel: 'anonymous', route: kind,
    handler: async (request) => {
      const { user, error, status } = await requireRole(request, 'admin');
      if (error) return err(error, status);
      const { body, bad } = await readJson(request); if (bad) return bad;
      if (!body?.name || !String(body.name).trim()) return err(`A ${k.label.toLowerCase()} name is required`);

      const cols = ['name', 'sort_order', ...k.extra];
      const vals = [String(body.name).trim(), body.sort_order ?? 100, ...k.extra.map(c => body[c] || null)];
      try {
        const r = await query(
          `INSERT INTO public.${k.table} (${cols.join(',')})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals);
        await logAudit(request, {
          profile_id: user.sub, email: user.email,
          action: `${kind}_created`, detail: r.rows[0].name });
        return json({ ...r.rows[0], asset_count: 0 }, 201);
      } catch (e) {
        if (e.code === '23505') return err(`That ${k.label.toLowerCase()} already exists`, 409);
        throw e;
      }
    },
  });

  app.http(`${kind}Update`, {
    methods: ['PATCH'], authLevel: 'anonymous', route: `${kind}/{id}`,
    handler: async (request) => {
      const { user, error, status } = await requireRole(request, 'admin');
      if (error) return err(error, status);
      const { body, bad } = await readJson(request); if (bad) return bad;
      const sets = []; const vals = []; let i = 1;
      for (const c of ['name', 'sort_order', 'active', ...k.extra]) {
        if (body[c] !== undefined) { sets.push(`${c} = $${i++}`); vals.push(c === 'name' ? String(body[c]).trim() : body[c]); }
      }
      if (!sets.length) return err('Nothing to update');
      vals.push(request.params.id);
      try {
        const r = await query(`UPDATE public.${k.table} SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
        if (!r.rows.length) return err(`${k.label} not found`, 404);
        await logAudit(request, {
          profile_id: user.sub, email: user.email,
          action: `${kind}_updated`, detail: r.rows[0].name });
        return json(r.rows[0]);
      } catch (e) {
        if (e.code === '23505') return err(`That ${k.label.toLowerCase()} already exists`, 409);
        throw e;
      }
    },
  });

  // Refused while any asset still points at it — deleting would silently
  // blank the category on real records. Deactivating hides it from the
  // pickers while keeping historical rows readable, which is what people
  // actually want when they say "get rid of this one".
  app.http(`${kind}Delete`, {
    methods: ['DELETE'], authLevel: 'anonymous', route: `${kind}/{id}`,
    handler: async (request) => {
      const { user, error, status } = await requireRole(request, 'admin');
      if (error) return err(error, status);
      const id = request.params.id;
      const used = await query(`SELECT count(*)::int AS n FROM public.assets WHERE ${k.fk} = $1`, [id]);
      if (used.rows[0].n > 0) {
        return err(
          `${used.rows[0].n} asset(s) still use this ${k.label.toLowerCase()}. Mark it inactive instead.`,
          409, { asset_count: used.rows[0].n, suggest: 'deactivate' });
      }
      const r = await query(`DELETE FROM public.${k.table} WHERE id = $1 RETURNING name`, [id]);
      if (!r.rows.length) return err(`${k.label} not found`, 404);
      await logAudit(request, {
        profile_id: user.sub, email: user.email,
        action: `${kind}_deleted`, detail: r.rows[0].name });
      return json({ ok: true });
    },
  });

  void cap;
}

register('categories');
register('locations');

module.exports = {};
