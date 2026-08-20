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
  'default_loan_hours', 'overdue_grace_hours', 'require_out_condition',
  // How much one ordinary member may hold at once (migration 009). Every
  // part of the rule is a setting because it is an operational judgement
  // that differs between a build week and show week.
  'member_limit_enabled', 'member_title', 'member_item_limit', 'member_limit_per_category',
];

// Which of those columns the database ACTUALLY has right now.
//
// The app deploys the moment a commit lands; migrations are run by hand
// afterwards. So there is always a window where the code knows about a
// column the database has not grown yet — and naming it in a SELECT makes
// that window a 500 on /api/settings, which every page reads at boot.
// This has held up two previous changes, with the code sitting unpushed
// waiting for a migration.
//
// So: intersect with information_schema once per cold start. Columns that
// do not exist yet are simply absent from the payload, the UI renders its
// own defaults, and the deploy order stops mattering. Never SELECT * here
// — roster_clear_pin_hash lives in this table.
let _cols = null;
async function liveFields() {
  if (_cols) return _cols;
  const r = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'app_settings'`);
  const have = new Set(r.rows.map(x => x.column_name));
  _cols = FIELDS.filter(f => have.has(f));
  // A table with none of them is a database that has not been migrated at
  // all; fall back to the full list so the error names the real problem
  // rather than returning a cheerfully empty object.
  if (!_cols.length) _cols = FIELDS.slice();
  return _cols;
}

app.http('settingsGet', {
  methods: ['GET'], authLevel: 'anonymous', route: 'settings',
  handler: async (request) => {
    const { error, status } = await requireAuth(request);
    if (error) return err(error, status);
    // The singleton row is seeded by the migration, but never assume it:
    // recreate it on read rather than handing the UI an empty object it
    // would then render as "no default loan length".
    await query(`INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    const cols = await liveFields();
    const r = await query(`SELECT ${cols.join(', ')}, updated_at FROM public.app_settings WHERE id = 1`);
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
    if (body.member_item_limit !== undefined) {
      const n = Number(body.member_item_limit);
      // Zero would mean "nobody may borrow anything", which is never what
      // anyone means and reads exactly like a mis-typed form. The off
      // switch is the toggle, not the number.
      if (!Number.isInteger(n) || n < 1 || n > 99) {
        return err('The item limit must be a whole number between 1 and 99 — use the toggle to turn the rule off');
      }
    }
    if (body.member_title !== undefined && !String(body.member_title || '').trim()) {
      return err('The member title cannot be blank — it is what decides who the limit applies to');
    }

    const cols = await liveFields();
    const sets = []; const vals = []; let i = 1;
    for (const f of cols) if (body[f] !== undefined) { sets.push(`${f} = $${i++}`); vals.push(body[f]); }
    if (!sets.length) return err('Nothing to update');
    sets.push(`updated_by = $${i++}`); vals.push(user.sub);
    sets.push(`updated_at = now()`);

    await query(`INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    const r = await query(
      `UPDATE public.app_settings SET ${sets.join(', ')} WHERE id = 1
       RETURNING ${cols.join(', ')}, updated_at`, vals);
    if (!r.rows.length) return err('Settings row is missing — re-run 001_schema.sql', 500);
    await logAudit(request, {
      profile_id: user.sub, email: user.email,
      action: 'settings_updated', detail: JSON.stringify(body).slice(0, 500) });
    return json(r.rows[0]);
  },
});

module.exports = {};
