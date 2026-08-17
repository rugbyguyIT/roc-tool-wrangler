// ═══════════════════════════════════════════════════════════════════════
// Repairs + saved roster column mapping.
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
                        public.notification_outbox
               RESTART IDENTITY CASCADE`);
  await query(`INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  // TRUNCATE ... CASCADE above reaches asset_categories and asset_locations
  // through their created_by FK, and the smoke suite expects the migration's
  // seed lists to be present. Restore them rather than leaving the database
  // in a state that fails whichever suite runs next.
  await query(require('fs').readFileSync(require('path').join(__dirname, 'seed-lookups.sql'), 'utf8'));

  await query(`UPDATE public.app_settings SET roster_groups_seeded_at = NULL, roster_column_map = NULL WHERE id = 1`);
  await query(`INSERT INTO public.repair_shops (name, is_internal) VALUES ('Buildings and Grounds', TRUE)
               ON CONFLICT (lower(name)) DO NOTHING`);

  await call('POST', 'auth/bootstrap', {
    bootstrap_secret: process.env.BOOTSTRAP_SECRET || 'boot', email: 'admin@test.local',
    password: 'adminpassword1', first_name: 'Ada', last_name: 'Admin',
  });
  TOKEN = (await call('POST', 'auth/login', { email: 'admin@test.local', password: 'adminpassword1' })).body?.token;
  check('signed in', !!TOKEN);

  const cat = await query(`INSERT INTO public.asset_categories (name) VALUES ('Forklifts')
                           ON CONFLICT (lower(name)) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
  const asset = await call('POST', 'assets', {
    asset_tag: 'ROCFEL05', title: 'Yellow forklift', category_id: cat.rows[0].id,
  });
  const assetId = asset.body?.asset?.id || asset.body?.id;
  check('asset created', !!assetId, asset.body);

  const loanee = await call('POST', 'loanees', { first_name: 'Sam', last_name: 'Ops' });
  const loaneeId = loanee.body?.loanee?.id || loanee.body?.id;
  check('loanee created', !!loaneeId, loanee.body);

  const shops = await call('GET', 'repair-shops');
  const bng = shops.body?.rows?.find(s => s.name === 'Buildings and Grounds');
  check('Buildings and Grounds is seeded', !!bng, shops.body);

  // ══ SENDING ══════════════════════════════════════════════════════════
  section('Sending an asset for repair');

  let r = await call('POST', 'repairs', { asset_id: assetId, shop_id: bng.id });
  check('a repair with no reported fault is refused', r.status === 400, r.body);

  r = await call('POST', 'repairs', {
    asset_id: assetId, shop_id: bng.id, reported_fault: 'Hydraulic leak, drops load',
    loanee_id: loaneeId,
  });
  check('sent for repair', r.status === 201, r.body);
  const repairId = r.body?.repair?.id;

  let a = await query(`SELECT status FROM public.assets WHERE id = $1`, [assetId]);
  check('asset is now at maintenance', a.rows[0].status === 'maintenance', a.rows[0]);

  r = await call('POST', 'repairs', {
    asset_id: assetId, shop_id: bng.id, reported_fault: 'Same thing again',
  });
  check('cannot send the same asset twice', r.status === 409, r.body);

  // The whole point: a broken asset must not go out to a volunteer.
  const co = await call('POST', 'checkout', { loanee_id: loaneeId, items: [{ asset_id: assetId }] });
  check('cannot be checked out while at repair', co.status >= 400, co.body);

  const open = await call('GET', 'repairs');
  check('appears in open repairs', open.body?.rows?.length === 1, open.body);
  check('open repair names the shop', open.body?.rows?.[0]?.shop_name === 'Buildings and Grounds', open.body?.rows?.[0]);
  check('open repair records who last held it', open.body?.rows?.[0]?.last_held_by === 'Sam Ops', open.body?.rows?.[0]);

  // ══ RECEIVING ════════════════════════════════════════════════════════
  section('Receiving it back');

  r = await call('POST', `repairs/${repairId}/return`, { outcome: 'nonsense' });
  check('an unknown outcome is refused', r.status === 400, r.body);

  r = await call('POST', `repairs/${repairId}/return`, {
    outcome: 'repaired', work_done: 'Replaced hydraulic seal', cost_cents: 18500,
  });
  check('received back', r.status === 200, r.body);

  a = await query(`SELECT status FROM public.assets WHERE id = $1`, [assetId]);
  check('asset is available again', a.rows[0].status === 'available', a.rows[0]);

  r = await call('POST', `repairs/${repairId}/return`, { outcome: 'repaired' });
  check('cannot receive the same repair twice', r.status === 409, r.body);

  const openNow = await call('GET', 'repairs');
  check('no longer in open repairs', openNow.body?.rows?.length === 0, openNow.body);

  const closed = await call('GET', 'repairs?state=closed');
  check('shows in closed repairs', closed.body?.rows?.length === 1, closed.body);
  check('cost recorded', closed.body?.rows?.[0]?.cost_cents === 18500, closed.body?.rows?.[0]);

  const ev = await query(
    `SELECT event FROM public.asset_events WHERE asset_id = $1 ORDER BY created_at`, [assetId]);
  const kinds = ev.rows.map(e => e.event);
  check('history records sent_for_repair', kinds.includes('sent_for_repair'), kinds);
  check('history records returned_from_repair', kinds.includes('returned_from_repair'), kinds);
  check('maintenance start and end are paired',
    kinds.includes('maintenance_start') && kinds.includes('maintenance_end'), kinds);

  // ══ BEYOND REPAIR ════════════════════════════════════════════════════
  section('Beyond repair retires the asset');
  r = await call('POST', 'repairs', {
    asset_id: assetId, shop_id: bng.id, reported_fault: 'Mast cracked',
  });
  const r2 = r.body?.repair?.id;
  await call('POST', `repairs/${r2}/return`, { outcome: 'beyond_repair', work_done: 'Not economic to fix' });
  a = await query(`SELECT status FROM public.assets WHERE id = $1`, [assetId]);
  check('beyond repair retires it rather than shelving it', a.rows[0].status === 'retired', a.rows[0]);

  r = await call('POST', 'repairs', { asset_id: assetId, shop_id: bng.id, reported_fault: 'again' });
  check('a retired asset cannot be sent for repair', r.status === 409, r.body);

  // ══ CHECKED OUT ══════════════════════════════════════════════════════
  section('An asset in someone\'s hands must be checked in first');
  const a2 = await call('POST', 'assets', { asset_tag: 'ROCGEN01', title: 'Generator', category_id: cat.rows[0].id });
  const a2id = a2.body?.asset?.id || a2.body?.id;
  await call('POST', 'checkout', { loanee_id: loaneeId, items: [{ asset_id: a2id }] });
  r = await call('POST', 'repairs', { asset_id: a2id, shop_id: bng.id, reported_fault: 'Wont start' });
  check('cannot send an asset that is checked out', r.status === 409, r.body);
  check('and the message says what to do', /check it in first/i.test(r.body?.error || ''), r.body);

  // ══ SHOPS ════════════════════════════════════════════════════════════
  section('Repair shops');
  r = await call('POST', 'repair-shops', { name: 'Gulf Coast Hydraulics', is_internal: false, contact: '713-555-0100' });
  check('an outside vendor can be added', r.status === 201, r.body);
  r = await call('POST', 'repair-shops', { name: 'gulf coast hydraulics' });
  check('duplicate shop names are refused case-insensitively', r.status === 409, r.body);

  // ══ MAPPING ══════════════════════════════════════════════════════════
  section('Roster column mapping');
  const FIX = require('./roster-fixture').build();

  const p1 = await call('POST', 'roster/preview', {
    filename: 'roster.xls', headers: FIX.headers, rows: FIX.rows.slice(0, 5), final: true,
  });
  check('preview reports the mapping it used', !!p1.body?.column_map, p1.body);
  check('and offers the fields to map to', (p1.body?.mappable_fields || []).length >= 8);
  check('auto-detection maps Customer Number',
    p1.body?.column_map?.['Customer Number'] === 'member_number', p1.body?.column_map);
  check('nothing is saved by previewing alone', p1.body?.saved_map === null, p1.body?.saved_map);

  await call('POST', 'roster/commit', { batch_id: p1.body.batch_id });
  let saved = await query(`SELECT roster_column_map FROM public.app_settings WHERE id = 1`);
  check('committing saves the mapping as the default',
    saved.rows[0].roster_column_map?.['Customer Number'] === 'member_number', saved.rows[0]);

  // The rodeo renames a column. Auto-detection loses it...
  const renamed = FIX.headers.map(h => h === 'Customer Number' ? 'Member ID' : h);
  const renamedRows = FIX.rows.slice(0, 5).map(r0 => {
    const o = { ...r0 }; o['Member ID'] = o['Customer Number']; delete o['Customer Number']; return o;
  });
  const R = require('../src/roster');
  check('a renamed column is not auto-detected',
    !Object.values(R.buildRosterMap(renamed).map).includes('member_number'));

  // ...so the admin maps it by hand, once.
  const p2 = await call('POST', 'roster/preview', {
    filename: 'roster2.xls', headers: renamed, rows: renamedRows, final: true,
    column_map: { 'Member ID': 'member_number' },
  });
  check('an explicit mapping is accepted',
    p2.body?.column_map?.['Member ID'] === 'member_number', p2.body?.column_map);
  const c2 = await query(
    `SELECT verdict FROM public.import_rows WHERE batch_id = $1`, [p2.body.batch_id]);
  check('and the rows resolve against it (not errors)',
    c2.rows.every(x => x.verdict !== 'error'), c2.rows.slice(0, 3));

  await call('POST', 'roster/commit', { batch_id: p2.body.batch_id });
  saved = await query(`SELECT roster_column_map FROM public.app_settings WHERE id = 1`);
  check('the corrected mapping becomes the new default',
    saved.rows[0].roster_column_map?.['Member ID'] === 'member_number', saved.rows[0]);

  // Next month's file, same new format, no manual mapping needed.
  const p3 = await call('POST', 'roster/preview', {
    filename: 'roster3.xls', headers: renamed, rows: renamedRows, final: true,
  });
  check('next import reuses the saved mapping with no work',
    p3.body?.column_map?.['Member ID'] === 'member_number', p3.body?.column_map);

  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length) { failures.forEach(f => console.log(`  \x1b[31m· ${f}\x1b[0m`)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('\n\x1b[31mFATAL\x1b[0m', e); process.exit(1); });
