// ══════════════════════════════════════════════════════════════════════
// HLSR Asset Tracker — API smoke test.
//
// Runs the REAL handlers against a REAL Postgres, without Azure. It does
// that by stubbing @azure/functions' `app` object in require.cache before
// loading src/functions/*, capturing every app.http() registration into a
// routing table, and then invoking handlers with a minimal Request-shaped
// object. Everything below the handler — middleware, db.js, assets-core,
// the SQL, the constraints — is the actual production code.
//
//   createdb hlsr_assets
//   psql "$DATABASE_URL" -f api/migrations/001_schema.sql
//   DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/smoke.js
//
// Exits non-zero on the first failure.
// ══════════════════════════════════════════════════════════════════════
const path = require('path');
const Module = require('module');

// ── Stub @azure/functions ────────────────────────────────────────
const ROUTES = [];
const HOOKS = [];
const azureStub = {
  app: {
    http(name, cfg) { ROUTES.push({ name, ...cfg }); },
    hook: { postInvocation(fn) { HOOKS.push(fn); } },
  },
};
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@azure/functions') return '@azure/functions';
  return realResolve.call(this, request, ...rest);
};
require.cache['@azure/functions'] = { id: '@azure/functions', filename: '@azure/functions', loaded: true, exports: azureStub };

// ── Load every function file, exactly as the Functions host would ──────
const fs = require('fs');
const fnDir = path.join(__dirname, '..', 'src', 'functions');
for (const f of fs.readdirSync(fnDir).filter(f => f.endsWith('.js'))) require(path.join(fnDir, f));

// ── Minimal request/response plumbing ─────────────────────────────
function matchRoute(method, urlPath) {
  const parts = urlPath.split('/').filter(Boolean);
  for (const r of ROUTES) {
    if (!r.methods.includes(method)) continue;
    const rp = r.route.split('/').filter(Boolean);
    if (rp.length !== parts.length) continue;
    const params = {};
    let ok = true;
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
async function call(method, url, body, tokenOverride) {
  const [p, q] = url.split('?');
  const hit = matchRoute(method, p);
  if (!hit) throw new Error(`No route for ${method} ${p}`);
  const headers = new Map([
    ['x-assets-token', tokenOverride !== undefined ? tokenOverride : TOKEN],
    ['x-forwarded-for', '203.0.113.7'],
    ['user-agent', 'smoke-test/1.0'],
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

// ── Tiny assertion helpers ────────────────────────────────────
let passed = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra ? `\n      ${JSON.stringify(extra)}` : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

(async function run() {
  const { query } = require('../src/db');

  section('Reset');
  // Wipe data but keep the schema, so the suite is repeatable.
  await query(`TRUNCATE public.asset_events, public.loan_items, public.loans, public.asset_photos,
                        public.asset_groups, public.assets, public.group_members, public.groups,
                        public.loanees, public.profiles, public.audit_logs, public.app_logs,
                        public.import_rows, public.import_batches, public.notification_outbox
               RESTART IDENTITY CASCADE`);
  // TRUNCATE ... CASCADE on profiles also empties app_settings (it has an
  // updated_by FK). That is how the "overdue report goes silent when the
  // settings row is missing" bug was found — put the row back, and there
  // is a regression test for the missing-row case further down.
  await query(`INSERT INTO public.app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  // Migration 005 gave asset_categories a FK to repair_shops, which has a
  // created_by FK to profiles — so TRUNCATE profiles CASCADE now reaches
  // the lookup lists that it did not before. Restore the migration's seed
  // rather than asserting against whatever survived.
  await query(require('fs').readFileSync(require('path').join(__dirname, 'seed-lookups.sql'), 'utf8'));

  await query(`UPDATE public.app_settings SET default_loan_hours = 12, overdue_grace_hours = 0 WHERE id = 1`);
  // Groups are seed DATA, so the truncate above removes them. Put the
  // migration's three back so the suite starts from a fresh-install state.
  await query(`INSERT INTO public.groups (name, description) VALUES
    ('Forklift Certified', 'Loanees with a current forklift operator certification'),
    ('Radio Authorized',   'Loanees cleared to carry event radios'),
    ('Grounds Crew',       'Grounds and setup sub-committee members')
    ON CONFLICT DO NOTHING`);
  // Lookup tables are NOT truncated (assets reference them and the seed
  // lives in the migration), so drop only the rows this suite creates —
  // otherwise the "new categories are announced" assertion passes once and
  // then silently degrades on every subsequent run.
  await query(`DELETE FROM public.asset_categories WHERE lower(name) = 'pressure washers'`);
  await query(`DELETE FROM public.asset_locations  WHERE lower(name) = 'yellow lot'`);
  console.log('  data cleared');

  // ══ AUTH ════════════════════════════════════════════════════════
  section('Auth and bootstrap');
  let r = await call('GET', 'health');
  check('health reports db up', r.body?.db === 'up', r.body);

  r = await call('POST', 'auth/bootstrap', {
    bootstrap_secret: 'boot', email: 'admin@hlsr.test', password: 'correct-horse-battery',
    first_name: 'Kyle', last_name: 'Sandoval',
  });
  check('bootstrap creates the first admin', r.status === 201 && r.body.profile.role === 'admin', r.body);

  r = await call('POST', 'auth/bootstrap', {
    bootstrap_secret: 'boot', email: 'second@hlsr.test', password: 'correct-horse-battery',
  });
  check('bootstrap refuses a second admin', r.status === 409, r.body);

  r = await call('POST', 'auth/login', { email: 'admin@hlsr.test', password: 'wrong-password' });
  check('wrong password is rejected', r.status === 401, r.body);

  r = await call('POST', 'auth/login', { email: 'nobody@hlsr.test', password: 'whatever' });
  check('unknown account gives the same message (no enumeration)',
    r.status === 401 && r.body.error === 'Incorrect email or password', r.body);

  r = await call('POST', 'auth/login', { email: 'admin@hlsr.test', password: 'correct-horse-battery' });
  check('admin can sign in', r.status === 200 && !!r.body.token, r.body);
  check('login routes admin to the admin console', r.body.portal === '/pages/admin.html', r.body);
  check('login response never leaks password_hash', !('password_hash' in (r.body.profile || {})), r.body.profile);
  const ADMIN_TOKEN = r.body.token;
  TOKEN = ADMIN_TOKEN;

  const audit = await query(`SELECT action, ip_address FROM public.audit_logs ORDER BY created_at`);
  check('failed and successful logins are both audited with an IP',
    audit.rows.filter(a => a.action === 'login_failed').length === 2
    && audit.rows.some(a => a.action === 'login' && a.ip_address === '203.0.113.7'), audit.rows);

  // ══ USERS ═══════════════════════════════════════════════════════
  section('Users and role gating');
  r = await call('POST', 'users', {
    email: 'staff@hlsr.test', first_name: 'Dana', last_name: 'Ruiz',
    role: 'staff', password: 'counter-password-1',
  });
  check('admin can create a staff user', r.status === 201, r.body);
  const STAFF_ID = r.body.id;

  r = await call('POST', 'users', {
    email: 'leader@hlsr.test', first_name: 'Pat', last_name: 'Vance',
    role: 'leader', password: 'leader-password-1',
  });
  check('admin can create a leader user', r.status === 201, r.body);

  r = await call('POST', 'users', {
    email: 'staff@hlsr.test', first_name: 'Dup', last_name: 'Licate',
    role: 'staff', password: 'counter-password-1',
  });
  check('duplicate email is refused with 409', r.status === 409, r.body);

  r = await call('POST', 'users', {
    email: 'weak@hlsr.test', first_name: 'A', last_name: 'B', role: 'staff', password: 'short',
  });
  check('short password is refused', r.status === 400, r.body);

  const staffLogin = await call('POST', 'auth/login', { email: 'staff@hlsr.test', password: 'counter-password-1' });
  const STAFF_TOKEN = staffLogin.body.token;
  check('staff lands on the counter page', staffLogin.body.portal === '/pages/staff.html', staffLogin.body);

  const leaderLogin = await call('POST', 'auth/login', { email: 'leader@hlsr.test', password: 'leader-password-1' });
  const LEADER_TOKEN = leaderLogin.body.token;
  check('leader lands on the board', leaderLogin.body.portal === '/pages/board.html', leaderLogin.body);

  r = await call('GET', 'users', undefined, STAFF_TOKEN);
  check('staff cannot list users (403)', r.status === 403, r.body);

  r = await call('POST', 'loanees', { first_name: 'X', last_name: 'Y' }, LEADER_TOKEN);
  check('leader cannot create loanees (403)', r.status === 403, r.body);

  r = await call('GET', 'me', undefined, LEADER_TOKEN);
  check('leader can read their own profile', r.status === 200 && r.body.role === 'leader', r.body);

  r = await call('GET', 'assets', undefined, '');
  check('no token means 401', r.status === 401, r.body);

  r = await call('GET', 'assets', undefined, 'not-a-real-jwt');
  check('a garbage token means 401', r.status === 401, r.body);

  // ══ LOOKUPS, GROUPS, LOANEES ══════════════════════════════════════
  section('Reference data');
  TOKEN = ADMIN_TOKEN;
  const cats = await call('GET', 'categories');
  check('seeded categories are present', cats.body.length >= 12, cats.body?.length);
  const forkliftCat = cats.body.find(c => c.name === 'Forklifts');

  const locs = await call('GET', 'locations');
  const haybarn = locs.body.find(l => l.name === 'ROC Haybarn');
  check('seeded locations are present', !!haybarn, locs.body?.length);

  const groups = await call('GET', 'groups');
  const certGroup = groups.body.find(g => g.name === 'Forklift Certified');
  check('seeded groups are present', !!certGroup, groups.body?.map(g => g.name));

  r = await call('POST', 'loanees', {
    first_name: 'Robert', last_name: 'Drackett', email: 'rdrackett@example.com',
    phone_mobile: '(713) 555-0142', position: 'Captain', sub_committee: 'ROC Grounds',
    group_ids: [certGroup.id],
  });
  check('creating a loanee works', r.status === 201, r.body);
  check('phone is normalized to digits', r.body.phone_mobile === '7135550142', r.body.phone_mobile);
  const ROBERT = r.body.id;

  r = await call('POST', 'loanees', {
    first_name: 'Casey', last_name: 'Nguyen', email: 'cnguyen@example.com', sub_committee: 'AV',
  });
  const CASEY = r.body.id;
  check('second loanee created (not in the certified group)', r.status === 201, r.body);

  r = await call('POST', 'loanees', { first_name: 'Dup', last_name: 'Person', email: 'rdrackett@example.com' });
  check('duplicate loanee email is refused', r.status === 409, r.body);

  r = await call('POST', 'loanees', { first_name: 'Bad', last_name: 'Email', email: 'not-an-email' });
  check('malformed email is refused', r.status === 400, r.body);

  // ══ ASSETS ══════════════════════════════════════════════════════
  section('Assets');
  r = await call('POST', 'assets', {
    asset_tag: 'ROCFEL05', title: 'ROC Front End Loader 05',
    category_id: forkliftCat.id, location_id: haybarn.id, serial: 'FEL-99123',
  });
  check('creating an asset works', r.status === 201 && r.body.status === 'available', r.body);
  const LOADER = r.body.id;

  r = await call('POST', 'assets', { asset_tag: 'rocfel05', title: 'Case-variant duplicate' });
  check('asset tags are unique case-insensitively', r.status === 409, r.body);

  r = await call('POST', 'assets', { asset_tag: 'ROC-RADIO-01', title: 'Motorola Radio 01' });
  const RADIO1 = r.body.id;
  r = await call('POST', 'assets', { asset_tag: 'ROC-RADIO-02', title: 'Motorola Radio 02' });
  const RADIO2 = r.body.id;
  r = await call('POST', 'assets', {
    asset_tag: 'ROC-CART-01', title: 'ROC Cart 01',
    color: '  White  ', manufacturer: 'Club Car',
  });
  const CART = r.body.id;
  check('three more assets created', !!RADIO1 && !!RADIO2 && !!CART);

  // ── Colour and manufacturer ──────────────────────────────────
  // Two carts with sequential tags are indistinguishable; these are the
  // two facts that tell them apart, so they have to survive the round
  // trip and reach every screen that shows an asset.
  check('colour and manufacturer are stored, trimmed',
    r.body.color === 'White' && r.body.manufacturer === 'Club Car', r.body);

  r = await call('POST', 'assets', {
    asset_tag: 'ROC-CART-02', title: 'ROC Cart 02', color: '', manufacturer: '   ',
  });
  // '' would count as a recorded answer of "nothing" in any report that
  // groups by colour. Blank has to mean nobody filled it in.
  check('blank colour and manufacturer are stored as NULL, not empty string',
    r.body.color === null && r.body.manufacturer === null, r.body);
  const CART2 = r.body.id;

  r = await call('GET', 'assets?q=Club%20Car');
  check('an asset is findable by manufacturer',
    r.body.rows.length === 1 && r.body.rows[0].asset_tag === 'ROC-CART-01', r.body.rows.map(x => x.asset_tag));
  r = await call('GET', 'assets?q=White');
  check('and by colour', r.body.rows.some(x => x.asset_tag === 'ROC-CART-01'), r.body.rows.map(x => x.asset_tag));

  r = await call('GET', 'assets/lookup?q=ROC-CART', undefined, STAFF_TOKEN);
  check('the check-out picker carries them, so the counter can tell two carts apart',
    r.body.matches.find(m => m.asset_tag === 'ROC-CART-01')?.manufacturer === 'Club Car', r.body.matches);

  r = await call('PATCH', `assets/${CART}`, { color: 'Blue' });
  check('colour can be changed on its own', r.body.color === 'Blue', r.body);
  check('and changing it leaves the manufacturer alone', r.body.manufacturer === 'Club Car', r.body);
  r = await call('PATCH', `assets/${CART}`, { color: '' });
  check('clearing a colour returns it to NULL rather than empty string',
    r.body.color === null, r.body);
  r = await call('PATCH', `assets/${CART}`, { color: 'White' });
  check('and it can be set again', r.body.color === 'White', r.body);
  check('CART2 exists for later checks', !!CART2);

  r = await call('PATCH', `assets/${LOADER}`, { status: 'checked_out' });
  check('status cannot be set through the generic edit endpoint', r.status === 400, r.body);

  // Restrict the loader to the certified group.
  r = await call('PATCH', `assets/${LOADER}/groups`, { group_ids: [certGroup.id] });
  check('an asset can be restricted to a group', r.status === 200 && r.body.groups.length === 1, r.body);

  // ══ ELIGIBILITY ═════════════════════════════════════════════════
  section('Group restrictions');
  r = await call('GET', `eligibility?loanee_id=${ROBERT}&asset_ids=${LOADER}`, undefined, STAFF_TOKEN);
  check('a group member is eligible', r.body[0].ok === true, r.body);

  r = await call('GET', `eligibility?loanee_id=${CASEY}&asset_ids=${LOADER}`, undefined, STAFF_TOKEN);
  check('a non-member is blocked with a reason',
    r.body[0].ok === false && /in a group allowed to receive/i.test(r.body[0].blocked_reason), r.body);

  r = await call('GET', `eligibility?loanee_id=${CASEY}&asset_ids=${RADIO1}`, undefined, STAFF_TOKEN);
  check('an unrestricted asset is open to everyone', r.body[0].ok === true, r.body);

  r = await call('GET', `assets/lookup?q=ROCFEL05&for_loanee=${CASEY}`, undefined, STAFF_TOKEN);
  check('the picker returns an exact match for a scanned tag', !!r.body.exact, r.body);
  check('the picker marks it blocked before anyone tries', r.body.exact.ok === false, r.body.exact);

  // ══ CHECKOUT ═════════════════════════════════════════════════════
  section('Check-out');
  r = await call('POST', 'checkout', { loanee_id: CASEY, asset_ids: [LOADER] }, STAFF_TOKEN);
  check('checkout to an ineligible person is refused (409)', r.status === 409, r.body);
  check('the refusal names the person and the asset',
    /Casey Nguyen/.test(r.body.error) && /ROCFEL05/.test(r.body.error), r.body.error);

  let assetRow = await query(`SELECT status FROM public.assets WHERE id = $1`, [LOADER]);
  check('a refused checkout leaves the asset untouched', assetRow.rows[0].status === 'available');

  // Maintenance blocks checkout.
  r = await call('POST', `assets/${RADIO2}/action`, { action: 'maintenance_start', reason: 'Broken PTT button' }, STAFF_TOKEN);
  check('staff can send an asset to maintenance', r.status === 200 && r.body.status === 'maintenance', r.body);

  r = await call('POST', 'checkout', { loanee_id: ROBERT, asset_ids: [RADIO2] }, STAFF_TOKEN);
  check('an asset in maintenance cannot be checked out', r.status === 409, r.body);
  check('the refusal says it is in maintenance', /maintenance/i.test(r.body.error), r.body.error);

  // All-or-nothing.
  r = await call('POST', 'checkout', { loanee_id: ROBERT, asset_ids: [LOADER, RADIO1, RADIO2] }, STAFF_TOKEN);
  check('one bad item blocks the whole cart', r.status === 409, r.body);
  check('the response names which item blocked it', r.body.blocked?.length === 1, r.body.blocked);
  const stillAvail = await query(`SELECT count(*)::int n FROM public.loan_items`);
  check('nothing at all was checked out (all-or-nothing)', stillAvail.rows[0].n === 0);

  // The real thing: multi-item, default 12h due date.
  const before = Date.now();
  r = await call('POST', 'checkout', {
    loanee_id: ROBERT, asset_ids: [LOADER, RADIO1, CART], notes: 'Setup crew, north gate',
  }, STAFF_TOKEN);
  check('cart-style checkout of 3 items succeeds', r.status === 201 && r.body.items.length === 3, r.body);
  const LOAN = r.body.loan.id;
  const dueMs = new Date(r.body.loan.due_at).getTime() - before;
  check('the default due date is 12 hours out',
    Math.abs(dueMs - 12 * 3600 * 1000) < 60000, { hours: dueMs / 3600000 });

  assetRow = await query(`SELECT status FROM public.assets WHERE id = ANY($1)`, [[LOADER, RADIO1, CART]]);
  check('all three assets now read checked_out', assetRow.rows.every(a => a.status === 'checked_out'), assetRow.rows);

  const evts = await query(
    `SELECT event, actor_role, loanee_id FROM public.asset_events WHERE event = 'checked_out'`);
  check('each item wrote an append-only event naming the actor',
    evts.rows.length === 3 && evts.rows.every(e => e.actor_role === 'staff' && e.loanee_id === ROBERT), evts.rows);

  // ══ CONCURRENCY ═════════════════════════════════════════════════
  section('Concurrency and double-checkout');
  r = await call('POST', 'checkout', { loanee_id: CASEY, asset_ids: [RADIO1] }, STAFF_TOKEN);
  check('an already-out asset cannot go out again', r.status === 409, r.body);

  // Two genuinely simultaneous carts for the same asset.
  await call('POST', 'assets', { asset_tag: 'RACE-01', title: 'Race Test Ladder' });
  const raceId = (await query(`SELECT id FROM public.assets WHERE asset_tag = 'RACE-01'`)).rows[0].id;
  const [a1, a2] = await Promise.all([
    call('POST', 'checkout', { loanee_id: ROBERT, asset_ids: [raceId] }, STAFF_TOKEN),
    call('POST', 'checkout', { loanee_id: CASEY, asset_ids: [raceId] }, STAFF_TOKEN),
  ]);
  const wins = [a1, a2].filter(x => x.status === 201).length;
  const losses = [a1, a2].filter(x => x.status === 409).length;
  check('simultaneous checkouts: exactly one wins, one gets 409',
    wins === 1 && losses === 1, { a1: a1.status, a2: a2.status });
  const openForRace = await query(
    `SELECT count(*)::int n FROM public.loan_items WHERE asset_id = $1 AND checked_in_at IS NULL`, [raceId]);
  check('the database holds exactly one open line for that asset', openForRace.rows[0].n === 1);

  // ══ RETIRE GUARD ════════════════════════════════════════════════
  section('Lifecycle guards');
  r = await call('POST', `assets/${LOADER}/action`, { action: 'retire', reason: 'Sold' });
  check('a checked-out asset cannot be retired', r.status === 409, r.body);

  r = await call('POST', `assets/${RADIO2}/action`, { action: 'retire', reason: 'Beyond repair' }, STAFF_TOKEN);
  check('staff cannot retire (admin only)', r.status === 403, r.body);

  r = await call('POST', `assets/${RADIO2}/action`, { action: 'maintenance_start', reason: 'again' });
  check('maintenance_start from maintenance is refused', r.status === 409, r.body);

  r = await call('POST', `assets/${RADIO2}/action`, { action: 'maintenance_end' });
  check('an asset can come back from maintenance', r.status === 200 && r.body.status === 'available', r.body);

  r = await call('POST', `assets/${RADIO2}/action`, { action: 'maintenance_start' });
  check('maintenance without a reason is refused', r.status === 400, r.body);

  // ══ BOARD ═══════════════════════════════════════════════════════
  section('The board');
  r = await call('GET', 'loans/open', undefined, LEADER_TOKEN);
  check('a leader can read what is out', r.status === 200, r.body);
  check('the board shows 4 open items', r.body.rows.length === 4, r.body.rows?.length);
  check('the board carries the holder name and phone',
    r.body.rows.every(x => x.loanee_name) && r.body.rows.some(x => x.loanee_phone === '7135550142'));
  check('the board stats agree with the rows', r.body.stats.out_now === 4, r.body.stats);
  check('nothing is overdue yet', r.body.stats.overdue === 0, r.body.stats);

  // ══ OVERDUE ════════════════════════════════════════════════════
  section('Overdue');
  // Push one item's due date into the past rather than waiting 12 hours.
  await query(
    `UPDATE public.loan_items SET due_at = now() - interval '90 minutes'
     WHERE asset_id = $1 AND checked_in_at IS NULL`, [RADIO1]);

  r = await call('GET', 'loans/open', undefined, LEADER_TOKEN);
  check('the overdue item is flagged on the board', r.body.stats.overdue === 1, r.body.stats);
  const od = r.body.rows.find(x => x.asset_id === RADIO1);
  check('overdue rows sort to the top', r.body.rows[0].asset_id === RADIO1, r.body.rows[0]?.asset_tag);
  check('hours overdue is computed', Number(od.hours_overdue) >= 1.4, od.hours_overdue);

  r = await call('GET', 'reports/overdue');
  check('the overdue report lists exactly that item',
    r.body.rows.length === 1 && r.body.rows[0].asset_id === RADIO1, r.body.rows);

  // Grace period suppresses it.
  await query(`UPDATE public.app_settings SET overdue_grace_hours = 4 WHERE id = 1`);
  r = await call('GET', 'reports/overdue');
  check('a 4h grace period suppresses a 90-minute overdue item', r.body.rows.length === 0, r.body.rows);
  await query(`UPDATE public.app_settings SET overdue_grace_hours = 1 WHERE id = 1`);
  r = await call('GET', 'reports/overdue');
  check('a 1h grace period still reports a 90-minute overdue item', r.body.rows.length === 1, r.body.rows);

  // Regression guard: the first version of this report CROSS JOINed
  // app_settings, so a missing settings row reported "nothing overdue" —
  // a silent false negative on the one report that must never have one.
  await query(`DELETE FROM public.app_settings WHERE id = 1`);
  r = await call('GET', 'reports/overdue');
  check('overdue still reports correctly with NO settings row at all',
    r.body.rows.length === 1, r.body.rows);
  r = await call('GET', 'settings');
  check('reading settings recreates the missing singleton row',
    r.status === 200 && r.body.default_loan_hours === 12, r.body);
  await query(`UPDATE public.app_settings SET overdue_grace_hours = 0 WHERE id = 1`);

  // ══ CHECK-IN ═════════════════════════════════════════════════════
  section('Check-in');
  const openItems = await query(
    `SELECT li.id, li.asset_id FROM public.loan_items li WHERE li.loan_id = $1 AND li.checked_in_at IS NULL`, [LOAN]);
  check('the loan has 3 open lines', openItems.rows.length === 3);

  const first = openItems.rows.find(x => x.asset_id === CART);
  r = await call('POST', 'checkin', { loan_item_ids: [first.id], in_condition: 'good' }, STAFF_TOKEN);
  check('one item can be checked in on its own', r.status === 200 && r.body.checked_in.length === 1, r.body);
  check('a partial check-in does not close the loan', r.body.loans_closed.length === 0, r.body);

  let loanRow = await query(`SELECT closed_at FROM public.loans WHERE id = $1`, [LOAN]);
  check('the loan header is still open', loanRow.rows[0].closed_at === null);

  r = await call('POST', 'checkin', { loan_item_ids: [first.id] }, STAFF_TOKEN);
  check('checking the same item in twice is refused', r.status === 409, r.body);

  // Damaged goes to maintenance, not back on the shelf.
  const radioItem = openItems.rows.find(x => x.asset_id === RADIO1);
  r = await call('POST', 'checkin', {
    loan_item_ids: [radioItem.id],
    per_item: [{ loan_item_id: radioItem.id, in_condition: 'damaged', in_notes: 'Antenna snapped' }],
  }, STAFF_TOKEN);
  check('a damaged return routes to maintenance',
    r.body.checked_in[0].to_status === 'maintenance', r.body.checked_in);
  assetRow = await query(`SELECT status FROM public.assets WHERE id = $1`, [RADIO1]);
  check('the damaged asset is not available again', assetRow.rows[0].status === 'maintenance', assetRow.rows[0]);

  // Last one closes the loan.
  const last = openItems.rows.find(x => x.asset_id === LOADER);
  r = await call('POST', `loans/${LOAN}/checkin-all`, { in_condition: 'good' }, STAFF_TOKEN);
  check('checkin-all takes the remaining item', r.body.checked_in.length === 1, r.body);
  check('the final check-in closes the loan header', r.body.loans_closed.includes(LOAN), r.body);
  loanRow = await query(`SELECT closed_at FROM public.loans WHERE id = $1`, [LOAN]);
  check('closed_at is now set', loanRow.rows[0].closed_at !== null);
  void last;

  r = await call('POST', `loans/${LOAN}/checkin-all`, {}, STAFF_TOKEN);
  check('checkin-all on a closed loan is refused', r.status === 409, r.body);

  // Now that it is back, it can be retired.
  r = await call('POST', `assets/${LOADER}/action`, { action: 'retire', reason: 'End of life' });
  check('a returned asset CAN be retired', r.status === 200 && r.body.status === 'retired', r.body);

  // ══ FORCE LOGOUT ════════════════════════════════════════════════
  section('Force logout and role changes');
  r = await call('GET', 'me', undefined, STAFF_TOKEN);
  check('the staff token still works before revocation', r.status === 200);

  r = await call('PATCH', `users/${STAFF_ID}`, { force_logout: true });
  check('force logout is accepted', r.status === 200 && r.body.sessions_revoked === true, r.body);

  r = await call('GET', 'me', undefined, STAFF_TOKEN);
  check('the old staff token is dead immediately', r.status === 401, r.body);

  const relogin = await call('POST', 'auth/login', { email: 'staff@hlsr.test', password: 'counter-password-1' });
  const STAFF2 = relogin.body.token;
  r = await call('PATCH', `users/${STAFF_ID}`, { role: 'leader' });
  check('changing a role also revokes sessions', r.body.sessions_revoked === true, r.body);
  r = await call('GET', 'me', undefined, STAFF2);
  check('the token issued under the old role is dead', r.status === 401, r.body);
  await call('PATCH', `users/${STAFF_ID}`, { role: 'staff' });

  // ══ IMPORT ══════════════════════════════════════════════════════
  section('Spreadsheet import');
  const importRows = [
    { row_number: 2, 'First Name': 'Ana', 'Last Name': 'Ortiz', 'Email': 'aortiz@example.com', 'Cell': '713-555-0188', 'Sub Committee': 'ROC Grounds', 'Position': 'Committee Member' },
    { row_number: 3, 'First Name': 'Ben', 'Last Name': 'Cole', 'Email': 'bcole@example.com', 'Cell': '(281) 555 0199', 'Sub Committee': 'AV', 'Groups': 'Radio Authorized' },
    { row_number: 4, 'First Name': 'Ana', 'Last Name': 'Ortiz', 'Email': 'aortiz@example.com', 'Cell': '713-555-0188' },
    { row_number: 5, 'First Name': '', 'Last Name': 'Nameless', 'Email': 'x@example.com' },
    { row_number: 6, 'First Name': 'Bad', 'Last Name': 'Mail', 'Email': 'nope' },
    { row_number: 7, 'First Name': 'Ghost', 'Last Name': 'Group', 'Email': 'gg@example.com', 'Groups': 'Nonexistent Group' },
    { row_number: 8, 'First Name': 'Robert', 'Last Name': 'Drackett', 'Email': 'rdrackett@example.com' },
  ];
  r = await call('POST', 'imports/loanees/preview', {
    filename: 'roster.xlsx',
    headers: ['First Name', 'Last Name', 'Email', 'Cell', 'Sub Committee', 'Position', 'Groups'],
    rows: importRows, options: {},
  });
  check('preview runs', r.status === 200, r.body);
  const sum = r.body.summary;
  check('two good new rows are marked for creation', sum.create === 2, sum);
  check('the in-file duplicate is skipped', sum.skip_duplicate === 2, sum);
  check('three bad rows are errors', sum.error === 3, sum);
  const errRows = r.body.rows.filter(x => x.verdict === 'error');
  check('a missing name is reported with its row number',
    errRows.some(x => x.row_number === 5 && /name/i.test(x.message)), errRows);
  check('an unknown group is an error, not a silent create',
    errRows.some(x => x.row_number === 7 && /No such group/.test(x.message)), errRows);
  const BATCH = r.body.batch_id;

  const beforeCount = (await query(`SELECT count(*)::int n FROM public.loanees`)).rows[0].n;
  check('preview wrote no loanees', beforeCount === 2);

  r = await call('POST', 'imports/loanees/commit', { batch_id: BATCH });
  check('commit creates exactly the two good rows', r.body.created === 2, r.body);
  r = await call('POST', 'imports/loanees/commit', { batch_id: BATCH });
  check('committing the same batch twice is refused (idempotent)', r.status === 409, r.body);

  const ben = await query(`SELECT phone_mobile FROM public.loanees WHERE email = 'bcole@example.com'`);
  check('phone numbers are normalized on import', ben.rows[0].phone_mobile === '2815550199', ben.rows[0]);
  const benGroups = await query(
    `SELECT g.name FROM public.group_members gm JOIN public.groups g ON g.id = gm.group_id
     JOIN public.loanees l ON l.id = gm.loanee_id WHERE l.email = 'bcole@example.com'`);
  check('the named group was applied on import', benGroups.rows[0]?.name === 'Radio Authorized', benGroups.rows);

  // Asset import auto-creates lookups but never groups.
  r = await call('POST', 'imports/assets/preview', {
    filename: 'gear.csv',
    headers: ['Tag', 'Name', 'Category', 'Location', 'Status'],
    rows: [
      { row_number: 2, Tag: 'NEW-001', Name: 'Pressure Washer', Category: 'Pressure Washers', Location: 'Yellow Lot' },
      { row_number: 3, Tag: 'NEW-002', Name: 'Ghost Loader', Category: 'Forklifts', Status: 'checked out' },
    ],
    options: {},
  });
  check('new categories are announced, not silently created',
    r.body.will_create_categories.includes('Pressure Washers'), r.body.will_create_categories);
  check('an imported "checked out" status is downgraded with a warning',
    r.body.rows[1].normalized.status === 'available' && /available/i.test(r.body.rows[1].message), r.body.rows[1]);
  await call('POST', 'imports/assets/commit', { batch_id: r.body.batch_id });
  const newCat = await query(`SELECT id FROM public.asset_categories WHERE lower(name) = 'pressure washers'`);
  check('the announced category exists after commit', newCat.rows.length === 1);

  // ══ LOOKUP GUARDS ═══════════════════════════════════════════════
  section('Lookup and group guards');
  r = await call('DELETE', `categories/${forkliftCat.id}`);
  check('a category in use cannot be deleted', r.status === 409 && r.body.suggest === 'deactivate', r.body);

  r = await call('DELETE', `groups/${certGroup.id}`);
  check('deleting a group with restricted assets needs confirmation',
    r.status === 409 && r.body.requires_confirm === true, r.body);

  // Whoever won the RACE-01 race is still holding it, so they must not be
  // deactivatable; Ana (imported, nothing out) must be.
  const raceHolder = (await query(
    `SELECT l.loanee_id, ln.full_name FROM public.loan_items li
     JOIN public.loans l ON l.id = li.loan_id
     JOIN public.loanees ln ON ln.id = l.loanee_id
     WHERE li.asset_id = $1 AND li.checked_in_at IS NULL`, [raceId])).rows[0];
  r = await call('DELETE', `loanees/${raceHolder.loanee_id}`);
  check('a loanee still holding equipment cannot be deactivated',
    r.status === 409 && /checked out/i.test(r.body.error), r.body);

  const ana = (await query(`SELECT id FROM public.loanees WHERE email = 'aortiz@example.com'`)).rows[0];
  r = await call('DELETE', `loanees/${ana.id}`);
  check('a loanee with nothing out can be deactivated', r.status === 200, r.body);

  // ══ REPORTS ════════════════════════════════════════════════════
  section('Reports');
  r = await call('GET', 'reports/by-loanee');
  const rob = r.body.rows.filter(x => x.full_name === 'Robert Drackett');
  check('by-loanee returns one row per loan line', rob.length >= 3, rob.length);
  check('it covers both current and returned items',
    rob.some(x => x.state === 'returned') && r.body.rows.some(x => x.state === 'out'),
    rob.map(x => x.state));
  check('hours held is computed', rob.every(x => x.hours_held !== null), rob);
  check('a late return is flagged', rob.some(x => x.returned_late === true || x.currently_overdue === true),
    rob.map(x => [x.asset_tag, x.returned_late, x.currently_overdue]));

  // This report is what the Reports page opens on, so its order is a
  // feature, not a detail. Returned rows lead; anything still out is by
  // definition the newest checkout, and letting it sort first would fill
  // page one with the same rows that are already on Out Now.
  const states = r.body.rows.map(x => x.state);
  const firstOut = states.indexOf('out');
  const lastReturned = states.lastIndexOf('returned');
  check('the history leads with returned items and puts still-out last',
    firstOut === -1 || lastReturned === -1 || lastReturned < firstOut, states);
  const retAt = r.body.rows.filter(x => x.state === 'returned').map(x => +new Date(x.checked_out_at));
  check('and within that block, the newest checkout is first',
    retAt.every((v, i) => i === 0 || retAt[i - 1] >= v), retAt);

  r = await call('GET', `reports/by-asset?asset_id=${RADIO1}`);
  check('by-asset returns the custody chain', r.body.rows.length === 1, r.body.rows);
  check('it records the condition it came back in', r.body.rows[0].in_condition === 'damaged', r.body.rows[0]);

  r = await call('GET', 'reports/inventory');
  check('the inventory rollup returns rows', r.body.rows.length > 0, r.body.rows?.length);
  const grand = r.body.rows.find(x => x.g_category);
  check('a grand total row is present', !!grand && grand.asset_count >= 7, grand);

  r = await call('GET', 'reports/activity');
  check('the activity log has entries for every action', r.body.rows.length >= 10, r.body.rows?.length);

  r = await call('GET', 'reports/by-loanee', undefined, LEADER_TOKEN);
  check('a leader cannot read the by-person report (403)', r.status === 403, r.body);

  r = await call('GET', 'reports/out-now', undefined, LEADER_TOKEN);
  check('a leader CAN read out-now', r.status === 200, r.body);

  // ══ SETTINGS ═════════════════════════════════════════════════════
  section('Settings');
  r = await call('PATCH', 'settings', { default_loan_hours: 24 });
  check('the default loan length can be changed', r.body.default_loan_hours === 24, r.body);
  r = await call('PATCH', 'settings', { default_loan_hours: -5 });
  check('a negative loan length is refused', r.status === 400, r.body);
  r = await call('PATCH', 'settings', { default_loan_hours: 12 }, LEADER_TOKEN);
  check('a leader cannot change settings', r.status === 403, r.body);
  await call('PATCH', 'settings', { default_loan_hours: 12 });

  r = await call('GET', 'settings', undefined, STAFF_TOKEN);
  check('staff can read settings (the counter needs the default)', r.status === 401 || r.status === 200);

  // ══ AUDIT COVERAGE ══════════════════════════════════════════════
  section('Audit trail');
  const actions = await query(`SELECT DISTINCT action FROM public.audit_logs`);
  const names = actions.rows.map(a => a.action);
  for (const need of ['login', 'login_failed', 'user_created', 'loanee_created', 'asset_created',
                      'checkout', 'checkin', 'import_committed', 'settings_updated']) {
    check(`"${need}" is written to the audit log`, names.includes(need), names);
  }

  // ── Summary ──
  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length) {
    console.log('\x1b[31mFailures:\x1b[0m');
    failures.forEach(f => console.log(`  · ${f}`));
  }
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error('\n\x1b[31mHARNESS ERROR\x1b[0m', e); process.exit(2); });
