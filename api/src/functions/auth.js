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

// Committee members sign in with their NAME, not an email address. Most of
// the roster has an email on file that they have never typed and would not
// recognise, and the counter is a shared tablet where "which of my
// addresses did they load?" is a real delay. Their password is their zip
// code, which is what the roster import already set — so this changes what
// you type in the top box and nothing else.
//
// Admins keep email + password. An address is unique and an admin knows
// theirs; a name is neither.
//
// Whether a name reaches a login at all is decided by group membership
// (migration 010) so Kyle can change it from the Groups screen later
// without a deploy. See mayLogIn below.
async function findByName(name) {
  // Names are matched loosely on purpose: the roster is typed by hand and
  // "  bob  smith " should reach Bob Smith. It is not a secret — the gate
  // is the password and the group, not the difficulty of guessing a name.
  const norm = String(name).trim().replace(/\s+/g, ' ');
  const r = await query(
    `SELECT * FROM public.profiles
      WHERE lower(btrim(regexp_replace(full_name, '\\s+', ' ', 'g'))) = lower($1)
        AND status = 'active'`, [norm]);
  return r.rows;
}

// A Base or Leadership account may sign in only if that person's roster
// record is in at least one ACTIVE group with can_login = TRUE.
//
// Admins are deliberately exempt. A checkbox that can lock you out of the
// console containing the checkbox is a trap; there would be no way back in
// except psql.
//
// Fails OPEN if the column does not exist yet — the app deploys the moment
// a commit lands and migration 010 is run by hand afterwards, so there is
// a window where this code is live against a database without can_login.
// During that window everyone signs in exactly as they did before, which
// is the only acceptable behaviour for a login path.
async function mayLogIn(profile) {
  if (profile.role === 'admin') return true;

  // The gate is about ROSTER-provisioned accounts. The roster import puts
  // every member into a group named after their sub-committee, so ticking
  // "may sign in" on one committee is exactly the control Kyle asked for.
  //
  // An account made by hand in Admin → Users has no member_number and
  // therefore no committee. Those are not oversights to be caught — an
  // admin sat down and created that person on purpose, which is a stronger
  // statement of intent than any checkbox. Gating them would mean every
  // hand-made staff account silently failed to sign in the day this
  // shipped, and the admin who made it would have no idea why.
  if (!profile.member_number) return true;

  let has;
  try {
    has = await query(
      `SELECT EXISTS (
         SELECT 1 FROM public.group_members gm
           JOIN public.groups  g  ON g.id = gm.group_id
           JOIN public.loanees ln ON ln.id = gm.loanee_id
          WHERE g.can_login AND g.active
            AND ln.member_number IS NOT NULL
            AND ln.member_number = $1
       ) AS ok`, [profile.member_number]);
  } catch (e) {
    if (e && e.code === '42703') return true;   // 010 not run yet
    throw e;
  }
  return has.rows[0].ok;
}

app.http('authLogin', {
  methods: ['POST'], authLevel: 'anonymous', route: 'auth/login',
  handler: async (request) => {
    const { body, bad } = await readJson(request); if (bad) return bad;
    const { email, name, password } = body || {};
    const typed = String(email || name || '').trim();
    if (!typed || !password) return err('Enter your name (or email) and your password');

    // One box on the form. Anything with an @ is an email address; anything
    // else is a name. Nobody has to know which kind of account they have.
    const byEmail = typed.includes('@');
    const cleanEmail = typed.toLowerCase();

    let candidates;
    if (byEmail) {
      const r = await query(`SELECT * FROM public.profiles WHERE email = $1`, [cleanEmail]);
      candidates = r.rows;
    } else {
      candidates = await findByName(typed);
    }

    // Deliberate non-enumeration: unknown account, inactive account and
    // wrong password all return the identical message and status, so the
    // login form can't be used to discover who has an account.
    const GENERIC = byEmail ? 'Incorrect email or password' : 'Incorrect name or password';

    const usable = candidates.filter(p => p.status === 'active' && p.password_hash);
    if (!usable.length) {
      await logAudit(request, {
        email: byEmail ? cleanEmail : null, full_name: byEmail ? null : typed,
        action: 'login_failed', detail: 'unknown or inactive account' });
      return err(GENERIC, 401);
    }

    // Two people really can share a name AND a zip code — a father and son
    // at one address is the obvious case, and this roster is families. So
    // every match is checked, and if more than one accepts the password we
    // refuse rather than signing in as whichever row Postgres returned
    // first. Silently picking one would put the wrong name on a checkout.
    const matched = [];
    for (const p of usable) {
      if (await bcrypt.compare(password, p.password_hash)) matched.push(p);
    }

    if (!matched.length) {
      const first = usable[0];
      await logAudit(request, {
        profile_id: first.id, email: first.email, full_name: first.full_name,
        action: 'login_failed', detail: 'bad password',
      });
      return err(GENERIC, 401);
    }

    if (matched.length > 1) {
      await logAudit(request, {
        full_name: typed, action: 'login_ambiguous',
        detail: `${matched.length} accounts share that name and password`,
      });
      return err(
        'More than one person on the roster has that name. Sign in with your email address instead, '
        + 'or ask an admin to tell you which one is yours.', 409);
    }

    const p = matched[0];

    // The group gate runs AFTER the password, so a wrong password never
    // reveals whether the account exists or which committee it is in. By
    // this point they have proved who they are, and being told plainly that
    // their committee has no app access beats a generic failure they would
    // otherwise report as "the app is broken".
    if (!(await mayLogIn(p))) {
      await logAudit(request, {
        profile_id: p.id, email: p.email, full_name: p.full_name,
        action: 'login_denied', detail: `role=${p.role}; no group with app access`,
      });
      return err(
        'Your committee does not have access to this app. An admin can turn it on '
        + 'under Admin → Groups.', 403);
    }

    await query(`UPDATE public.profiles SET last_login_at = now() WHERE id = $1`, [p.id]);
    await logAudit(request, {
      profile_id: p.id, email: p.email, full_name: p.full_name,
      action: 'login', detail: `role=${p.role}; by ${byEmail ? 'email' : 'name'}`,
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
