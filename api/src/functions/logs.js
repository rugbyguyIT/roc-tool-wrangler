// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — logging endpoints
//   POST /api/app-logs            client fire-and-forget log   (any signed-in role)
//   GET  /api/app-logs?level=     application/error log viewer (admin)
//   GET  /api/audit-logs          security/login audit log     (admin)
// ─────────────────────────────────────────────────────────────
const { app } = require('@azure/functions');
const { query } = require('../db');
const { json, err, requireAuth, requireRole, logApp, readJson, qs } = require('../middleware');

app.http('appLogsCreate', {
  methods: ['POST'], authLevel: 'anonymous', route: 'app-logs',
  handler: async (request) => {
    const { user, error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const { level, event, detail, page_url } = body || {};
    if (!event) return err('event is required');
    const lvl = ['info', 'warn', 'error'].includes(level) ? level : 'info';
    await logApp(lvl, event, detail, { profile_id: user.sub, email: user.email, page_url });
    return json({ ok: true }, 201);
  },
});

app.http('appLogsList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'app-logs',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const p = qs(request);
    const level = p.get('level');
    const limit = Math.min(parseInt(p.get('limit') || '200', 10) || 200, 500);
    const r = level && ['info', 'warn', 'error'].includes(level)
      ? await query(
          `SELECT l.id, l.level, l.event, l.detail, l.email, l.page_url, l.created_at, p.full_name
           FROM public.app_logs l LEFT JOIN public.profiles p ON p.id = l.profile_id
           WHERE l.level = $1 ORDER BY l.created_at DESC LIMIT $2`, [level, limit])
      : await query(
          `SELECT l.id, l.level, l.event, l.detail, l.email, l.page_url, l.created_at, p.full_name
           FROM public.app_logs l LEFT JOIN public.profiles p ON p.id = l.profile_id
           ORDER BY l.created_at DESC LIMIT $1`, [limit]);
    return json(r.rows);
  },
});

app.http('auditLogsList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'audit-logs',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const limit = Math.min(parseInt(qs(request).get('limit') || '200', 10) || 200, 500);
    const r = await query(
      `SELECT id, profile_id, email, full_name, action, detail, ip_address, user_agent, created_at
       FROM public.audit_logs ORDER BY created_at DESC LIMIT $1`, [limit]);
    return json(r.rows);
  },
});

module.exports = {};
