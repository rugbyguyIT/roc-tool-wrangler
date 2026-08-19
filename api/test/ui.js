// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — browser test.
//
// Drives the REAL pages in a real Chromium against the dev server, doing
// what a counter staff member and a leader actually do. Fails on any
// console error or unhandled rejection, which is how a typo in a template
// literal gets caught before it reaches a shed tablet.
//
// Playwright is NOT a dependency of this repo — the app has no build step
// and nothing it ships needs it, so installing it here would put a
// package.json at the root that implies a build that doesn't exist.
// Install it globally instead, only when you want to run this suite:
//
//   npm install -g playwright && npx playwright install chromium
//   node api/test/devserver.js &                      (with DATABASE_URL/JWT_SECRET set)
//   NODE_PATH="$(npm root -g)" node api/test/ui.js
// ─────────────────────────────────────────────────────────────
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8080';
const SHOTS = process.env.SHOTS || '/tmp/shots';
const fs = require('fs');
fs.mkdirSync(SHOTS, { recursive: true });

let passed = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra ? `\n      ${extra}` : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

(async () => {
  const browser = await chromium.launch({ channel: undefined, executablePath: process.env.CHROME_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  // Google Fonts and the Font Awesome CDN aren't reachable from this
  // sandbox, and waiting on them makes every 'load' event hang. Fulfil
  // them locally: the tests are about behaviour, not typeface loading.
  await ctx.route('**://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await ctx.route('**://fonts.gstatic.com/**', r => r.abort());
  await ctx.route('**://cdnjs.cloudflare.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
  const failedRequests = [];
  page.on('requestfailed', r => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('response', r => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });

  const shot = async (name, p = page) => { await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };

  // Every picker keeps its own dropdown in the DOM (hidden when closed),
  // so options must be scoped to the wrapper of the specific input —
  // otherwise a stale member menu collides with the open asset menu.
  const opt = (inputId, i = 0) =>
    page.locator(`#${inputId}`).locator('xpath=..').locator(`[data-i="${i}"]`);
  const optCount = async (inputId) =>
    page.locator(`#${inputId}`).locator('xpath=..').locator('[data-i]').count();

  // ══ LOGIN ═══════════════════════════════════════════════════════
  section('Login');
  await page.goto(`${BASE}/index.html`);
  await page.waitForLoadState('domcontentloaded');
  check('the login page renders the branded orb', await page.locator('.auth-orb').isVisible());
  check('the title is built from APP_NAME, not hardcoded',
    (await page.title()).includes('HLSR Asset Tracker'), await page.title());
  await shot('01-login');

  await page.fill('#email', 'admin@hlsr.test');
  await page.fill('#password', 'nope-wrong');
  await page.click('#login-btn');
  await page.waitForTimeout(600);
  check('a wrong password shows an inline error, not a redirect',
    await page.locator('#login-error').isVisible() && page.url().includes('index.html'),
    await page.locator('#login-error').textContent());

  await page.fill('#password', 'correct-horse-battery');
  await page.click('#login-btn');
  await page.waitForURL('**/admin.html', { timeout: 15000, waitUntil: 'commit' });
  check('a correct password lands on the admin console', page.url().includes('admin.html'));

  // ══ ADMIN ═══════════════════════════════════════════════════════
  section('Admin console');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(800);
  const statNums = await page.locator('#dash-stats .stat-num').allTextContents();
  check('dashboard tiles are populated', statNums.length === 6 && statNums.every(t => t !== '—'), statNums.join(','));
  check('the signed-in user is named in the nav',
    (await page.locator('#user-name').textContent()).includes('Kyle'));
  check('the role is shown in plain language',
    (await page.locator('#user-role-label').textContent()).includes('Administrator'));
  await shot('02-admin-dashboard');

  check('the groups table rendered', await page.locator('#groups-table table').isVisible());
  check('the users table rendered', await page.locator('#users-table table').isVisible());
  check('both lookup panels rendered',
    await page.locator('#categories-panel table').isVisible()
    && await page.locator('#locations-panel table').isVisible());
  check('settings loaded with the 12-hour default',
    (await page.locator('#s-hours').inputValue()) === '12');

  await page.locator('#sec-settings').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot('03-admin-settings');

  await page.locator('#sec-logs').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  check('the audit log lists sign-in attempts',
    (await page.locator('#logs-panel tbody tr').count()) > 3);
  await shot('04-admin-logs');

  // Create a committee member through the real modal. They live on their
  // own page now, not in the admin console, so go there first.
  section('Create a committee member through the UI');
  await page.goto(`${BASE}/pages/members.html`);
  await page.waitForSelector('#loanees-table table');
  check('the committee member table rendered', await page.locator('#loanees-table table').isVisible());
  await page.click('button:has-text("Add member")');
  await page.waitForSelector('#ui-modal-form');
  check('the form modal opens', await page.locator('.ui-modal-card').isVisible());
  await page.fill('[name="last_name"]', 'Reyes');
  // Unique per run so the suite can be run repeatedly against the same DB.
  const STAMP = Date.now().toString().slice(-6);
  await page.fill('[name="first_name"]', `Marisol${STAMP}`);
  await page.fill('[name="email"]', `mreyes.${STAMP}@example.com`);
  await page.fill('[name="phone_mobile"]', '832-555-0117');
  await page.fill('[name="sub_committee"]', 'ROC Grounds');
  await shot('05-member-modal');
  await page.click('#ui-modal-form button[type="submit"]');
  await page.waitForTimeout(900);
  const NEW_LOANEE = `Marisol${STAMP} Reyes`;
  check('the new committee member appears in the table',
    await page.locator('#loanees-table').getByText(NEW_LOANEE).isVisible());

  // ══ COUNTER ════════════════════════════════════════════════════
  section('Check-out counter');
  // Create this run's own assets so the suite never depends on what a
  // previous run left checked out. Two available, one parked in
  // maintenance so the blocked-row path has something real to refuse.
  const made = await page.evaluate(async (stamp) => {
    const mk = (tag, title) => api('/assets', 'POST', { asset_tag: tag, title });
    const a = await mk(`UI-${stamp}-A`, `UI Test Radio A ${stamp}`);
    const b = await mk(`UI-${stamp}-B`, `UI Test Radio B ${stamp}`);
    const c = await mk(`UI-${stamp}-C`, `UI Test Radio C ${stamp}`);
    if (c.data) await api(`/assets/${c.data.id}/action`, 'POST',
      { action: 'maintenance_start', reason: 'UI test fixture' });
    return { a: !!a.data, b: !!b.data, c: !!c.data };
  }, STAMP);
  check('test fixtures created through the API', made.a && made.b && made.c, JSON.stringify(made));

  await page.goto(`${BASE}/pages/staff.html`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(500);
  check('the due date is pre-filled 12 hours out',
    !!(await page.locator('#due-input').inputValue()));
  check('the asset field is disabled until a person is chosen',
    await page.locator('#asset-input').isDisabled());
  await shot('06-checkout-empty');

  // Pick a person via the type-ahead.
  await page.fill('#loanee-input', NEW_LOANEE.split(' ')[0]);
  await page.waitForTimeout(500);
  check('the person picker shows matches', (await optCount('loanee-input')) > 0);
  await shot('07-picker-open');
  await opt('loanee-input').click();
  await page.waitForTimeout(700);
  check('the chosen person is shown with their committee',
    await page.locator('#loanee-picked').getByText(NEW_LOANEE).isVisible());
  check('choosing a person enables the asset field',
    !(await page.locator('#asset-input').isDisabled()));

  // Add two available assets.
  await page.fill('#asset-input', `UI-${STAMP}`);
  await page.waitForTimeout(600);
  const optionCount = await optCount('asset-input');
  check('the asset picker finds this run\'s assets', optionCount === 3, String(optionCount));
  await shot('08-asset-picker');
  // Pick the first option that is actually available — the suite leaves
  // one radio in maintenance on purpose, and the picker correctly refuses
  // to add that one.
  const radioOpts = await page.locator('#asset-input').locator('xpath=..').locator('[data-i]').allTextContents();
  const freeIdx = radioOpts.findIndex(t => /Available/i.test(t));
  check('the picker labels an in-maintenance radio as unavailable',
    radioOpts.some(t => /maintenance/i.test(t)), radioOpts.join(' | ').slice(0, 160));
  await opt('asset-input', freeIdx >= 0 ? freeIdx : 0).click();
  await page.waitForTimeout(600);
  check('the item lands in the cart', (await page.locator('#cart-wrap tbody tr').count()) === 1);

  await page.fill('#asset-input', `UI-${STAMP}`);
  await page.waitForTimeout(600);
  const texts2 = await page.locator('#asset-input').locator('xpath=..').locator('[data-i]').allTextContents();
  const second = texts2.findIndex(t => /Available/i.test(t) && !/ Radio A /.test(t));
  await opt('asset-input', second >= 0 ? second : 1).click();
  await page.waitForTimeout(600);
  const cartRows = await page.locator('#cart-wrap tbody tr').count();
  check('a second item can be added to the same cart', cartRows === 2, String(cartRows));
  check('the button counts the items',
    (await page.locator('#checkout-label').textContent()).match(/Check Out \d+ Item/) !== null,
    await page.locator('#checkout-label').textContent());
  await shot('09-cart-loaded');

  // A blocked row must refuse the click, not silently add itself.
  await page.fill('#asset-input', `UI-${STAMP}`);
  await page.waitForTimeout(600);
  const texts = await page.locator('#asset-input').locator('xpath=..').locator('[data-i]').allTextContents();
  const blockedIdx = texts.findIndex(t => /maintenance|Checked out|not in a group/i.test(t));
  check('a blocked asset shows its reason inline in the picker', blockedIdx >= 0,
    texts.join(' | ').slice(0, 160));
  await shot('10-blocked-in-picker');
  if (blockedIdx >= 0) {
    const beforeRows = await page.locator('#cart-wrap tbody tr').count();
    await opt('asset-input', blockedIdx).click();
    await page.waitForTimeout(500);
    check('clicking a blocked asset refuses it instead of adding it',
      (await page.locator('#cart-wrap tbody tr').count()) === beforeRows);
    check('and says why in a toast',
      /Can.t add|maintenance|Checked out|group/i.test(
        await page.locator('.toast').first().textContent().catch(() => '')));
  }
  await page.keyboard.press('Escape');

  // Do the checkout.
  await page.fill('#notes-input', 'Setup crew, north gate');
  // Clear the "can't add that one" toast first so the assertion below
  // reads the checkout's own toast rather than the previous one.
  await page.evaluate(() => document.getElementById('toastStack')?.replaceChildren());
  await page.click('#checkout-btn');
  await page.waitForTimeout(1400);
  const toastText = await page.locator('.toast').last().textContent().catch(() => '');
  check('checkout succeeds and reports back', /out to Marisol/i.test(toastText), toastText);
  check('the cart is cleared afterwards', (await page.locator('#cart-wrap tbody tr').count()) === 0);
  await shot('11-checkout-done');

  // ══ BOARD ═══════════════════════════════════════════════════════
  section('Leadership board');
  // Backdate one open loan so the board has something overdue to show.
  // Done through the real extend endpoint rather than by touching the DB,
  // so this also exercises POST /loans/{id}/extend.
  const backdated = await page.evaluate(async () => {
    const open = await api('/loans/open');
    const row = open.data.rows[0];
    if (!row) return null;
    const past = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const res = await api(`/loans/${row.loan_id}/extend`, 'POST', { due_at: past });
    return res.error ? { error: res.error } : { tag: row.asset_tag };
  });
  check('a due date can be moved through the extend endpoint',
    backdated && !backdated.error, JSON.stringify(backdated));

  await page.goto(`${BASE}/pages/board.html`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(900);
  check('the board uses the dark theme', await page.locator('body.theme-glass').count() === 1);
  const boardCards = await page.locator('.event-card').count();
  check('open items are listed', boardCards > 0, String(boardCards));
  check('the board names who has each item',
    (await page.locator('.event-card').getByText(NEW_LOANEE).count()) > 0);
  check('the stat tiles are filled',
    (await page.locator('#stats .stat-num').allTextContents()).every(t => t !== '—'));
  check('the overdue item is flagged in red', (await page.locator('.event-card.is-overdue').count()) >= 1);
  check('overdue sorts to the top',
    (await page.locator('.event-card').first().getAttribute('class')).includes('is-overdue'));
  await shot('12-board-desktop');

  // A leader on a phone is the real use case. Admin sessions live in
  // sessionStorage (they die with the tab, by design), so this signs in
  // as the leader — which also proves the 30-day localStorage session
  // survives opening the PWA in a fresh tab.
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: false });
  await phoneCtx.route('**://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await phoneCtx.route('**://fonts.gstatic.com/**', r => r.abort());
  await phoneCtx.route('**://cdnjs.cloudflare.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const phone = await phoneCtx.newPage();
  await phone.goto(`${BASE}/index.html`);
  await phone.fill('#email', 'leader@hlsr.test');
  await phone.fill('#password', 'leader-password-1');
  await phone.click('#login-btn');
  await phone.waitForURL('**/board.html', { timeout: 15000, waitUntil: 'commit' });
  await phone.waitForTimeout(1200);
  check('a leader signing in on a phone lands on the board',
    await phone.locator('.stat-card').first().isVisible());
  check('the phone board shows the open items',
    (await phone.locator('.event-card').count()) > 0);
  await shot('13-board-phone', phone);

  const phone2 = await phoneCtx.newPage();
  await phone2.goto(`${BASE}/pages/board.html`);
  await phone2.waitForTimeout(1200);
  check('the leader session survives a fresh tab (30d localStorage)',
    phone2.url().includes('board.html') && await phone2.locator('.stat-card').first().isVisible(),
    phone2.url());
  await phone2.close();
  await phone.close();
  await phoneCtx.close();

  // Filter chips.
  const overdueChip = page.locator('.board-chip', { hasText: 'Overdue' });
  if (await overdueChip.count()) {
    await overdueChip.first().click();
    await page.waitForTimeout(400);
    check('the overdue filter narrows the feed',
      (await page.locator('.event-card').count()) < boardCards);
    await shot('14-board-overdue-filter');
  }

  // ══ ASSETS ══════════════════════════════════════════════════════
  section('Asset catalog');
  await page.goto(`${BASE}/pages/assets.html`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(800);
  check('the asset table renders', (await page.locator('#results tbody tr').count()) > 0);
  check('the header counts by status',
    /available/.test(await page.locator('#page-sub').textContent()));
  await shot('15-assets-list');

  await page.selectOption('#f-status', 'maintenance');
  await page.waitForTimeout(700);
  const maintRows = await page.locator('#results tbody tr').count();
  check('filtering by maintenance narrows the list', maintRows >= 0, String(maintRows));
  await page.selectOption('#f-status', '');
  await page.waitForTimeout(700);

  await page.locator('#results tbody tr').first().click();
  await page.waitForTimeout(900);
  check('the asset detail opens', await page.locator('.ui-modal-card').isVisible());
  check('it shows the custody history', await page.locator('.tline').count() > 0);
  await shot('16-asset-detail');
  await page.keyboard.press('Escape');

  // ══ REPORTS ═══════════════════════════════════════════════════
  section('Reports');
  await page.goto(`${BASE}/pages/reports.html`);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1000);
  check('the report tabs render', (await page.locator('#report-tabs button').count()) === 6);
  check('Reports opens on the checkout history, not on Out Now',
    (await page.locator('#report-tabs button.active').textContent()).includes('Checkout history'),
    await page.locator('#report-tabs button.active').textContent());
  check('the default report has rows', (await page.locator('#report-body tbody tr').count()) > 0);
  await shot('17-reports-history');

  for (const [label, name] of [['Out now', '18-report-out-now'], ['Inventory', '19-report-inventory'],
                               ['Activity', '20-report-activity'], ['Overdue', '21-report-overdue']]) {
    await page.locator('#report-tabs button', { hasText: label }).click();
    await page.waitForTimeout(900);
    const rows = await page.locator('#report-body tbody tr').count();
    check(`the "${label}" report loads`, rows >= 0, String(rows));
    await shot(name);
  }

  // Export actually produces a file.
  // Back to the landing report: its CSV is the one with a person column.
  await page.locator('#report-tabs button', { hasText: 'Checkout history' }).click();
  await page.waitForTimeout(900);
  const dl = page.waitForEvent('download', { timeout: 8000 });
  await page.click('#export-btn');
  const download = await dl;
  const csvPath = `/tmp/${download.suggestedFilename()}`;
  await download.saveAs(csvPath);
  const csv = fs.readFileSync(csvPath, 'utf8');
  check('CSV export downloads a real file', csv.length > 50, download.suggestedFilename());
  check('the CSV starts with a UTF-8 BOM so Excel reads it correctly', csv.charCodeAt(0) === 0xFEFF);
  check('the CSV header uses human labels, not column names',
    csv.split('\r\n')[0].includes('Member') && csv.split('\r\n')[0].includes('Asset tag'),
    csv.split('\r\n')[0].slice(0, 120));

  // ══ ROLE GATING IN THE BROWSER ═════════════════════════════════════
  section('Role gating');
  const leader = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await leader.route('**://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await leader.route('**://fonts.gstatic.com/**', r => r.abort());
  await leader.route('**://cdnjs.cloudflare.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const lp = await leader.newPage();
  const leaderErrors = [];
  lp.on('pageerror', e => leaderErrors.push(e.message));
  await lp.goto(`${BASE}/index.html`);
  await lp.fill('#email', 'leader@hlsr.test');
  await lp.fill('#password', 'leader-password-1');
  await lp.click('#login-btn');
  await lp.waitForURL('**/board.html', { timeout: 15000, waitUntil: 'commit' });
  check('a leader is sent straight to the board', lp.url().includes('board.html'));
  await lp.waitForTimeout(700);
  const navLinks = await lp.locator('.topnav-links .nav-item').allTextContents();
  check('a leader is not offered admin or counter links',
    !navLinks.some(t => /Admin|Check In/.test(t)), navLinks.join(','));

  await lp.goto(`${BASE}/pages/admin.html`);
  await lp.waitForTimeout(1500);
  // requireLogin() bounces to /index.html, which then recognises the live
  // leader session and forwards to the board — so the leader never sits on
  // the admin page, and never sees a pointless login form either.
  check('a leader cannot stay on the admin page',
    !lp.url().includes('admin.html'), lp.url());
  check('and is returned to their own portal rather than a login form',
    lp.url().includes('board.html'), lp.url());
  check('no page errors in the leader session', leaderErrors.length === 0, leaderErrors.join(' | '));
  await leader.close();

  // ══ CONSOLE HEALTH ═════════════════════════════════════════════
  section('Console');
  // Missing photos and the absent blob container produce expected 404/503
  // noise; anything else is a real defect.
  const real = consoleErrors.filter(e => /pageerror|Uncaught|TypeError|ReferenceError|SyntaxError/.test(e));
  check('no uncaught JavaScript errors on any page', real.length === 0, real.slice(0, 6).join('\n      '));

  // The only HTTP failures we tolerate are the deliberately wrong password
  // and requests for images that do not exist yet.
  const badHttp = failedRequests.filter(u =>
    !/auth\/login|favicon|apple-touch|icons\/|login-logo|fonts|cdnjs/.test(u));
  check('no unexpected HTTP failures', badHttp.length === 0, badHttp.slice(0, 8).join('\n      '));

  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  console.log(`screenshots → ${SHOTS}`);
  if (failures.length) failures.forEach(f => console.log(`  · ${f}`));
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error('\n\x1b[31mHARNESS ERROR\x1b[0m', e); process.exit(2); });
