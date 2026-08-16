// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — the singleton settings row
//   GET   /api/settings   any signed-in role (the UI reads the default
//                         loan length and support contacts)
//   PATCH /api/settings   admin
// ─────────────────────────────────────────────────────────────
const { app } = require('@azure/functions');
const { query } = require('../db');
const { json, err, requireAuth, requireRole, logAudit, readJson } = require('../middleware');

const FIELDS = [
  'org_display_name', 'app_display_name', 'support_phone', 'support_email',
  'default_loan_hours', 'overdue_grace_hours', 'require_out_condition', 'pilot_mode',
];

app.http('settingsGet', {
  methods: ['GET'], authLevel: 'anonymous', route: 'settings',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    // The singleton row is seeded by the migration, but never assume it:
    // recreate it on read rather than handing the UI an empty object it
    // would then render as "no default loan length".
    await query(`INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    const r = await query(`SELECT ${FIELDS.join(', ')}, updated_at FROM public.app_settings WHERE id = 1`);
    return json(r.rows[0] || {});
  },
});

app.http('settingsUpdate', {
  methods: ['PATCH'], authLevel: 'anonymous', route: 'settings',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;

    if (body.default_loan_hours !== undefined && body.default_loan_hours !== null) {
      const h = Number(body.default_loan_hours);
      if (!Number.isInteger(h) || h < 0 || h > 8760) {
        return err('Default loan length must be a whole number of hours between 0 and 8760 (0 = indefinite)');
      }
    }
    if (body.overdue_grace_hours !== undefined) {
      const g = Number(body.overdue_grace_hours);
      if (!Number.isInteger(g) || g < 0 || g > 720) return err('Overdue grace must be 0–720 hours');
    }

    const sets = []; const vals = []; let i = 1;
    for (const f of FIELDS) if (body[f] !== undefined) { sets.push(`${f} = $${i++}`); vals.push(body[f]); }
    if (!sets.length) return err('Nothing to update');
    sets.push(`updated_by = $${i++}`); vals.push(user.sub);
    sets.push(`updated_at = now()`);

    await query(`INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    const r = await query(
      `UPDATE public.app_settings SET ${sets.join(', ')} WHERE id = 1
       RETURNING ${FIELDS.join(', ')}, updated_at`, vals);
    if (!r.rows.length) return err('Settings row is missing — re-run 001_schema.sql', 500);
    await logAudit(request, {
      profile_id: user.sub, email: user.email,
      action: 'settings_updated', detail: JSON.stringify(body).slice(0, 500) });
    return json(r.rows[0]);
  },
});

module.exports = {};
