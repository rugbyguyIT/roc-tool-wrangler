// ═══════════════════════════════════════════════════════════════════════
// Roster import test — the 493-row Rodeo Operations export.
//
// The fixture mirrors the real export's SHAPE exactly — same row count,
// same titles, same subcommittee distribution, same which-rows-have-a-
// preferred-name pattern, same ZIP+4-vs-5-digit mix — but names, emails,
// phones and zips are synthetic. No real member's contact details are
// committed to this repo.
//
// The first import is the easy case. This suite is mostly about the
// SECOND and THIRD imports, because that is where a roster sync goes
// wrong in ways nobody notices for a month:
//   · re-importing an unchanged file must change nothing at all
//   · a changed cell must update that field and no others
//   · a hand-edited note must survive a re-import
//   · someone dropping off the file must deactivate, not vanish
//   · someone returning must reactivate
//   · groups must be created ONCE and never silently again
//   · a password someone changed must not be reset by a re-import
//
// Same harness as smoke.js: real handlers, real Postgres, no Azure.
//
//   DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/roster.js
// ═══════════════════════════════════════════════════════════════════════
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
    ['x-assets-token', TOKEN],
    ['x-forwarded-for', '203.0.113.7'],
    ['user-agent', 'roster-test/1.0'],
  ]);
  const request = {
    method, url: `http://localhost/api/${p}${q ? '?' + q : ''}`,
    params: hit.params,
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
  else { failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures-roster.json'), 'utf8'));
const CHUNK = 250;

// Push a whole roster through preview (chunked, like the browser does)
// and return the final preview response.
async function preview(rows, headers) {
  let batchId = null; let last = null;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const final = i + CHUNK >= rows.length;
    const r = await call('POST', 'roster/preview', {
      batch_id: batchId, filename: 'roster.xls', headers, rows: slice, final,
    });
    if (r.status !== 200) throw new Error(`preview failed: ${JSON.stringify(r.body)}`);
    batchId = r.body.batch_id; last = r.body;
  }
  return last;
}

// Preview returns only the current chunk's rows, so totals come from the
// database rather than from the last response.
async function verdictCounts(query, batchId) {
  const r = await query(
    `SELECT verdict, count(*)::int AS n FROM public.import_rows WHERE batch_id = $1 GROUP BY verdict`,
    [batchId]);
  return Object.fromEntries(r.rows.map(x => [x.verdict, x.n]));
}

(async function run() {
  const { query } = require('../src/db');

  section('Reset');
  await query(`TRUNCATE public.asset_events, public.loan_items, public.loans, public.asset_photos,
                        public.asset_groups, public.assets, public.group_members, public.groups,
                        public.loanees, public.profiles, public.audit_logs, public.app_logs,
                        public.import_rows, public.import_batches, public.notification_outbox
               RESTART IDENTITY CASCADE`);
  await query(`INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await query(`UPDATE public.app_settings SET roster_groups_seeded_at = NULL WHERE id = 1`);
  check('clean database', true);

  await call('POST', 'auth/bootstrap', {
    bootstrap_secret: process.env.BOOTSTRAP_SECRET || 'boot', email: 'admin@test.local',
    password: 'adminpassword1', first_name: 'Ada', last_name: 'Admin',
  });
  const login = await call('POST', 'auth/login', {
    email: 'admin@test.local', password: 'adminpassword1',
  });
  TOKEN = login.body?.token;
  check('admin created and signed in', !!TOKEN, login.body);

  // ══ FIRST IMPORT ═════════════════════════════════════════════════════════════════
  section('First import — 493 rows');
  const p1 = await preview(FIX.rows, FIX.headers);
  const c1 = await verdictCounts(query, p1.batch_id);
  check('493 rows previewed', (c1.create || 0) + (c1.unchanged || 0) + (c1.update || 0) + (c1.error || 0) === 493, c1);
  check('all 493 are new', c1.create === 493, c1);
  check('no errors', !c1.error, c1);
  check('nothing to deactivate on a first import', !c1.deactivate, c1);
  check('13 groups offered (14 subcommittees minus the blank)', p1.will_create_groups.length === 13,
    p1.will_create_groups);
  check('52 logins planned', p1.logins.staff + p1.logins.leader === 52, p1.logins);
  check('49 Base / 3 leadership', p1.logins.staff === 49 && p1.logins.leader === 3, p1.logins);

  const cm1 = await call('POST', 'roster/commit', { batch_id: p1.batch_id });
  check('commit succeeded', cm1.status === 200, cm1.body);
  check('493 loanees created', cm1.body?.created === 493, cm1.body);
  check('52 logins created', cm1.body?.logins_created === 52, cm1.body);

  const n = await query(`SELECT count(*)::int AS c FROM public.loanees`);
  check('493 loanees in the database', n.rows[0].c === 493, n.rows[0]);

  const grp = await query(`SELECT count(*)::int AS c FROM public.groups`);
  check('13 groups created', grp.rows[0].c === 13, grp.rows[0]);

  const gm = await query(`SELECT count(*)::int AS c FROM public.group_members`);
  check('489 people placed in a committee group (4 have no subcommittee)', gm.rows[0].c === 489, gm.rows[0]);

  // Preferred name must win. In the real roster this is Charles "Lee"
  // Knape; the fixture is anonymised but preserves which rows HAVE a
  // preferred name, which is the behaviour under test.
  const lee = await query(`SELECT first_name, last_name, title FROM public.loanees WHERE member_number = '1092155'`);
  check('preferred name wins over first name', lee.rows[0]?.first_name === 'Jory', lee.rows[0]);
  check('title loaded', lee.rows[0]?.title === 'Division Chairman', lee.rows[0]);

  // Zip is the password, 5 digits even when the roster has ZIP+4.
  const bcrypt = require('bcryptjs');
  const prof = await query(`SELECT email, role, password_hash FROM public.profiles WHERE member_number = '1092155'`);
  check('leadership got a leader login', prof.rows[0]?.role === 'leader', prof.rows[0]);
  check('password is the 5-digit zip, not ZIP+4', bcrypt.compareSync('77001', prof.rows[0].password_hash));

  const baseProf = await query(
    `SELECT p.role FROM public.profiles p JOIN public.loanees l USING (member_number)
     WHERE lower(l.sub_committee) = 'base' LIMIT 1`);
  check('Base members get the staff (Base) role', baseProf.rows[0]?.role === 'staff', baseProf.rows[0]);

  // ══ SECOND IMPORT — identical file ════════════════════════════════════════════════════════
  section('Second import — identical file, must be a no-op');
  const p2 = await preview(FIX.rows, FIX.headers);
  const c2 = await verdictCounts(query, p2.batch_id);
  check('all 493 unchanged', c2.unchanged === 493, c2);
  check('nothing to create', !c2.create, c2);
  check('nothing to update', !c2.update, c2);
  check('nothing to deactivate', !c2.deactivate, c2);
  check('groups already seeded, none offered', p2.will_create_groups.length === 0 && p2.groups_already_seeded === true);

  const cm2 = await call('POST', 'roster/commit', { batch_id: p2.batch_id });
  check('re-commit creates nothing', cm2.body?.created === 0 && cm2.body?.updated === 0, cm2.body);
  check('re-commit creates no duplicate logins', cm2.body?.logins_created === 0, cm2.body);
  const n2 = await query(`SELECT count(*)::int AS c FROM public.loanees`);
  check('still exactly 493 loanees — no duplicates', n2.rows[0].c === 493, n2.rows[0]);

  // ══ THIRD IMPORT — real-world edits ═════════════════════════════════════════════════════
  section('Third import — changed cells, a departure, a hand edit');

  // A hand-written note in the app: a re-import must never touch it.
  await query(`UPDATE public.loanees SET notes = 'Has the yellow gate key' WHERE member_number = '1175843'`);
  // A password the person changed after being onboarded.
  await query(`UPDATE public.profiles SET password_hash = $1 WHERE member_number = '1092155'`,
    [bcrypt.hashSync('theirOwnPassword', 10)]);

  const edited = JSON.parse(JSON.stringify(FIX.rows));
  // 1. phone change
  edited[0]['Primary Phone'] = '(281) 555-0000';
  // 2. committee move
  edited[1]['Subcommittee 1'] = 'Mainline';
  // 3. preferred name finally filled in
  edited[2]['Preferred Name'] = 'Cazy';   // row 2 has no preferred name in the fixture
  // 4. someone leaves the roster entirely
  const departed = edited.pop();
  // 5. a brand-new member joins
  edited.push({
    'Title': 'Committee Member', 'Customer Number': '9999999', 'First Name': 'Newton',
    'Last Name': 'Newmember', 'Preferred Name': '', 'Subcommittee 1': 'Mainline',
    'Primary Phone': '(713) 555-1212', 'Primary Email': 'newton@example.com',
    'Zip': '77002-1234', 'row_number': 999,
  });

  const p3 = await preview(edited, FIX.headers);
  const c3 = await verdictCounts(query, p3.batch_id);
  check('exactly 3 updates detected', c3.update === 3, c3);
  check('exactly 1 new member', c3.create === 1, c3);
  check('exactly 1 departure flagged', c3.deactivate === 1, c3);
  check('the other 489 are unchanged', c3.unchanged === 489, c3);

  const upd = await query(
    `SELECT normalized->>'member_number' AS mn, changes FROM public.import_rows
     WHERE batch_id = $1 AND verdict = 'update' ORDER BY row_number`, [p3.batch_id]);
  const byMn = Object.fromEntries(upd.rows.map(r => [r.mn, r.changes]));
  check('phone change is the only diff on that row',
    Object.keys(byMn['1175843'] || {}).join() === 'phone_mobile', byMn['1175843']);
  check('committee change is the only diff on that row',
    Object.keys(byMn['1092155'] || {}).join() === 'sub_committee', byMn['1092155']);
  check('preferred name change is the only diff on that row',
    Object.keys(byMn['2028411'] || {}).join() === 'first_name', byMn['2028411']);

  const cm3 = await call('POST', 'roster/commit', { batch_id: p3.batch_id });
  check('commit applied 3 updates', cm3.body?.updated === 3, cm3.body);
  check('commit added 1 person', cm3.body?.created === 1, cm3.body);
  check('commit deactivated 1 person', cm3.body?.deactivated === 1, cm3.body);

  const note = await query(`SELECT notes FROM public.loanees WHERE member_number = '1175843'`);
  check('hand-written note survived the re-import', note.rows[0]?.notes === 'Has the yellow gate key', note.rows[0]);

  const pw = await query(`SELECT password_hash FROM public.profiles WHERE member_number = '1092155'`);
  check('changed password was NOT reset by the re-import',
    bcrypt.compareSync('theirOwnPassword', pw.rows[0].password_hash));

  const off = await query(`SELECT status, status_reason FROM public.loanees WHERE member_number = $1`,
    [departed['Customer Number']]);
  check('departed member is inactive, not deleted', off.rows[0]?.status === 'inactive', off.rows[0]);
  check('deactivation records why', /absent from roster/.test(off.rows[0]?.status_reason || ''), off.rows[0]);

  const nameChanged = await query(`SELECT first_name, last_name, full_name FROM public.loanees WHERE member_number = '2028411'`);
  check('full_name recomputed with the new first name',
    nameChanged.rows[0]?.first_name === 'Cazy'
    && nameChanged.rows[0]?.full_name === `Cazy ${nameChanged.rows[0].last_name}`, nameChanged.rows[0]);

  const newGroups = await query(`SELECT count(*)::int AS c FROM public.groups`);
  check('no new groups created after the first import', newGroups.rows[0].c === 13, newGroups.rows[0]);

  // ══ FOURTH IMPORT — the departed member returns ══════════════════════════════════════════════════
  section('Fourth import — a returning member reactivates');
  const p4 = await preview(FIX.rows, FIX.headers);   // original file: they're back
  const c4 = await verdictCounts(query, p4.batch_id);
  check('the returning member is an update', (c4.update || 0) >= 1, c4);
  await call('POST', 'roster/commit', { batch_id: p4.batch_id });
  const back = await query(`SELECT status, status_reason FROM public.loanees WHERE member_number = $1`,
    [departed['Customer Number']]);
  check('returning member is active again', back.rows[0]?.status === 'active', back.rows[0]);
  check('stale deactivation reason cleared', !back.rows[0]?.status_reason, back.rows[0]);

  // ══ Summary ════════════════════════════════════════════════════════════════
  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length) { failures.forEach(f => console.log(`  \x1b[31m· ${f}\x1b[0m`)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('\n\x1b[31mFATAL\x1b[0m', e); process.exit(1); });
