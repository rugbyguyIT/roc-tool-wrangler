// ════════════════════════════════════════════════════════════
// One of each kind — Kyle's rule, stated in his own words:
//
//   "A member could check out a cart, radio, drill and fuel key all at
//    once but not two radios, two drills, two keys or two trucks."
//
// That is member_limit_per_category = TRUE with member_item_limit = 1.
// This suite exists because that sentence is the specification, and a
// setting nobody has watched behave is a setting nobody should trust.
//
//   DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/percat.js
//
// Run it after smoke.js — it reuses that admin.
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

let TOKEN = '';
async function call(method, url, body) {
  const [p, q] = url.split('?');
  const hit = matchRoute(method, p);
  if (!hit) throw new Error(`No route for ${method} ${p}`);
  const headers = new Map([
    ['x-assets-token', TOKEN],
    ['x-forwarded-for', '203.0.113.9'],
    ['user-agent', 'percat-test/1.0'],
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

async function category(name) {
  const r = await query(
    `INSERT INTO public.asset_categories (name) VALUES ($1)
     ON CONFLICT (lower(name)) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name]);
  return r.rows[0].id;
}
// These two RESET rather than delete-and-recreate.
//
// A plain `DELETE FROM assets WHERE asset_tag = $1` works the first time and
// then fails on every run afterwards with a foreign key violation, because
// this suite deliberately leaves items checked out and `loan_items` still
// points at them. That surfaced as a Postgres stack trace instead of a test
// result — the least useful possible failure. Resetting an existing fixture
// means the suite says what it found however many times it is run.
async function asset(tag, title, categoryId) {
  const ex = await query(`SELECT id FROM public.assets WHERE lower(asset_tag) = lower($1)`, [tag]);
  if (ex.rows.length) {
    const id = ex.rows[0].id;
    await query(`DELETE FROM public.loan_items  WHERE asset_id = $1`, [id]);
    await query(`DELETE FROM public.asset_events WHERE asset_id = $1`, [id]);
    await query(
      `UPDATE public.assets SET status = 'available', title = $2, category_id = $3 WHERE id = $1`,
      [id, title, categoryId]);
    return id;
  }
  const r = await query(
    `INSERT INTO public.assets (asset_tag, title, category_id) VALUES ($1,$2,$3) RETURNING id`,
    [tag, title, categoryId]);
  return r.rows[0].id;
}

async function member(email, first, last, title) {
  const ex = await query(`SELECT id FROM public.loanees WHERE lower(email) = lower($1)`, [email]);
  if (ex.rows.length) {
    const id = ex.rows[0].id;
    await query(
      `DELETE FROM public.loan_items WHERE loan_id IN (SELECT id FROM public.loans WHERE loanee_id = $1)`, [id]);
    await query(`DELETE FROM public.asset_events WHERE loanee_id = $1`, [id]);
    await query(`DELETE FROM public.loans WHERE loanee_id = $1`, [id]);
    await query(
      `UPDATE public.loanees SET first_name = $2, last_name = $3, full_name = $4,
              title = $5, status = 'active' WHERE id = $1`,
      [id, first, last, `${first} ${last}`, title]);
    return id;
  }
  const r = await query(
    `INSERT INTO public.loanees (first_name, last_name, full_name, email, title)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [first, last, `${first} ${last}`, email, title]);
  return r.rows[0].id;
}

// Anything this suite left checked out on a previous run has to go back on
// the shelf before the assertions start, or "the first item goes out" fails
// against yesterday's state.
async function resetFixtures() {
  await query(
    `DELETE FROM public.loan_items li
     USING public.assets a
     WHERE a.id = li.asset_id AND a.asset_tag LIKE 'PC-%'`);
  await query(`UPDATE public.assets SET status = 'available' WHERE asset_tag LIKE 'PC-%'`);
}

(async function run() {
  let r = await call('POST', 'auth/login', { email: 'admin@hlsr.test', password: 'correct-horse-battery' });
  if (r.status !== 200) {
    console.error('\x1b[31mRun api/test/smoke.js first — this suite reuses its admin.\x1b[0m');
    process.exit(2);
  }
  TOKEN = r.body.token;
  await resetFixtures();

  // The rule, set the way the Settings screen sets it.
  r = await call('PATCH', 'settings', {
    member_limit_enabled: true, member_title: 'Committee Member',
    member_item_limit: 1, member_limit_per_category: true });
  check('the rule is on, one per category', r.status === 200
    && r.body.member_limit_per_category === true && r.body.member_item_limit === 1, r.body);

  const CARTS   = await category('Carts');
  const RADIOS  = await category('Radios');
  const DRILLS  = await category('Power Tools');
  const KEYS    = await category('Fuel Keys');
  const TRUCKS  = await category('Trucks');

  const CART   = await asset('PC-CART-1',  'Cart 01',        CARTS);
  const RADIO  = await asset('PC-RADIO-1', 'Radio 01',       RADIOS);
  const DRILL  = await asset('PC-DRILL-1', 'Drill 01',       DRILLS);
  const KEY    = await asset('PC-KEY-1',   'Fuel Key 01',    KEYS);
  const CART2  = await asset('PC-CART-2',  'Cart 02',        CARTS);
  const RADIO2 = await asset('PC-RADIO-2', 'Radio 02',       RADIOS);
  const DRILL2 = await asset('PC-DRILL-2', 'Drill 02',       DRILLS);
  const KEY2   = await asset('PC-KEY-2',   'Fuel Key 02',    KEYS);
  const TRUCK  = await asset('PC-TRUCK-1', 'Truck 01',       TRUCKS);
  const TRUCK2 = await asset('PC-TRUCK-2', 'Truck 02',       TRUCKS);

  // ══ "a cart, radio, drill and fuel key all at once" ═══════════════
  section('One of each kind, all at once');
  const BOB = await member('percat.bob@example.com', 'Bob', 'Fourkinds', 'Committee Member');

  r = await call('POST', 'checkout', { loanee_id: BOB, asset_ids: [CART, RADIO, DRILL, KEY] });
  check('a cart, a radio, a drill and a fuel key go out in ONE cart',
    r.status === 201, r.body);
  check('all four actually went out', (r.body.items || []).length === 4, r.body.items?.length);

  r = await call('POST', 'checkout', { loanee_id: BOB, asset_ids: [TRUCK] });
  check('and a truck on top of those, because it is a fifth kind',
    r.status === 201, r.body);

  // ══ "but not two radios, two drills, two keys or two trucks" ══════
  section('But never two of the same kind');
  // The category NAME must appear verbatim, because that is what is on the
  // asset card and in the picker behind the dialog. And the sentence must
  // read like English — "1 carts" and "2 cartss" both shipped once.
  for (const [label, cat, id] of [['radios', 'Radios', RADIO2],
                                  ['drills', 'Power Tools', DRILL2],
                                  ['fuel keys', 'Fuel Keys', KEY2],
                                  ['trucks', 'Trucks', TRUCK2],
                                  ['carts', 'Carts', CART2]]) {
    r = await call('POST', 'checkout', { loanee_id: BOB, asset_ids: [id] });
    check(`two ${label} is refused`, r.status === 409, r.body);
    check(`  and the refusal names ${cat} exactly as the screen does`,
      (r.body.error || '').includes(cat), r.body.error);
    check(`  and reads as English, not "1 ${cat.toLowerCase()}"`,
      !new RegExp(`\\d ${cat}\\b`, 'i').test(r.body.error || '')
      && !/s{2,}\b/.test(r.body.error || ''), r.body.error);
  }

  // Nothing leaked while all that was being refused.
  const held = await query(
    `SELECT count(*)::int n FROM public.loan_items li JOIN public.loans l ON l.id = li.loan_id
     WHERE l.loanee_id = $1 AND li.checked_in_at IS NULL`, [BOB]);
  check('after five refusals he still holds exactly the five he started with',
    held.rows[0].n === 5, held.rows[0]);

  // ══ Two of a kind in ONE cart, before anything moves ═════════════
  section('Two of a kind inside a single cart');
  const AMY = await member('percat.amy@example.com', 'Amy', 'Onecart', 'Committee Member');
  r = await call('POST', 'checkout', { loanee_id: AMY, asset_ids: [RADIO2, DRILL2] });
  check('one radio and one drill together is fine', r.status === 201, r.body);

  const CID = await member('percat.cid@example.com', 'Cid', 'Twocarts', 'Committee Member');
  r = await call('POST', 'checkout', { loanee_id: CID, asset_ids: [CART2, TRUCK2] });
  check('a cart and a truck together is fine', r.status === 201, r.body);

  const DEE = await member('percat.dee@example.com', 'Dee', 'Doubled', 'Committee Member');
  const CART3 = await asset('PC-CART-3', 'Cart 03', CARTS);
  const CART4 = await asset('PC-CART-4', 'Cart 04', CARTS);
  r = await call('POST', 'checkout', { loanee_id: DEE, asset_ids: [CART3, CART4] });
  check('but TWO carts in one cart is refused', r.status === 409, r.body);
  const deeOut = await query(
    `SELECT count(*)::int n FROM public.loan_items li JOIN public.loans l ON l.id = li.loan_id
     WHERE l.loanee_id = $1 AND li.checked_in_at IS NULL`, [DEE]);
  check('and NOTHING went out — all-or-nothing still holds', deeOut.rows[0].n === 0, deeOut.rows[0]);

  // ══ The counter screen ════════════════════════════════════
  section('What the counter sees before anyone clicks');
  r = await call('GET', `loanees/${BOB}/limit`);
  check('the rule applies to him', r.body.applies === true, r.body);
  check('and reads as per-category', r.body.per_category === true, r.body);
  check('with a count per kind, not one number',
    r.body.by_category && Object.keys(r.body.by_category).length === 5, r.body.by_category);
  check('"how many more" is deliberately null — there is no single answer',
    r.body.remaining === null, r.body.remaining);
  check('and he reads as at-limit, because some kind is full',
    r.body.at_limit === true, r.body);

  const FRESH = await member('percat.fresh@example.com', 'Fran', 'Empty', 'Committee Member');
  r = await call('GET', `loanees/${FRESH}/limit`);
  check('someone holding nothing is not at their limit', r.body.at_limit === false, r.body);

  // ══ Uncategorised assets are ONE kind ══════════════════════════
  // Worth knowing before the import: anything without a category shares
  // a single "(uncategorized)" bucket, so two of them collide even when
  // they are a drill and a fuel key.
  section('Assets with no category all count as one kind');
  const NOCAT1 = await asset('PC-NOCAT-1', 'Something', null);
  const NOCAT2 = await asset('PC-NOCAT-2', 'Something Else', null);
  const GUS = await member('percat.gus@example.com', 'Gus', 'Nocat', 'Committee Member');
  r = await call('POST', 'checkout', { loanee_id: GUS, asset_ids: [NOCAT1] });
  check('the first uncategorised item goes out', r.status === 201, r.body);
  r = await call('POST', 'checkout', { loanee_id: GUS, asset_ids: [NOCAT2] });
  check('a SECOND uncategorised item is refused, even though it is a different thing',
    r.status === 409, r.body);
  check('  which is why every asset needs a category before the import',
    /uncategorized/i.test(r.body.error || ''), r.body.error);

  // ══ Officers are still unlimited ══════════════════════════════
  section('Any other title is still unlimited');
  const CHAIR = await member('percat.chair@example.com', 'Cora', 'Chair', 'Chairman');
  const CART5 = await asset('PC-CART-5', 'Cart 05', CARTS);
  const CART6 = await asset('PC-CART-6', 'Cart 06', CARTS);
  r = await call('POST', 'checkout', { loanee_id: CHAIR, asset_ids: [CART5, CART6] });
  check('a Chairman takes two carts at once', r.status === 201, r.body);

  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length) {
    console.log('\x1b[31mFailures:\x1b[0m');
    failures.forEach(f => console.log(`  · ${f}`));
  }
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error('\n\x1b[31mHARNESS ERROR\x1b[0m', e); process.exit(2); });
