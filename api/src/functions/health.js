// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — GET /api/health
// Unauthenticated on purpose (it's what you curl after a deploy and
// what an uptime check hits) and therefore returns NO secrets and no
// data — only whether the moving parts are wired up.
// ─────────────────────────────────────────────────────────────
const { app } = require('@azure/functions');
const { query } = require('../db');
const { json } = require('../middleware');
const blob = require('../blob');

app.http('health', {
  methods: ['GET'], authLevel: 'anonymous', route: 'health',
  handler: async () => {
    let db = 'down';
    let counts = null;
    try {
      // Categories and locations are counted BOTH ways on purpose. An empty
      // Category dropdown on the asset form has exactly two causes — no rows
      // at all, or rows that are all inactive — and the pickers only ever
      // request the active ones, so a single total cannot tell them apart.
      // Two numbers here answer it from outside the app, with no login.
      const r = await query(`
        SELECT (SELECT count(*) FROM public.profiles WHERE status='active')  AS users,
               (SELECT count(*) FROM public.loanees  WHERE status='active')  AS loanees,
               (SELECT count(*) FROM public.assets)                          AS assets,
               (SELECT count(*) FROM public.loan_items
                 WHERE checked_in_at IS NULL)                                AS items_out,
               (SELECT count(*) FROM public.asset_categories WHERE active)   AS categories_active,
               (SELECT count(*) FROM public.asset_categories)                AS categories_total,
               (SELECT count(*) FROM public.asset_locations  WHERE active)   AS locations_active,
               (SELECT count(*) FROM public.asset_locations)                 AS locations_total,
               (SELECT count(*) FROM public.groups)                          AS groups_total`);
      db = 'up';
      counts = r.rows[0];
    } catch (e) {
      return json({ ok: false, db, error: e.message }, 503);
    }
    return json({
      ok: true,
      db,
      counts,
      jwt_configured: !!process.env.JWT_SECRET,
      blob_configured: blob.configured(),
      bootstrap_open: !!process.env.BOOTSTRAP_SECRET,
    });
  },
});

module.exports = {};
