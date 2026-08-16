// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — authentication
//   POST /api/auth/login            email + password  (public)
//   POST /api/auth/change-password  self-service      (any signed-in role)
//   POST /api/auth/bootstrap        first admin       (BOOTSTRAP_SECRET)
//
// Password only. No OTP, no PIN, no MFA, no SMS — every account is
// created by an admin (see profiles.js), there is no self-service signup.
// ─────────────────────────────────────────────────────────────
const { app } = require('@azure/functions');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const {
  json, err, requireAuth, signSession, safeProfile, logAudit, readJson, PORTAL,
} = require('../middleware');

const MIN_PASSWORD = 10;

app.http('authLogin', {
  methods: ['POST'], authLevel: 'anonymous', route: 'auth/login',
  handler: async (request) => {
    const { body, bad } = await readJson(request); if (bad) return bad;
    const { email, password } = body || {};
    if (!email || !password) return err('Email and password are required');
    const cleanEmail = String(email).toLowerCase().trim();

    const r = await query(`SELECT * FROM public.profiles WHERE email = $1`, [cleanEmail]);
    const p = r.rows[0];

    // Deliberate non-enumeration: unknown account, inactive account and
    // wrong password all return the identical message and status, so the
    // login form can't be used to discover who has an account.
    if (!p || p.status !== 'active' || !p.password_hash) {
      await logAudit(request, { email: cleanEmail, action: 'login_failed', detail: 'unknown or inactive account' });
      return err('Incorrect email or password', 401);
    }
    const ok = await bcrypt.compare(password, p.password_hash);
    if (!ok) {
      await logAudit(request, {
        profile_id: p.id, email: p.email, full_name: p.full_name,
        action: 'login_failed', detail: 'bad password',
      });
      return err('Incorrect email or password', 401);
    }

    await query(`UPDATE public.profiles SET last_login_at = now() WHERE id = $1`, [p.id]);
    await logAudit(request, {
      profile_id: p.id, email: p.email, full_name: p.full_name,
      action: 'login', detail: `role=${p.role}`,
    });

    return json({ token: signSession(p), profile: safeProfile(p), portal: PORTAL[p.role] });
  },
});

app.http('authChangePassword', {
  methods: ['POST'], authLevel: 'anonymous', route: 'auth/change-password',
  handler: async (request) => {
    const { user, error, status } = await requireAuth(request);
    if (error) return err(error, status);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const { current_password, new_password } = body || {};
    if (!current_password || !new_password) return err('Both the current and new password are required');
    if (String(new_password).length < MIN_PASSWORD) {
      return err(`Choose a password of at least ${MIN_PASSWORD} characters`);
    }

    const r = await query(`SELECT * FROM public.profiles WHERE id = $1`, [user.sub]);
    const p = r.rows[0];
    if (!p || !p.password_hash) return err('Account not found', 404);
    if (!(await bcrypt.compare(current_password, p.password_hash))) {
      await logAudit(request, {
        profile_id: p.id, email: p.email, full_name: p.full_name,
        action: 'password_change_failed', detail: 'bad current password',
      });
      return err('Your current password is not correct', 403);
    }

    // Bumping token_version invalidates every existing session for this
    // user, including any other device they left signed in — which is the
    // main reason someone changes a password in the first place.
    const hash = bcrypt.hashSync(new_password, 10);
    await query(
      `UPDATE public.profiles SET password_hash = $2, token_version = token_version + 1, updated_at = now()
       WHERE id = $1`, [p.id, hash]
    );
    await logAudit(request, {
      profile_id: p.id, email: p.email, full_name: p.full_name, action: 'password_changed',
    });
    return json({ ok: true, must_sign_in_again: true });
  },
});

// One-shot first-admin creation. Gated on the BOOTSTRAP_SECRET app
// setting; deleting that setting in the Azure portal permanently
// disables this endpoint with no code change. It also refuses to run
// once any admin exists, so it can't be used to add a second back door.
app.http('authBootstrap', {
  methods: ['POST'], authLevel: 'anonymous', route: 'auth/bootstrap',
  handler: async (request) => {
    const secret = process.env.BOOTSTRAP_SECRET;
    if (!secret) return err('Bootstrap is disabled', 403);
    const { body, bad } = await readJson(request); if (bad) return bad;
    const { bootstrap_secret, email, password, first_name, last_name } = body || {};
    if (bootstrap_secret !== secret) {
      await logAudit(request, { email: email || null, action: 'bootstrap_failed', detail: 'bad secret' });
      return err('Forbidden', 403);
    }
    if (!email || !password) return err('email and password are required');
    if (String(password).length < MIN_PASSWORD) {
      return err(`Choose a password of at least ${MIN_PASSWORD} characters`);
    }

    const existing = await query(`SELECT count(*)::int AS n FROM public.profiles WHERE role = 'admin'`);
    if (existing.rows[0].n > 0) {
      return err('An admin already exists — remove the BOOTSTRAP_SECRET app setting', 409);
    }

    const fn = (first_name || '').trim();
    const ln = (last_name || '').trim();
    const full = [fn, ln].filter(Boolean).join(' ') || email;
    const hash = bcrypt.hashSync(password, 10);
    const r = await query(
      `INSERT INTO public.profiles (email, first_name, last_name, full_name, role, password_hash)
       VALUES ($1,$2,$3,$4,'admin',$5) RETURNING *`,
      [String(email).toLowerCase().trim(), fn, ln, full, hash]
    );
    await logAudit(request, {
      profile_id: r.rows[0].id, email: r.rows[0].email, full_name: full,
      action: 'bootstrap_admin_created',
    });
    return json({ ok: true, profile: safeProfile(r.rows[0]) }, 201);
  },
});

module.exports = {};
