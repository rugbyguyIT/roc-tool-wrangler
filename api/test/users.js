// ═════════════════════════════════════════════════════════════════════
// App-user search, and creating an account from someone on the roster.
//
// Two things are being pinned down here.
//
// The search has one real trap: the phone clause. Digits are stripped
// from the search term, and if that stripping happens inside SQL then a
// search for "kyle" becomes LIKE '%%' and quietly matches every account
// — a filter that returns everything looks like a filter that is broken
// in the other direction, so it can sit there for weeks. The digits are
// therefore computed in JS and passed as their own parameter, and the
// phone clause is skipped when that parameter is empty. Several tests
// below exist only to hold that line.
//
// The second is member_number. An account created from a loanee has to
// carry the roster key across, because the roster sync matches on it.
// Without it the next sync sees no profile for that member and creates a
// second account beside the one you just made.
//
//   DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/users.js
// ═════════════════════════════════════════════════════════════════════
const path = require('path');
const Module = require('module');
const fs = require('fs');

const ROUTES = [];
const azureStub = {
  app: { http(name, cfg) { ROUTES.push({ name, ...cfg }); }, hook: { postInvocation() {} } },
};
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@azure/functions') return '@azure/functions';
  return realResolve.call(this, request, ...rest);
};
require.cache['@azure/functions'] = { id: '@azure/functions', filename: '@azure/functions', loaded: true, exports: azureStub };

const fnDir = path.join(__dirname, '..', 'src', 'functions');
for (const f of fs.readdirSync(fnDir).filter(f => f.endsWith('.js'))) require(path.join(fnDir, f));

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

let TOKEN = '';
async function call(method, url, body) {
  const [p, q] = url.split('?');
  const hit = matchRoute(method, p);
  if (!hit) throw new Error(`No route for ${method} ${p}`);
  const headers = new Map([
    ['x-assets-token', TOKEN], ['x-forwarded-for', '203.0.113.9'], ['user-agent', 'users-test/1.0'],
  ]);
  const request = {
    method, url: `http://localhost/api/${p}${q ? '?' + q : ''}`, params: hit.params,
    headers: { get: k => headers.get(k.toLowerCase()) ?? null },
    json: async () => { if (body === undefined) throw new Error('no body'); return body; },
  };
  const res = await hit.route.handler(request, { functionName: hit.route.name });
  let parsed = null; try { parsed = JSON.parse(res.body); } catch {}
  return { status: res.status, body: parsed };
}

let passed = 0; const failures = [];
function check(label, cond, extra) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }
const names = rows => (rows || []).map(r => r.full_name).sort();

(async function run() {
  const { query } = require('../src/db');

  section('Setup');
  await query(`TRUNCATE public.asset_events, public.asset_repairs, public.loan_items, public.loans,
                        public.asset_photos, public.asset_groups, public.assets, public.group_members,
                        public.groups, public.loanees, public.profiles, public.audit_logs,
                        public.app_logs, public.import_rows, public.import_batches,
                        public.notification_outbox
               RESTART IDENTITY CASCADE`);
  await query(`INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await query(fs.readFileSync(path.join(__dirname, 'seed-lookups.sql'), 'utf8'));

  await call('POST', 'auth/bootstrap', {
    bootstrap_secret: process.env.BOOTSTRAP_SECRET || 'boot', email: 'admin@test.local',
    password: 'adminpassword1', first_name: 'Ada', last_name: 'Admin',
  });
  TOKEN = (await call('POST', 'auth/login', { email: 'admin@test.local', password: 'adminpassword1' })).body?.token;
  check('signed in as admin', !!TOKEN);

  // A small, deliberately awkward cast: two people sharing a surname, one
  // with a member number, one whose phone digits overlap another's.
  const mk = async (first, last, email, phone, role, member) => {
    const r = await call('POST', 'users', {
      first_name: first, last_name: last, email, phone_mobile: phone, role,
      password: 'temporarypassword1', member_number: member,
    });
    return r;
  };
  await mk('Kyle', 'Sandoval', 'kyle@thesandovals.net', '713-555-0142', 'admin', '100200');
  await mk('Dana', 'Sandoval', 'dana@example.com', '713-555-0199', 'staff', null);
  await mk('Marcus', 'Webb', 'mwebb@example.com', '281-555-0142', 'leader', '400500');
  const all = await call('GET', 'users');
  check('four accounts exist', all.body?.length === 4, all.body?.length);

  section('Search by name');
  const bySur = await call('GET', 'users?q=Sandoval');
  check('surname returns both Sandovals', names(bySur.body).join(',') === 'Dana Sandoval,Kyle Sandoval', names(bySur.body));

  const byFirst = await call('GET', 'users?q=kyle');
  check('first name matches, case-insensitively', names(byFirst.body).join(',') === 'Kyle Sandoval', names(byFirst.body));

  const partial = await call('GET', 'users?q=sando');
  check('a partial surname still matches', partial.body?.length === 2, names(partial.body));

  section('Search by email and member number');
  const byEmail = await call('GET', 'users?q=mwebb@example.com');
  check('full email finds exactly one', names(byEmail.body).join(',') === 'Marcus Webb', names(byEmail.body));

  const byDomain = await call('GET', 'users?q=thesandovals');
  check('a fragment of the email matches', names(byDomain.body).join(',') === 'Kyle Sandoval', names(byDomain.body));

  const byMember = await call('GET', 'users?q=400500');
  check('member number finds its account', names(byMember.body).join(',') === 'Marcus Webb', names(byMember.body));

  section('Search by phone — the clause that can silently match everything');
  const byPhone = await call('GET', 'users?q=713-555-0199');
  check('a formatted phone number matches', names(byPhone.body).join(',') === 'Dana Sandoval', names(byPhone.body));

  const byDigits = await call('GET', 'users?q=5550199');
  check('bare digits match through the formatting', names(byDigits.body).join(',') === 'Dana Sandoval', names(byDigits.body));

  const shared = await call('GET', 'users?q=0142');
  check('a shared fragment matches both holders', names(shared.body).join(',') === 'Kyle Sandoval,Marcus Webb', names(shared.body));

  // The regression this file exists for.
  const alpha = await call('GET', 'users?q=zzzznotarealname');
  check('an alphabetic term with no match returns NOTHING, not everything',
    alpha.body?.length === 0, names(alpha.body));

  const punct = await call('GET', 'users?q=---');
  check('punctuation-only search does not match everything', punct.body?.length === 0, names(punct.body));

  section('Search combines with the existing filters');
  const roleAnd = await call('GET', 'users?q=Sandoval&role=admin');
  check('search AND role narrows to one', names(roleAnd.body).join(',') === 'Kyle Sandoval', names(roleAnd.body));

  const none = await call('GET', 'users');
  check('no search term still returns everyone', none.body?.length === 4, none.body?.length);

  section('Creating an account from someone on the roster');
  const ln = await call('POST', 'loanees', {
    first_name: 'Roberta', last_name: 'Drackett', email: 'rdrackett@example.com',
    phone_mobile: '832-555-0110', member_number: '778899', sub_committee: 'Rodeo Operations',
  });
  check('roster member exists', !!(ln.body?.loanee?.id || ln.body?.id), ln.body);

  const look = await call('GET', 'loanees/lookup?q=Drackett');
  const hit = look.body?.matches?.[0];
  check('the picker finds her', hit?.full_name === 'Roberta Drackett', look.body);
  check('the picker returns her member number so it can be carried across',
    hit?.member_number === '778899', hit);
  check('the picker returns the fields the form fills',
    hit?.first_name === 'Roberta' && hit?.last_name === 'Drackett'
    && hit?.email === 'rdrackett@example.com' && !!hit?.phone_mobile, hit);

  const made = await call('POST', 'users', {
    first_name: hit.first_name, last_name: hit.last_name, email: hit.email,
    phone_mobile: hit.phone_mobile, member_number: hit.member_number,
    role: 'staff', password: 'temporarypassword1',
  });
  check('the account is created', made.status === 201, made.body);

  const check2 = await query(`SELECT member_number, role FROM public.profiles WHERE lower(email) = $1`,
    ['rdrackett@example.com']);
  check('member number is stored on the profile', check2.rows[0]?.member_number === '778899', check2.rows[0]);
  check('the role chosen in the form is what is saved — not one inferred from the roster',
    check2.rows[0]?.role === 'staff', check2.rows[0]);

  const findNew = await call('GET', 'users?q=778899');
  check('the new account is findable by member number', names(findNew.body).join(',') === 'Roberta Drackett', names(findNew.body));

  section('Duplicate member number is refused, and says so accurately');
  const dupe = await call('POST', 'users', {
    first_name: 'Bobbie', last_name: 'Drackett', email: 'different@example.com',
    member_number: '778899', role: 'leader', password: 'temporarypassword1',
  });
  check('a second account on the same member number is rejected', dupe.status === 409, dupe);
  check('and the message names the member number, not the email',
    /member number/i.test(dupe.body?.error || ''), dupe.body);

  const dupeEmail = await call('POST', 'users', {
    first_name: 'Someone', last_name: 'Else', email: 'kyle@thesandovals.net',
    role: 'leader', password: 'temporarypassword1',
  });
  check('a duplicate email is still rejected as an email clash', dupeEmail.status === 409
    && /email/i.test(dupeEmail.body?.error || ''), dupeEmail.body);

  section('Blank member number is stored as NULL, so many can have none');
  const noMember1 = await call('POST', 'users', {
    first_name: 'Pat', last_name: 'Nomember', email: 'pat@example.com',
    member_number: '', role: 'staff', password: 'temporarypassword1',
  });
  const noMember2 = await call('POST', 'users', {
    first_name: 'Jo', last_name: 'Alsonone', email: 'jo@example.com',
    member_number: '', role: 'staff', password: 'temporarypassword1',
  });
  check('two accounts with an empty member number both succeed',
    noMember1.status === 201 && noMember2.status === 201, [noMember1.body, noMember2.body]);
  const nulls = await query(
    `SELECT count(*)::int AS n FROM public.profiles WHERE member_number IS NULL`);
  check('empty string was normalised to NULL', nulls.rows[0].n >= 2, nulls.rows[0]);

  section('Search stays admin-only');
  const savedToken = TOKEN;
  const staffLogin = await call('POST', 'auth/login', { email: 'pat@example.com', password: 'temporarypassword1' });
  TOKEN = staffLogin.body?.token || '';
  check('a Base user signed in', !!TOKEN, staffLogin.body);
  const denied = await call('GET', 'users?q=Sandoval');
  check('a Base user cannot search the account list', denied.status === 403, denied);
  TOKEN = savedToken;

  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length) { failures.forEach(f => console.log(`  - ${f}`)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
