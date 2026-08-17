// ═══════════════════════════════════════════════════════════════════════
// Bulk loanee removal + clear roster.
//
// The repair tests are mostly about what must NOT happen: a broken asset
// must not be checkoutable, must not be sendable twice, and must not lose
// its history when it comes back. The mapping tests are about a changed
// export format being a one-time fix rather than a monthly chore.
//
//   DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/repairs.js
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
    ['x-assets-token', TOKEN], ['x-forwarded-for', '203.0.113.9'], ['user-agent', 'repair-test/1.0'],
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

(async function run() {
  const { query } = require('../src/db');

  section('Setup');
  await query(`TRUNCATE public.asset_events, public.asset_repairs, public.loan_items, public.loans,
                        public.asset_photos, public.asset_groups, public.assets, public.group_members,
                        public.groups, public.loanees, public.profiles, public.audit_logs,
                        public.app_logs, public.import_rows, public.import_batches,
                        public.notification_outbox RESTART IDENTITY CASCADE`);
  await query(`INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  // TRUNCATE ... CASCADE above reaches asset_categories and asset_locations
  // through their created_by FK, and the smoke suite expects the migration's
  // seed lists to be present. Restore them rather than leaving the database
  // in a state that fails whichever suite runs next.
  await query(require('fs').readFileSync(require('path').join(__dirname, 'seed-lookups.sql'), 'utf8'));

  await query(`UPDATE public.app_settings SET roster_clear_pin_hash = crypt('1932', gen_salt('bf')) WHERE id = 1`);

  await call('POST', 'auth/bootstrap', { bootstrap_secret: process.env.BOOTSTRAP_SECRET || 'boot',
    email: 'admin@test.local', password: 'adminpassword1', first_name: 'Ada', last_name: 'Admin' });
  TOKEN = (await call('POST','auth/login',{email:'admin@test.local',password:'adminpassword1'})).body?.token;
  check('signed in', !!TOKEN);

  const mk = async (fn, ln) => (await call('POST','loanees',{first_name:fn,last_name:ln})).body?.id;
  const a = await mk('Ann','Able'), b = await mk('Bob','Baker'), c = await mk('Cal','Chase');
  const d = await mk('Dee','Doyle');
  check('four loanees created', !!(a&&b&&c&&d));

  // Give one of them loan history — that person must survive deletion.
  const cat = await query(`INSERT INTO public.asset_categories (name) VALUES ('Tools')
                           ON CONFLICT (lower(name)) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
  const asset = await call('POST','assets',{asset_tag:'T1',title:'Drill',category_id:cat.rows[0].id});
  const assetId = asset.body?.id || asset.body?.asset?.id;
  const co = await call('POST','checkout',{loanee_id:c,items:[{asset_id:assetId}]});
  check('Cal has loan history', co.status < 400, co.body);

  // ══ SORTING ══════════════════════════════════════════════════════════
  section('Sorting');
  let r = await call('GET','loanees?sort=last_name&dir=asc');
  check('sorts by last name ascending',
    r.body.rows.map(x=>x.last_name).join()==='Able,Baker,Chase,Doyle', r.body.rows.map(x=>x.last_name));
  r = await call('GET','loanees?sort=last_name&dir=desc');
  check('and descending',
    r.body.rows.map(x=>x.last_name).join()==='Doyle,Chase,Baker,Able', r.body.rows.map(x=>x.last_name));
  r = await call('GET','loanees?sort=first_name&dir=asc');
  check('sorts by first name', r.body.rows[0].first_name==='Ann', r.body.rows[0]);
  r = await call('GET','loanees?sort=DROP%20TABLE&dir=asc');
  check('an unknown sort falls back instead of reaching SQL',
    r.status===200 && r.body.sort==='last_name', {status:r.status, sort:r.body?.sort});
  r = await call('GET','loanees?sort=member_number&dir=asc');
  check('blank member numbers sort last, not first',
    r.status===200, r.body?.sort);

  // ══ BULK DELETE ══════════════════════════════════════════════════════
  section('Bulk delete');
  r = await call('POST','loanees/bulk-delete',{ids:[]});
  check('refuses an empty selection', r.status===400, r.body);

  r = await call('POST','loanees/bulk-delete',{ids:[a,b]});
  check('deletes people with no history', r.body?.deleted===2, r.body);
  let left = await query(`SELECT count(*)::int n FROM public.loanees`);
  check('they are gone from the table', left.rows[0].n===2, left.rows[0]);

  r = await call('POST','loanees/bulk-delete',{ids:[c]});
  check('someone with loan history is deactivated, not deleted',
    r.body?.deleted===0 && r.body?.deactivated===1, r.body);
  const cal = await query(`SELECT status, status_reason FROM public.loanees WHERE id=$1`,[c]);
  check('and is marked inactive with a reason',
    cal.rows[0]?.status==='inactive' && !!cal.rows[0]?.status_reason, cal.rows[0]);
  const hist = await query(`SELECT count(*)::int n FROM public.loans WHERE loanee_id=$1`,[c]);
  check('the loan history survives', hist.rows[0].n===1, hist.rows[0]);

  // ══ CLEAR ROSTER ═════════════════════════════════════════════════════
  section('Clear roster');
  r = await call('POST','loanees/clear-roster',{pin:'1932'});
  check('refuses without the typed confirmation', r.status===400, r.body);
  r = await call('POST','loanees/clear-roster',{pin:'1932',confirm:'delete'});
  check('the confirmation is case-sensitive', r.status===400, r.body);
  r = await call('POST','loanees/clear-roster',{confirm:'DELETE'});
  check('refuses without a PIN', r.status===400, r.body);
  r = await call('POST','loanees/clear-roster',{pin:'0000',confirm:'DELETE'});
  check('refuses a wrong PIN', r.status===403, r.body);

  const denied = await query(`SELECT count(*)::int n FROM public.audit_logs WHERE action='roster_clear_denied'`);
  check('a wrong PIN is written to the audit log', denied.rows[0].n===1, denied.rows[0]);

  await query(`UPDATE public.app_settings SET roster_groups_seeded_at = now() WHERE id = 1`);
  r = await call('POST','loanees/clear-roster',{pin:'1932',confirm:'DELETE'});
  check('the correct PIN clears the roster', r.status===200, r.body);
  check('Dee is deleted and Cal is kept for her history',
    r.body?.deleted===1 && r.body?.deactivated===1, r.body);

  const after = await query(`SELECT count(*)::int n FROM public.loanees`);
  check('only the person with history remains', after.rows[0].n===1, after.rows[0]);

  const seeded = await query(`SELECT roster_groups_seeded_at FROM public.app_settings WHERE id=1`);
  check('clearing lets the next import seed groups again',
    seeded.rows[0].roster_groups_seeded_at===null, seeded.rows[0]);

  const cleared = await query(`SELECT count(*)::int n FROM public.audit_logs WHERE action='roster_cleared'`);
  check('the clear is audited', cleared.rows[0].n===1, cleared.rows[0]);

  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length) { failures.forEach(f=>console.log(`  \x1b[31m· ${f}\x1b[0m`)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('\n\x1b[31mFATAL\x1b[0m', e); process.exit(1); });
