// ───────────────────────────────────────────────────────
// HLSR Asset Tracker — auth middleware
//
// NOTE: Azure Static Web Apps STRIPS the Authorization header before
// requests reach managed API functions (the same quirk 8 Seconds and
// 8 Second Rides both hit). We therefore carry the JWT in a custom
// header: x-assets-token. If you ever see a blanket 401 on every call,
// check that first.
// ───────────────────────────────────────────────────────
const jwt = require('jsonwebtoken');
const { query } = require('./db');

const ROLES = ['admin', 'staff', 'leader'];

// Per-role JWT lifetime.
//   admin  — 12h. Held in sessionStorage client-side, so it also dies
//            with the tab. Admin can do destructive things; short leash.
//   staff  — 12h. localStorage client-side: long enough to cover a full
//            shift on a shared shed tablet, dead by the next morning so
//            the next person can't inherit someone else's session.
//   leader — 30d. localStorage. It's a read-only phone PWA; making
//            leadership re-authenticate weekly guarantees they stop using it.
const SESSION_TTL = {
  admin:  '12h',
  staff:  '12h',
  leader: '30d',
};

// Where each role lands after signing in.
const PORTAL = {
  admin:  '/pages/admin.html',
  staff:  '/pages/staff.html',
  leader: '/pages/board.html',
};

function getSecret() {
  return process.env.JWT_SECRET || 'hlsr-assets-dev-secret-change-in-production';
}

function verifyToken(request) {
  const token = request.headers.get('x-assets-token') || '';
  if (!token) return null;
  try { return jwt.verify(token, getSecret()); } catch { return null; }
}

// Verifies the JWT AND re-checks token_version + status against the
// database, so bumping profiles.token_version force-logs-out that user
// everywhere on their very next request.
//
// DELIBERATE TRADEOFF (inherited from 8 Second Rides, kept on purpose):
// if the DB lookup itself throws we FAIL OPEN and accept the token. A
// Postgres blip should not lock every staff member out of the check-out
// counter mid-shift. The cost is that during a database outage,
// force-logout and account deactivation are temporarily unenforceable
// while already-issued JWTs still validate. Given the roles here
// (nobody outside HLSR has an account) that is the right side to err on,
// but it is a choice, not an accident.
async function verifyTokenFull(request) {
  const user = verifyToken(request);
  if (!user) return null;
  try {
    const res = await query(`SELECT token_version, status FROM public.profiles WHERE id = $1`, [user.sub]);
    const row = res.rows[0];
    if (!row || row.status !== 'active') return null;
    if ((row.token_version ?? 1) !== (user.tv ?? 1)) return null;
  } catch {
    // fail open — see the note above
  }
  return user;
}

async function requireAuth(request) {
  const user = await verifyTokenFull(request);
  if (!user) return { error: 'Unauthorized', status: 401 };
  return { user };
}

// requireRole(request, 'admin')            → admin only
// requireRole(request, 'staff', 'admin')   → either
//
// This is the REAL security boundary. requireLogin() in js/api.js is
// only UX — it stops someone landing on a page that will not work for
// them. Every mutating route must call this.
async function requireRole(request, ...roles) {
  const { user, error, status } = await requireAuth(request);
  if (error) return { error, status };
  if (!roles.includes(user.role)) return { error: 'Forbidden', status: 403 };
  return { user };
}

function signSession(profile) {
  return jwt.sign(
    { sub: profile.id, email: profile.email, role: profile.role, tv: profile.token_version ?? 1 },
    getSecret(),
    { expiresIn: SESSION_TTL[profile.role] || '12h' }
  );
}

// The columns it is safe to hand back to a browser. Never spread a raw
// profiles row into a response — password_hash lives on it.
function safeProfile(p) {
  if (!p) return null;
  return {
    id: p.id, email: p.email,
    first_name: p.first_name, last_name: p.last_name, full_name: p.full_name,
    phone_mobile: p.phone_mobile, role: p.role, photo_url: p.photo_url,
    status: p.status, last_login_at: p.last_login_at, created_at: p.created_at,
  };
}

function json(body, status = 200) {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function err(message, status = 400, extra) {
  return json({ error: message, ...(extra || {}) }, status);
}

// Thrown objects of the shape { status, message, ... } (used throughout
// assets-core.js) become clean HTTP responses instead of 500s.
function errFromThrow(e) {
  if (e && e.status && e.message) {
    const { status, message, ...rest } = e;
    return err(message, status, rest);
  }
  throw e; // a real bug — let hooks.js log it as an unhandled exception
}

// ── Request helpers ─────────────────────────────────────────
// Azure SWA forwards the caller's real IP in x-forwarded-for.
function getIp(request) {
  const fwd = request.headers.get('x-forwarded-for') || '';
  return fwd.split(',')[0].trim() || null;
}
function getUA(request) {
  return request.headers.get('user-agent') || null;
}
async function readJson(request) {
  try { return { body: await request.json() }; }
  catch { return { bad: err('Invalid JSON') }; }
}
function qs(request) {
  return new URL(request.url).searchParams;
}
function uuidOrNull(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || '') ? v : null;
}

// ── Security + application logging ─────────────────────────────
// Security/audit trail: logins (success AND failure), password changes,
// force-logout, user/asset/loanee mutations, settings changes, imports.
// Never throws — a logging failure must never break the request it logs.
async function logAudit(request, { profile_id = null, email = null, full_name = null, action, detail = null }) {
  try {
    const ip = getIp(request);
    await query(
      `INSERT INTO public.audit_logs (profile_id, email, full_name, action, detail, ip, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7)`,
      [profile_id, email, full_name, action, detail, ip, getUA(request)]
    );
  } catch (e) { console.error('[audit] failed to write:', e.message); }
}

// Application/error log — surfaced in Admin → Settings → Application Logs.
async function logApp(level, event, detail, opts = {}) {
  try {
    await query(
      `INSERT INTO public.app_logs (level, event, detail, profile_id, email, page_url)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [level, event, detail ? String(detail).slice(0, 4000) : null,
       opts.profile_id || null, opts.email || null, opts.page_url || null]
    );
  } catch (e) { console.error('[applog] failed to write:', e.message); }
}

module.exports = {
  ROLES, SESSION_TTL, PORTAL,
  verifyToken, verifyTokenFull, requireAuth, requireRole, signSession, safeProfile,
  json, err, errFromThrow, getSecret, getIp, getUA, readJson, qs, uuidOrNull,
  logAudit, logApp,
};
