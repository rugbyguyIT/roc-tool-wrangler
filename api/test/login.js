// ══════════════════════════════════════════════════════════════
// Signing in: by name, by email, and who is allowed to at all.
//
// Kyle's rules, in his words:
//   "I want to be able to login via my name."
//   "Only people who are Base can login. Admins should use a password."
//   "under the admin page in the groups section, I should be able to check
//    a box on if they can LOGIN to the App or not."
//
// The login path is the one place where a bug locks everybody out of
// everything, so this suite spends most of its time on the ways it can be
// wrong rather than on the happy path.
//
//   DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/login.js
//
// Run after smoke.js — it reuses that admin.
// ══════════════════════════════════════════════════════════════
const path = require('path');
const Module = require('module');
const bcrypt = require('bcryptjs');

const ROUTES = [];
const azureStub = {
  app: { http(name, cfg) { ROUTES.push({ name, ...cfg }); }, hook: { postInvocation() {} } },
};
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@azure/functions') return '@azure/functions';
  return realResolve.call(this, request, ...rest);
};
require.cache['@azure/functions'] = {
  id: '@azure/functions', filename: '@azure/functions', loaded: true, exports: azureStub,
};

const fs = require('fs');
const fnDir = path.join(__dirname, '..', 'src', 'functions');
for (const f of fs.readdirSync(fnDir).filter(f => f.endsWith('.js'))) require(path.join(fnDir, f));
const { query } = require('../src/db');

function matchRoute(method, urlPath) {
  const parts = urlPath.split('/').filter(Boolean);
  for (const r of ROUTES) {
    if (!r.methods.includes(method)) continue;
    const rp = r.route.split('/').filter(Boolean);
    if (rp.length !== parts.length) continue;
    const params = {}; let ok = true;
    for (let i = 0; i < rp.length; i++) {
      const m = /^\{(.+)\}$/.exec(rp[i]);
      if (m) params[m[1]] = decodeURIComponent(parts[i]);
      else if (rp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

async function call(token, method, url, body) {
  const [p, q] = url.split('?');
  const hit = matchRoute(method, p);
  if (!hit) return { status: 0, body: { error: `no route for ${method} ${p}` } };
  const headers = new Map([
    ['x-assets-token', token || ''],
    ['x-forwarded-for', '203.0.113.9'],
    ['user-agent', 'login-test/1.0'],
  ]);
  const request = {
    method,
    url: `http://localhost/api/${p}${q ? '?' + q : ''}`,
    params: hit.params,
    headers: { get: k => headers.get(k.toLowerCase()) ?? null },
    json: async () => { if (body === undefined) throw new Error('no body'); return body; },
  };
  const res = await hit.route.handler(request, { functionName: hit.route.name });
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch {}
  return { status: res.status, body: parsed };
}

let passed = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra ? `\n      ${JSON.stringify(extra)}` : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

const ZIP = '77002';
const TAGS = ['LOGIN-A', 'LOGIN-B', 'LOGIN-C', 'LOGIN-D'];

// A roster-provisioned person: a loanee with a member number, a matching
// profile whose password is their zip, and membership of one committee
// group. That is exactly the shape the roster import produces.
async function rosterPerson({ name, member, group, role = 'staff', zip = ZIP }) {
  const [first, ...rest] = name.split(' ');
  const last = rest.join(' ');
  const email = `${member.toLowerCase()}@login.test`;
  await query(`DELETE FROM public.profiles WHERE member_number = $1 OR email = $2`, [member, email]);
  await query(
    `DELETE FROM public.group_members gm USING public.loanees ln
      WHERE ln.id = gm.loanee_id AND ln.member_number = $1`, [member]);
  await query(`DELETE FROM public.loanees WHERE member_number = $1`, [member]);

  const ln = await query(
    `INSERT INTO public.loanees (first_name,last_name,full_name,member_number,title,sub_committee)
     VALUES ($1,$2,$3,$4,'Committee Member',$5) RETURNING id`,
    [first, last, name, member, group || null]);
  await query(
    `INSERT INTO public.profiles (email,first_name,last_name,full_name,role,password_hash,member_number,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
    [email, first, last, name, role, bcrypt.hashSync(zip, 10), member]);
  if (group) {
    const g = await query(
      `INSERT INTO public.groups (name) VALUES ($1)
       ON CONFLICT (lower(name)) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [group]);
    await query(
      `INSERT INTO public.group_members (group_id, loanee_id) VALUES ($1,$2)
       ON CONFLICT DO NOTHING`, [g.rows[0].id, ln.rows[0].id]);
  }
  return { name, email, member };
}

async function setGroupLogin(name, on) {
  await query(`UPDATE public.groups SET can_login = $2 WHERE lower(name) = lower($1)`, [name, on]);
}

async function cleanup() {
  await query(
    `DELETE FROM public.group_members gm USING public.loanees ln
      WHERE ln.id = gm.loanee_id AND ln.member_number LIKE 'LOGIN-%'`);
  await query(`DELETE FROM public.profiles WHERE member_number LIKE 'LOGIN-%'`);
  await query(`DELETE FROM public.loanees  WHERE member_number LIKE 'LOGIN-%'`);
  await query(`DELETE FROM public.groups   WHERE name IN ('ROC Login Test','Other Login Test')`);
}

(async function run() {
  const admin = await call('', 'POST', 'auth/login',
    { email: 'admin@hlsr.test', password: 'correct-horse-battery' });
  if (admin.status !== 200) {
    console.error('\x1b[31mRun api/test/smoke.js first — this suite reuses its admin.\x1b[0m');
    process.exit(2);
  }
  await cleanup();

  const ROC   = 'ROC Login Test';
  const OTHER = 'Other Login Test';

  const bob  = await rosterPerson({ name: 'Bobby Loginwell', member: 'LOGIN-A', group: ROC });
  const nan  = await rosterPerson({ name: 'Nancy Elsewhere', member: 'LOGIN-B', group: OTHER });
  await setGroupLogin(ROC, true);
  await setGroupLogin(OTHER, false);

  // ══ BY NAME ════════════════════════════════════════════════════════
  section('Signing in with a name');
  let r = await call('', 'POST', 'auth/login', { name: bob.name, password: ZIP });
  check('a Base member signs in with their name and zip', r.status === 200, r.body);
  check('and lands on the counter', r.body?.portal === '/pages/staff.html', r.body?.portal);
  check('the token is a real session', !!r.body?.token);

  r = await call('', 'POST', 'auth/login', { name: '  bobby   loginwell ', password: ZIP });
  check('stray spaces and case do not matter — rosters are typed by hand',
    r.status === 200, r.body);

  r = await call('', 'POST', 'auth/login', { name: bob.name, password: '00000' });
  check('the wrong zip is refused', r.status === 401, r.body);
  check('and the message does not confirm the name exists',
    /Incorrect name or password/.test(r.body?.error || ''), r.body?.error);

  r = await call('', 'POST', 'auth/login', { name: 'Nobody At All', password: ZIP });
  check('an unknown name gives the identical refusal',
    r.status === 401 && /Incorrect name or password/.test(r.body?.error || ''), r.body?.error);

  // ══ THE GROUP CHECKBOX ══════════════════════════════════════════════
  section('The group decides who may sign in');
  r = await call('', 'POST', 'auth/login', { name: nan.name, password: ZIP });
  check('someone whose committee is not ticked is refused', r.status === 403, r.body);
  check('and is told why, because they have already proved who they are',
    /does not have access/.test(r.body?.error || ''), r.body?.error);

  await setGroupLogin(OTHER, true);
  r = await call('', 'POST', 'auth/login', { name: nan.name, password: ZIP });
  check('ticking the box lets them straight in — no deploy', r.status === 200, r.body);

  await setGroupLogin(OTHER, false);
  r = await call('', 'POST', 'auth/login', { name: nan.name, password: ZIP });
  check('unticking it shuts them out again', r.status === 403, r.body);

  // A group that is switched off entirely must not still grant access.
  await setGroupLogin(ROC, true);
  await query(`UPDATE public.groups SET active = FALSE WHERE lower(name) = lower($1)`, [ROC]);
  r = await call('', 'POST', 'auth/login', { name: bob.name, password: ZIP });
  check('an INACTIVE group grants nothing, even ticked', r.status === 403, r.body);
  await query(`UPDATE public.groups SET active = TRUE WHERE lower(name) = lower($1)`, [ROC]);

  // ══ ADMINS ARE NEVER GATED ═════════════════════════════════════════
  section('Admins are never locked out by a checkbox');
  const boss = await rosterPerson({
    name: 'Ada Bossley', member: 'LOGIN-C', group: OTHER, role: 'admin' });
  await setGroupLogin(OTHER, false);
  r = await call('', 'POST', 'auth/login', { email: boss.email, password: ZIP });
  check('an admin in an unticked committee still signs in', r.status === 200, r.body);
  check('because otherwise there is no way back to the checkbox',
    r.body?.portal === '/pages/admin.html', r.body?.portal);

  // ══ HAND-MADE ACCOUNTS ═════════════════════════════════════════════
  section('Accounts made by hand are not gated');
  await query(`DELETE FROM public.profiles WHERE email = 'handmade@login.test'`);
  await query(
    `INSERT INTO public.profiles (email,first_name,last_name,full_name,role,password_hash,status)
     VALUES ('handmade@login.test','Hand','Made','Hand Made','staff',$1,'active')`,
    [bcrypt.hashSync('a-real-password-99', 10)]);
  r = await call('', 'POST', 'auth/login',
    { email: 'handmade@login.test', password: 'a-real-password-99' });
  check('an admin-created account with no committee still signs in', r.status === 200, r.body);
  await query(`DELETE FROM public.profiles WHERE email = 'handmade@login.test'`);

  // ══ TWO PEOPLE, ONE NAME ═══════════════════════════════════════════
  // A father and son at one address share a name AND a zip code. This
  // roster is families, so this is not a hypothetical.
  section('Two people with the same name');
  await rosterPerson({ name: 'Bobby Loginwell', member: 'LOGIN-D', group: ROC });
  await setGroupLogin(ROC, true);
  r = await call('', 'POST', 'auth/login', { name: 'Bobby Loginwell', password: ZIP });
  check('the app refuses rather than guessing which one', r.status === 409, r.body);
  check('and says how to get in instead',
    /email address/.test(r.body?.error || ''), r.body?.error);

  r = await call('', 'POST', 'auth/login', { email: bob.email, password: ZIP });
  check('each of them can still sign in by email', r.status === 200, r.body);

  // Same name, DIFFERENT zips: only one password matches, so there is
  // nothing ambiguous about it and the app must not refuse.
  await query(`UPDATE public.profiles SET password_hash = $1 WHERE member_number = 'LOGIN-D'`,
    [bcrypt.hashSync('99999', 10)]);
  r = await call('', 'POST', 'auth/login', { name: 'Bobby Loginwell', password: ZIP });
  check('two people, one name, different zips — the right one still gets in',
    r.status === 200 && r.body?.profile?.email === bob.email, r.body?.profile?.email);

  // ══ EMAIL STILL WORKS ═══════════════════════════════════════════════
  section('Nothing about email sign-in changed');
  r = await call('', 'POST', 'auth/login',
    { email: 'admin@hlsr.test', password: 'correct-horse-battery' });
  check('the admin signs in with email and password', r.status === 200, r.body);
  r = await call('', 'POST', 'auth/login',
    { email: 'admin@hlsr.test', password: 'wrong' });
  check('a wrong admin password is still refused', r.status === 401, r.body);
  check('with the email wording, not the name wording',
    /Incorrect email or password/.test(r.body?.error || ''), r.body?.error);

  r = await call('', 'POST', 'auth/login', { password: ZIP });
  check('sending no identifier at all is a clean 400', r.status === 400, r.body);

  // ══ THE AUDIT TRAIL ═════════════════════════════════════════════════
  section('Every outcome is on the record');
  const acts = await query(
    `SELECT DISTINCT action FROM public.audit_logs
      WHERE created_at > now() - interval '2 minutes'
        AND action LIKE 'login%'`);
  const seen = acts.rows.map(a => a.action);
  for (const a of ['login', 'login_failed', 'login_denied', 'login_ambiguous']) {
    check(`"${a}" is written to the audit log`, seen.includes(a), seen);
  }

  await cleanup();

  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length) {
    console.log('\x1b[31mFailures:\x1b[0m');
    failures.forEach(f => console.log(`  · ${f}`));
  }
  process.exit(failures.length ? 1 : 0);
})().catch(async (e) => {
  console.error('\n\x1b[31mHARNESS ERROR\x1b[0m', e);
  try { await cleanup(); } catch {}
  process.exit(2);
});
