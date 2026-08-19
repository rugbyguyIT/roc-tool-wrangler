// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — app users (the people who log in)
//   GET   /api/me                  any signed-in role
//   GET   /api/users               admin
//   POST  /api/users               admin
//   PATCH /api/users/{id}          admin
//   POST  /api/users/{id}/photo    admin
// ─────────────────────────────────────────────────────────────
const { app } = require('@azure/functions');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const {
  json, err, requireAuth, requireRole, safeProfile, logAudit, readJson, qs, ROLES,
} = require('../middleware');
const blob = require('../blob');

const MIN_PASSWORD = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

app.http('me', {
  methods: ['GET'], authLevel: 'anonymous', route: 'me',
  handler: async (request) => {
    const { user, error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const r = await query(`SELECT * FROM public.profiles WHERE id = $1`, [user.sub]);
    if (!r.rows.length) return err('Not found', 404);
    return json(safeProfile(r.rows[0]));
  },
});

app.http('usersList', {
  methods: ['GET'], authLevel: 'anonymous', route: 'users',
  handler: async (request) => {
    const { error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const p = qs(request);
    const role = p.get('role');
    const st = p.get('status');
    const q = (p.get('q') || '').trim();

    // Digits are passed separately so a purely alphabetic search never
    // reaches the phone clause. Deriving them inside SQL would turn a
    // search for "kyle" into LIKE '%%', which matches every row.
    const digits = q.replace(/\D/g, '');

    const limit = Math.min(parseInt(p.get('limit') || '25', 10) || 25, 500);
    const offset = Math.max(parseInt(p.get('offset') || '0', 10) || 0, 0);

    const params = [
      ROLES.includes(role) ? role : null,
      ['active', 'inactive'].includes(st) ? st : null,
      q || null,
      digits,
    ];
    const WHERE_USERS = `
       WHERE ($1::text IS NULL OR role = $1)
         AND ($2::text IS NULL OR status = $2)
         AND ($3::text IS NULL OR (
                  full_name     ILIKE '%'||$3||'%'
               OR email         ILIKE '%'||$3||'%'
               OR last_name     ILIKE $3||'%'
               OR coalesce(member_number,'') ILIKE $3||'%'
               OR ($4::text <> '' AND regexp_replace(coalesce(phone_mobile,''), '\\D', '', 'g')
                                      LIKE '%'||$4||'%')
             ))`;

    const r = await query(
      `SELECT id, email, first_name, last_name, full_name, phone_mobile, role, photo_url,
              status, member_number, last_login_at, created_at
       FROM public.profiles
       ${WHERE_USERS}
       ORDER BY CASE role WHEN 'admin' THEN 1 WHEN 'staff' THEN 2 ELSE 3 END, last_name, first_name
       LIMIT $5 OFFSET $6`,
      [...params, limit, offset]
    );
    const total = await query(
      `SELECT count(*)::int AS n FROM public.profiles ${WHERE_USERS}`, params);
    // { rows, total } rather than a bare array — the list is paged now, so
    // the client needs to know how many there are beyond this page.
    return json({ rows: r.rows, total: total.rows[0].n });
  },
});

app.http('usersCreate', {
  methods: ['POST'], authLevel: 'anonymous', route: 'users',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const { email, first_name, last_name, role, phone_mobile, password, member_number } = body || {};

    if (!email || !EMAIL_RE.test(String(email))) return err('A valid email address is required');
    if (!first_name || !last_name) return err('First and last name are required');
    if (!ROLES.includes(role)) return err(`Role must be one of: ${ROLES.join(', ')}`);
    if (!password || String(password).length < MIN_PASSWORD) {
      return err(`Set a password of at least ${MIN_PASSWORD} characters`);
    }

    const full = `${String(first_name).trim()} ${String(last_name).trim()}`;
    try {
      const r = await query(
        `INSERT INTO public.profiles
           (email, first_name, last_name, full_name, phone_mobile, role, password_hash,
            member_number, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [String(email).toLowerCase().trim(), String(first_name).trim(), String(last_name).trim(),
         full, phone_mobile || null, role, bcrypt.hashSync(password, 10),
         // Carries the roster key across when the account was created from a
         // loanee, so the next roster sync updates this person rather than
         // creating a second account beside them.
         (member_number == null || member_number === '') ? null : String(member_number).trim(),
         user.sub]
      );
      await logAudit(request, {
        profile_id: user.sub, email: user.email,
        action: 'user_created', detail: `${full} <${email}> as ${role}`,
      });
      return json(safeProfile(r.rows[0]), 201);
    } catch (e) {
      // Two different unique indexes can raise this, and "that email is
      // taken" is actively misleading when it was the member number.
      if (e.code === '23505') {
        return err(e.constraint === 'profiles_member_number_uniq'
          ? 'That member number already has an account. Search the user list for it instead.'
          : 'Someone already has an account with that email address', 409);
      }
      throw e;
    }
  },
});

app.http('usersUpdate', {
  methods: ['PATCH'], authLevel: 'anonymous', route: 'users/{id}',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const id = request.params.id;
    const { body, bad } = await readJson(request); if (bad) return bad;

    const cur = await query(`SELECT * FROM public.profiles WHERE id = $1`, [id]);
    if (!cur.rows.length) return err('User not found', 404);
    const before = cur.rows[0];

    const sets = []; const vals = []; let i = 1;
    const push = (col, val) => { sets.push(`${col} = $${i++}`); vals.push(val); };

    if (body.email !== undefined) {
      if (!EMAIL_RE.test(String(body.email))) return err('That email address does not look right');
      push('email', String(body.email).toLowerCase().trim());
    }
    if (body.first_name !== undefined) push('first_name', String(body.first_name).trim());
    if (body.last_name !== undefined) push('last_name', String(body.last_name).trim());
    if (body.first_name !== undefined || body.last_name !== undefined) {
      const fn = body.first_name !== undefined ? String(body.first_name).trim() : before.first_name;
      const ln = body.last_name !== undefined ? String(body.last_name).trim() : before.last_name;
      push('full_name', `${fn} ${ln}`.trim());
    }
    if (body.phone_mobile !== undefined) push('phone_mobile', body.phone_mobile || null);
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) return err(`Role must be one of: ${ROLES.join(', ')}`);
      push('role', body.role);
    }
    if (body.status !== undefined) {
      if (!['active', 'inactive'].includes(body.status)) return err('Status must be active or inactive');
      push('status', body.status);
    }
    if (body.password !== undefined) {
      if (String(body.password).length < MIN_PASSWORD) {
        return err(`Set a password of at least ${MIN_PASSWORD} characters`);
      }
      push('password_hash', bcrypt.hashSync(body.password, 10));
    }

    // The role is baked into the JWT at sign time, so a role change that
    // did NOT bump token_version would leave the user carrying their old
    // permissions until the token expired — confusing 403s for hours.
    // Same for deactivation and password resets: all of them must take
    // effect on the user's very next request.
    const mustLogout = body.force_logout === true
      || (body.role !== undefined && body.role !== before.role)
      || (body.status !== undefined && body.status !== before.status)
      || body.password !== undefined;
    if (mustLogout) sets.push(`token_version = token_version + 1`);

    if (!sets.length) return err('Nothing to update');
    sets.push(`updated_at = now()`);
    vals.push(id);

    try {
      const r = await query(
        `UPDATE public.profiles SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
      );
      const changed = Object.keys(body).filter(k => k !== 'password').join(', ');
      await logAudit(request, {
        profile_id: user.sub, email: user.email,
        action: body.force_logout ? 'user_force_logout' : 'user_updated',
        detail: `${before.full_name}: ${changed || 'password reset'}${mustLogout ? ' (sessions revoked)' : ''}`,
      });
      return json({ ...safeProfile(r.rows[0]), sessions_revoked: mustLogout });
    } catch (e) {
      if (e.code === '23505') return err('Someone already has an account with that email address', 409);
      throw e;
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════
// Delete an account.
//
// Same rule as loanees, for the same reason: an account that has ever
// worked the counter is NEVER hard-deleted. loans.checked_out_by is NOT
// NULL with no ON DELETE clause, so removing that row would either fail
// outright or take custody history with it — and "who handed out the
// forklift in 2025" has to stay answerable. Those accounts are
// deactivated instead, and the response says which happened, so "delete"
// never quietly means something else.
//
// The typed confirmation is verified HERE, not only in the browser. A
// confirmation that exists only in the UI is not a safeguard against
// anything except a misclick.
// ═══════════════════════════════════════════════════════════════════════
app.http('usersDelete', {
  methods: ['DELETE'], authLevel: 'anonymous', route: 'users/{id}',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    const id = request.params.id;

    if (qs(request).get('confirm') !== 'DELETE') {
      return err('Type DELETE exactly to confirm.');
    }
    // Deleting the account you are signed in as would revoke your own
    // session mid-request and leave the console in a state nobody can
    // explain. It is also almost never what was meant.
    if (id === user.sub) return err('You cannot delete the account you are signed in as.', 409);

    const cur = await query(`SELECT full_name, email, role FROM public.profiles WHERE id = $1`, [id]);
    if (!cur.rows.length) return err('User not found', 404);
    const who = cur.rows[0];

    // Last admin standing: removing them locks everyone out of settings,
    // users and lookups permanently, with no way back in through the UI.
    if (who.role === 'admin') {
      const admins = await query(
        `SELECT count(*)::int AS n FROM public.profiles WHERE role = 'admin' AND status = 'active'`);
      if (admins.rows[0].n <= 1) return err('That is the only active administrator — promote someone else first.', 409);
    }

    const history = await query(
      `SELECT (EXISTS (SELECT 1 FROM public.loans      WHERE checked_out_by = $1)
            OR EXISTS (SELECT 1 FROM public.loan_items WHERE checked_in_by  = $1)) AS has_history`, [id]);

    if (history.rows[0].has_history) {
      await query(
        `UPDATE public.profiles
            SET status = 'inactive', token_version = token_version + 1, updated_at = now()
          WHERE id = $1`, [id]);
      await logAudit(request, {
        profile_id: user.sub, email: user.email, action: 'user_deactivated_not_deleted',
        detail: `${who.full_name} <${who.email}> has counter history, so the account was disabled instead`,
      });
      return json({
        deleted: false, deactivated: true,
        message: `${who.full_name} has checked equipment in or out, so the account was disabled rather than deleted — that history stays attached to their name.`,
      });
    }

    await query(`DELETE FROM public.profiles WHERE id = $1`, [id]);
    await logAudit(request, {
      profile_id: user.sub, email: user.email, action: 'user_deleted',
      detail: `${who.full_name} <${who.email}> (${who.role})`,
    });
    return json({ deleted: true, deactivated: false, message: `${who.full_name} was deleted.` });
  },
});

app.http('usersPhoto', {
  methods: ['POST'], authLevel: 'anonymous', route: 'users/{id}/photo',
  handler: async (request) => {
    const { user, error, status } = await requireRole(request, 'admin');
    if (error) return err(error, status);
    if (!blob.configured()) return err('Photo storage is not configured yet', 503);
    const id = request.params.id;
    const { body, bad } = await readJson(request); if (bad) return bad;
    if (!body || !body.data_url) return err('data_url is required');

    let url;
    try { url = await blob.uploadDataUrl('user', id, body.data_url); }
    catch (e) { return err(e.message, 400); }

    const r = await query(
      `UPDATE public.profiles SET photo_url = $2, updated_at = now() WHERE id = $1 RETURNING *`, [id, url]
    );
    if (!r.rows.length) return err('User not found', 404);
    await logAudit(request, { profile_id: user.sub, email: user.email, action: 'user_photo_set', detail: id });
    return json(safeProfile(r.rows[0]));
  },
});

module.exports = {};
