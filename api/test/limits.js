// ════════════════════════════════════════════════════════════
// HLSR Asset Tracker — how much one ordinary member may hold.
//
// The rule is enforced inside performCheckout's transaction, not in the
// browser, so this drives the real handler the way smoke.js does.
//
//   DATABASE_URL=... JWT_SECRET=test BOOTSTRAP_SECRET=boot node api/test/limits.js
//
// Run it after smoke.js: it reuses that admin account rather than
// bootstrapping a second one.
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
async function call(method, url, body, tokenOverride) {
  const [p, q] = url.split('?');
  const hit = matchRoute(method, p);
  if (!hit) throw new Error(`No route for ${method} ${p}`);
  const headers = new Map([
    ['x-assets-token', tokenOverride !== undefined ? tokenOverride : TOKEN],
    ['x-forwarded-for', '203.0.113.9'],
    ['user-agent', 'limits-test/1.0'],
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

// Settings are the rule, so each block states the ones it depends on
// rather than inheriting whatever the previous block left behind.
async function setRule({ enabled = true, title = 'Committee Member', limit = 1, perCategory = false }) {
  await query(
    `UPDATE public.app_settings SET member_limit_enabled = $1, member_title = $2,
            member_item_limit = $3, member_limit_per_category = $4 WHERE id = 1`,
    [enabled, title, limit, perCategory]);
}

async function freshAsset(tag, title, categoryId) {
  await query(`DELETE FROM public.assets WHERE asset_tag = $1`, [tag]);
  const r = await query(
    `INSERT INTO public.assets (asset_tag, title, category_id) VALUES ($1,$2,$3) RETURNING id`,
    [tag, title, categoryId || null]);
  return r.rows[0].id;
}

async function freshLoanee(email, first, last, title) {
  await query(`DELETE FROM public.loanees WHERE email = $1`, [email]);
  const r = await query(
    `INSERT INTO public.loanees (first_name, last_name, full_name, email, title)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [first, last, `${first} ${last}`, email, title]);
  return r.rows[0].id;
}

(async function run() {
  section('Sign in');
  let r = await call('POST', 'auth/login', { email: 'admin@hlsr.test', password: 'correct-horse-battery' });
  if (r.status !== 200) {
    console.error('\x1b[31mRun api/test/smoke.js first — this suite reuses its admin.\x1b[0m');
    process.exit(2);
  }
  TOKEN = r.body.token;
  check('admin signed in', !!TOKEN);

  const cats = await call('GET', 'categories');
  const carts = cats.body.find(c => /cart/i.test(c.name)) || cats.body[0];
  const radios = cats.body.find(c => /radio/i.test(c.name) && c.id !== carts.id)
    || cats.body.find(c => c.id !== carts.id);
  check('two distinct categories to test with', carts && radios && carts.id !== radios.id,
    { carts: carts?.name, radios: radios?.name });

  // ══ ORDINARY MEMBER, LIMIT 1, ACROSS EVERYTHING ═══════════════
  section('An ordinary member, one item at a time');
  await setRule({ limit: 1, perCategory: false });

  const BOB = await freshLoanee('bob.limit@example.com', 'Bob', 'Limit', 'Committee Member');
  const CART_A = await freshAsset('LIM-CART-A', 'Limit Test Cart A', carts.id);
  const CART_B = await freshAsset('LIM-CART-B', 'Limit Test Cart B', carts.id);
  const RADIO_A = await freshAsset('LIM-RADIO-A', 'Limit Test Radio A', radios.id);

  r = await call('GET', `loanees/${BOB}/limit`);
  check('the limit is visible before anything is handed over',
    r.body.applies === true && r.body.limit === 1 && r.body.at_limit === false, r.body);

  r = await call('POST', 'checkout', { loanee_id: BOB, asset_ids: [CART_A] });
  check('the first item goes out', r.status === 201, r.body);

  r = await call('GET', `loanees/${BOB}/limit`);
  check('and now they read as at their limit', r.body.at_limit === true, r.body);
  check('with what they hold listed for the counter',
    r.body.holding.length === 1 && r.body.holding[0].asset_tag === 'LIM-CART-A', r.body.holding);

  r = await call('POST', 'checkout', { loanee_id: BOB, asset_ids: [CART_B] });
  check('a second item is refused', r.status === 409, r.body);
  check('the refusal names the person', /Bob Limit/.test(r.body.error || ''), r.body.error);
  check('and says how many they may hold', /1 item at a time/.test(r.body.error || ''), r.body.error);
  check('and carries what they already have, so the screen can show it',
    r.body.member_limit?.holding?.[0]?.asset_tag === 'LIM-CART-A', r.body.member_limit);

  // A different KIND of thing is still refused when the limit is overall.
  r = await call('POST', 'checkout', { loanee_id: BOB, asset_ids: [RADIO_A] });
  check('a different kind of item is refused too when the limit is overall',
    r.status === 409, r.body);

  // Nothing leaked out while it was being refused.
  const outNow = await query(
    `SELECT count(*)::int n FROM public.loan_items li JOIN public.loans l ON l.id = li.loan_id
     WHERE l.loanee_id = $1 AND li.checked_in_at IS NULL`, [BOB]);
  check('a refused checkout leaves exactly one item out', outNow.rows[0].n === 1, outNow.rows[0]);

  // A cart that is over the limit on its own is refused before anything moves.
  const CART_C = await freshAsset('LIM-CART-C', 'Limit Test Cart C', carts.id);
  const ZOE = await freshLoanee('zoe.limit@example.com', 'Zoe', 'Limit', 'Committee Member');
  r = await call('POST', 'checkout', { loanee_id: ZOE, asset_ids: [CART_C, RADIO_A] });
  check('two items in one cart is refused for a one-item member', r.status === 409, r.body);
  const zoeOut = await query(
    `SELECT count(*)::int n FROM public.loan_items li JOIN public.loans l ON l.id = li.loan_id
     WHERE l.loanee_id = $1 AND li.checked_in_at IS NULL`, [ZOE]);
  check('and nothing at all went out (all-or-nothing still holds)', zoeOut.rows[0].n === 0, zoeOut.rows[0]);

  // ══ ANY OTHER TITLE IS UNLIMITED ══════════════════════════
  section('Any other title is unlimited');
  const CHAIR = await freshLoanee('chair.limit@example.com', 'Cora', 'Chair', 'Chairman');
  r = await call('GET', `loanees/${CHAIR}/limit`);
  check('no limit applies to a Chairman', r.body.applies === false, r.body);

  r = await call('POST', 'checkout', { loanee_id: CHAIR, asset_ids: [CART_B] });
  check('a Chairman takes the first', r.status === 201, r.body);
  r = await call('POST', 'checkout', { loanee_id: CHAIR, asset_ids: [RADIO_A] });
  check('and a second, of a different kind', r.status === 201, r.body);
  const chairOut = await query(
    `SELECT count(*)::int n FROM public.loan_items li JOIN public.loans l ON l.id = li.loan_id
     WHERE l.loanee_id = $1 AND li.checked_in_at IS NULL`, [CHAIR]);
  check('a Chairman holds both at once', chairOut.rows[0].n === 2, chairOut.rows[0]);

  // The match ignores case and stray spaces, because rosters are typed by
  // hand and " committee member " must not buy an exemption.
  const SLOPPY = await freshLoanee('sloppy.limit@example.com', 'Sam', 'Sloppy', '  committee MEMBER ');
  r = await call('GET', `loanees/${SLOPPY}/limit`);
  check('a sloppily typed title still counts as an ordinary member',
    r.body.applies === true, r.body);

  // ══ ONE OF EACH KIND ════════════════════════════════════
  section('Counting per category instead');
  await setRule({ limit: 1, perCategory: true });
  const PAT = await freshLoanee('pat.limit@example.com', 'Pat', 'Percat', 'Committee Member');
  const CART_D = await freshAsset('LIM-CART-D', 'Limit Test Cart D', carts.id);
  const CART_E = await freshAsset('LIM-CART-E', 'Limit Test Cart E', carts.id);
  const RADIO_B = await freshAsset('LIM-RADIO-B', 'Limit Test Radio B', radios.id);

  r = await call('POST', 'checkout', { loanee_id: PAT, asset_ids: [CART_D] });
  check('one cart goes out', r.status === 201, r.body);
  r = await call('POST', 'checkout', { loanee_id: PAT, asset_ids: [RADIO_B] });
  check('and a radio as well, because it is a different kind', r.status === 201, r.body);
  r = await call('POST', 'checkout', { loanee_id: PAT, asset_ids: [CART_E] });
  check('but a SECOND cart is refused', r.status === 409, r.body);
  check('and the refusal names the kind, not just "item"',
    /cart/i.test(r.body.error || ''), r.body.error);

  // ══ THE OFF SWITCH ══════════════════════════════════════
  section('Turning the rule off');
  await setRule({ enabled: false });
  r = await call('GET', `loanees/${BOB}/limit`);
  check('no limit applies to anyone when it is off', r.body.applies === false, r.body);
  r = await call('POST', 'checkout', { loanee_id: BOB, asset_ids: [CART_E] });
  check('and the member who was blocked can now take a second', r.status === 201, r.body);

  // ══ SETTINGS GUARDS ═════════════════════════════════════
  section('Settings validation');
  await setRule({ enabled: true, limit: 1, perCategory: false });
  r = await call('PATCH', 'settings', { member_item_limit: 0 });
  check('a limit of zero is refused — that is what the toggle is for', r.status === 400, r.body);
  r = await call('PATCH', 'settings', { member_item_limit: 3 });
  check('a sensible limit is accepted', r.status === 200 && r.body.member_item_limit === 3, r.body);
  r = await call('PATCH', 'settings', { member_title: '   ' });
  check('a blank title is refused — it decides who the rule applies to', r.status === 400, r.body);
  r = await call('GET', 'settings');
  check('pilot_mode is gone from the settings payload',
    !('pilot_mode' in (r.body || {})), Object.keys(r.body || {}));

  // ══ THE DEPLOY WINDOW ═══════════════════════════════════
  // The app deploys the instant a commit lands; migrations are run by
  // hand afterwards. So there is always a window where this code is live
  // against a database that has not grown 009's columns yet, and checkout
  // has to keep working through it.
  //
  // The first version of the guard did `try { SELECT member_title } catch {}`
  // INSIDE the checkout transaction. That looked handled and was not:
  // Postgres aborts the whole transaction on any error, so every query
  // after it failed with "current transaction is aborted" and the entire
  // checkout died — worse than the missing column it was guarding against.
  // The probe now runs first, on the pool, and never puts a failing
  // statement into the transaction at all.
  section('Checkout survives migration 009 not having been run');
  const dropped = ['member_limit_enabled', 'member_title',
                   'member_item_limit', 'member_limit_per_category'];
  const MIG = await freshAsset('LIM-MIG-A', 'Limit Migration Window', carts.id);
  const MEG = await freshLoanee('meg.limit@example.com', 'Meg', 'Window', 'Committee Member');
  try {
    await query(`ALTER TABLE public.app_settings ${
      dropped.map(c => `DROP COLUMN IF EXISTS ${c}`).join(', ')}`);
    // This process has ALREADY cached the columns as present — which is
    // the harder and more honest version of the test. A cold start would
    // simply probe and find them gone; here the code is holding a stale
    // "yes" and has to survive discovering it is wrong, mid-checkout,
    // without taking the transaction down with it.
    r = await call('POST', 'checkout', { loanee_id: MEG, asset_ids: [MIG] });
    check('a checkout still succeeds with the columns missing',
      r.status === 201 || r.status === 409, r.body);
    check('and it is not a 500 from an aborted transaction',
      r.status !== 500 && !/transaction is aborted/i.test(JSON.stringify(r.body || {})), r.body);
    r = await call('GET', 'settings');
    check('settings still reads, without the missing fields',
      r.status === 200 && !('member_title' in (r.body || {})), Object.keys(r.body || {}));
  } finally {
    // Always put them back, whatever happened above — the migration is
    // idempotent, so this is the same command an operator would run.
    await query(`ALTER TABLE public.app_settings
      ADD COLUMN IF NOT EXISTS member_limit_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS member_title              TEXT    NOT NULL DEFAULT 'Committee Member',
      ADD COLUMN IF NOT EXISTS member_item_limit         INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS member_limit_per_category BOOLEAN NOT NULL DEFAULT FALSE`);
  }

  // Leave the database on the documented defaults.
  await setRule({ enabled: true, title: 'Committee Member', limit: 1, perCategory: false });

  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length) {
    console.log('\x1b[31mFailures:\x1b[0m');
    failures.forEach(f => console.log(`  · ${f}`));
  }
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error('\n\x1b[31mHARNESS ERROR\x1b[0m', e); process.exit(2); });
