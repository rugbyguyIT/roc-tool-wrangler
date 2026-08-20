// ════════════════════════════════════════════════════════════
// What can a Base member actually see?
//
// Reading the role gates tells you the intent. This signs in as each
// role and looks at what really comes back, field by field, because the
// gap between those two is where a privacy problem lives.
//
//   DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/pii-audit.js
//
// Run after smoke.js.
// ════════════════════════════════════════════════════════════
const path = require('path');
const Module = require('module');

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
    ['x-assets-token', token],
    ['x-forwarded-for', '203.0.113.9'],
    ['user-agent', 'pii-audit/1.0'],
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

// Every field name we consider personal, so the report is about people
// rather than about columns.
//
// Aliases matter as much as columns: v_open_loan_items renames the same
// data to loanee_phone / loanee_email, and an audit that only looks for
// `phone_mobile` reports the open-loans feed as carrying no contact
// details at all. It carries both.
const PII = ['email', 'loanee_email', 'phone_mobile', 'loanee_phone',
             'member_number', 'notes', 'loan_notes', 'out_notes', 'in_notes',
             'status_reason', 'first_name', 'last_name', 'full_name', 'loanee_name',
             'position', 'sub_committee', 'title', 'checked_out_by_name',
             'actor_name', 'ip_address', 'user_agent', 'password_hash',
             'token_version', 'roster_clear_pin_hash', 'photo_url', 'last_login_at'];

function fieldsIn(v, found = new Set(), depth = 0) {
  if (depth > 6 || v === null || typeof v !== 'object') return found;
  if (Array.isArray(v)) { for (const x of v.slice(0, 5)) fieldsIn(x, found, depth + 1); return found; }
  for (const [k, val] of Object.entries(v)) {
    found.add(k);
    fieldsIn(val, found, depth + 1);
  }
  return found;
}

async function cleanup() {
  await query(
    `DELETE FROM public.profiles WHERE email IN ('pii.base@hlsr.test','pii.leader@hlsr.test')`);
  await query(`DELETE FROM public.loanees WHERE email = 'pii.subject@example.com'`);
}

(async function run() {
  const admin = await call('', 'POST', 'auth/login',
    { email: 'admin@hlsr.test', password: 'correct-horse-battery' });
  if (admin.status !== 200) {
    console.error('Run api/test/smoke.js first.');
    process.exit(2);
  }
  const AT = admin.body.token;

  // A Base account and a Leadership account, made the way an admin makes
  // them — which means two accounts that can genuinely sign in, with a
  // password written in this file. They are removed in the finally below,
  // whatever happens, because a suite whose whole subject is "who can see
  // what" must not be the thing that leaves working credentials lying
  // around in a database.
  await query(`DELETE FROM public.profiles WHERE email IN ('pii.base@hlsr.test','pii.leader@hlsr.test')`);
  for (const [email, role] of [['pii.base@hlsr.test', 'staff'], ['pii.leader@hlsr.test', 'leader']]) {
    const r = await call(AT, 'POST', 'users', {
      first_name: 'Pii', last_name: role, email, role, password: 'counter-tablet-9911' });
    if (r.status !== 201 && r.status !== 200) console.error('could not create', role, r.body);
  }
  const bl = await call('', 'POST', 'auth/login', { email: 'pii.base@hlsr.test', password: 'counter-tablet-9911' });
  const ll = await call('', 'POST', 'auth/login', { email: 'pii.leader@hlsr.test', password: 'counter-tablet-9911' });
  const BT = bl.body?.token, LT = ll.body?.token;
  if (!BT || !LT) { console.error('could not sign in as base/leader', bl.body, ll.body); process.exit(2); }

  // Give one member every field filled, so "absent" means withheld and not
  // merely empty in the fixture.
  await query(`DELETE FROM public.loanees WHERE email = 'pii.subject@example.com'`);
  const subj = await query(
    `INSERT INTO public.loanees
       (first_name,last_name,full_name,email,phone_mobile,position,sub_committee,
        notes,member_number,title,status_reason)
     VALUES ('Pat','Subject','Pat Subject','pii.subject@example.com','713-555-0142',
             'Crew','Rodeo Operations','Has a bad knee; no heavy lifting.','MBR-88231',
             'Committee Member','left the committee in 2024')
     RETURNING id`);
  const SUBJ = subj.rows[0].id;

  const PROBES = [
    ['GET', 'loanees?limit=5',                    'Member list'],
    ['GET', 'loanees/lookup?q=Subject',           'Member type-ahead (the counter picker)'],
    ['GET', `loanees/${SUBJ}`,                    'One member, full detail'],
    ['GET', 'loanees/committees',                 'Committee list'],
    ['GET', 'users?limit=5',                      'App user accounts'],
    ['GET', 'me',                                 'Their own profile'],
    ['GET', 'loans/open',                         'What is out right now'],
    ['GET', 'reports/out-now',                    'Report: currently out'],
    ['GET', 'reports/overdue',                    'Report: overdue'],
    ['GET', 'reports/by-loanee',                  'Report: usage by member'],
    ['GET', 'reports/by-asset',                   'Report: usage by asset'],
    ['GET', 'reports/inventory',                  'Report: inventory'],
    ['GET', 'reports/activity',                   'Report: activity log'],
    ['GET', 'audit-logs?limit=5',                 'Audit log (IPs, sign-in attempts)'],
    ['GET', 'app-logs?limit=5',                   'Application error log'],
    ['GET', 'imports?limit=5',                    'Import history'],
    ['GET', 'settings',                           'Settings'],
    ['GET', 'groups',                             'Groups'],
    ['GET', `loanees/${SUBJ}/limit`,              'One member: item-limit status'],
  ];

  const W = 42;
  console.log('\n\x1b[1m' + 'ENDPOINT'.padEnd(W) + '  ADMIN   BASE    LEADER\x1b[0m');
  console.log('─'.repeat(W + 24));

  const baseSees = new Map();
  for (const [method, url, label] of PROBES) {
    const a = await call(AT, method, url);
    const b = await call(BT, method, url);
    const l = await call(LT, method, url);
    const code = s => s.status === 200 ? '\x1b[32m200\x1b[0m'
      : s.status === 403 ? '\x1b[33m403\x1b[0m'
      : s.status === 404 ? '404' : `\x1b[31m${s.status}\x1b[0m`;
    console.log(label.padEnd(W) + '  ' + code(a) + '     ' + code(b) + '     ' + code(l));
    if (b.status === 200) baseSees.set(label, fieldsIn(b.body));
  }

  console.log('\n\x1b[1mPersonal fields a BASE member receives\x1b[0m');
  const everything = new Set();
  for (const [label, fields] of baseSees) {
    const hits = PII.filter(f => fields.has(f));
    hits.forEach(f => everything.add(f));
    if (hits.length) console.log(`  ${label}\n      ${hits.join(', ')}`);
  }

  console.log('\n\x1b[1mNever reaches a Base member\x1b[0m');
  const withheld = PII.filter(f => !everything.has(f));
  console.log('  ' + (withheld.join(', ') || '(nothing — every personal field is visible)'));

  // ── The part that FAILS ──────────────────────────────
  // Everything above is a report: it describes what is visible without
  // judging it, because most of it is a product decision (the counter is
  // supposed to see a phone number). What follows are the boundaries that
  // are not a decision, so that adding an unguarded read route breaks the
  // build instead of quietly widening what a shared shed tablet can pull.
  //
  // routes-audit.js already does this for routes that WRITE. This is the
  // same idea for routes that read.
  let passed = 0;
  const failures = [];
  function must(label, cond, extra) {
    if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
    else { failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra ? `\n      ${JSON.stringify(extra)}` : ''}`); }
  }

  console.log('\n\x1b[1mBoundaries that must hold\x1b[0m');

  // Secrets, on every endpoint either non-admin role can reach at all.
  const SECRETS = ['password_hash', 'token_version', 'roster_clear_pin_hash'];
  for (const [tok, who] of [[BT, 'Base'], [LT, 'Leadership']]) {
    const leaked = new Set();
    for (const [method, url] of PROBES.map(p => [p[0], p[1]])) {
      const res = await call(tok, method, url);
      if (res.status !== 200) continue;
      const f = fieldsIn(res.body);
      SECRETS.forEach(s => { if (f.has(s)) leaked.add(s); });
    }
    must(`no secret ever reaches ${who} on any readable endpoint`,
      leaked.size === 0, [...leaked]);
  }

  // The admin-only reads, named individually so a failure says which one.
  const ADMIN_ONLY = [
    ['users?limit=5', 'app user accounts'],
    ['reports/by-loanee', 'usage by member'],
    ['reports/by-asset', 'usage by asset'],
    ['reports/inventory', 'inventory'],
    ['reports/activity', 'the activity log'],
    ['audit-logs?limit=5', 'the audit log'],
    ['app-logs?limit=5', 'the error log'],
    ['imports?limit=5', 'import history'],
  ];
  for (const [url, label] of ADMIN_ONLY) {
    const b = await call(BT, 'GET', url);
    const l = await call(LT, 'GET', url);
    must(`${label} stays admin-only`,
      b.status === 403 && l.status === 403, { base: b.status, leader: l.status });
  }

  // Signed out is not a role. An unauthenticated caller reaches nothing.
  for (const [method, url, label] of PROBES) {
    const anon = await call('', method, url);
    if (anon.status === 200) failures.push(`ANONYMOUS can read ${label}`);
  }
  must('nothing at all is readable without signing in',
    !failures.some(f => f.startsWith('ANONYMOUS')),
    failures.filter(f => f.startsWith('ANONYMOUS')));

  await cleanup();

  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length) {
    console.log('\x1b[31mFailures:\x1b[0m');
    failures.forEach(f => console.log(`  · ${f}`));
  }
  process.exit(failures.length ? 1 : 0);
})().catch(async (e) => {
  console.error('\n\x1b[31mHARNESS ERROR\x1b[0m', e);
  // Still take the accounts away. A crashed audit that leaves two working
  // logins behind is worse than one that simply failed.
  try { await cleanup(); } catch {}
  process.exit(2);
});
