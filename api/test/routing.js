// ═════════════════════════════════════════════════════════════════════
// Route collisions: a literal segment sitting under an {id} template.
//
// Three endpoints have a sibling pair that both match the same URL:
//
//     GET /api/loans/open        →  'loans/open'        AND 'loans/{id}'
//     GET /api/loanees/lookup    →  'loanees/lookup'    AND 'loanees/{id}'
//     GET /api/loanees/committees→  'loanees/committees'AND 'loanees/{id}'
//     GET /api/assets/lookup     →  'assets/lookup'     AND 'assets/{id}'
//
// The Functions host does NOT reliably prefer the literal. In production
// the template won, so the board's request reached loansGet as id="open",
// went to Postgres, and came back "invalid input syntax for type uuid".
// Two screens dead — the counter and the leader board — while every other
// page kept working, which is what made it look like a search bug.
//
// The other suites cannot catch this. Their harness resolves a URL by
// walking the registered routes and taking the first match, and the
// literal is registered first, so it always wins there. This file
// deliberately skips resolution and invokes the {id} handler DIRECTLY
// with the literal as the id — reproducing what Azure actually did.
//
//   DATABASE_URL=... JWT_SECRET=test node api/test/routing.js
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

const jwt = require(path.join(__dirname, '..', 'node_modules', 'jsonwebtoken'));

let passed = 0; const failures = [];
function check(label, cond, extra) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra ? `\n      ${String(extra).slice(0, 300)}` : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

(async function run() {
  const { query } = require(path.join(__dirname, '..', 'src', 'db'));

  // Reuse whatever admin exists; this suite reads only, so it does not
  // truncate and can run in any order relative to the others.
  const p = await query(`SELECT id, email, role, token_version FROM public.profiles
                         WHERE role = 'admin' AND status = 'active' LIMIT 1`);
  if (!p.rows.length) {
    console.error('No active admin in the database — run api/test/smoke.js first.');
    process.exit(1);
  }
  const u = p.rows[0];
  const token = jwt.sign(
    { sub: u.id, email: u.email, role: u.role, tv: u.token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' });

  // Invoke one registered function by NAME, bypassing route resolution.
  async function invoke(fnName, url, params) {
    const r = ROUTES.find(x => x.name === fnName);
    if (!r) return { status: 'NO SUCH FUNCTION' };
    try {
      const res = await r.handler({
        method: 'GET', url: `http://localhost/api/${url}`, params: params || {},
        headers: { get: k => (k.toLowerCase() === 'x-assets-token' ? token : null) },
        json: async () => ({}),
      }, { functionName: fnName });
      let body = null; try { body = JSON.parse(res.body); } catch {}
      return { status: res.status, body };
    } catch (e) { return { status: 'THREW', message: e.message }; }
  }

  section('The template wins and receives the literal — what production did');
  let r = await invoke('loansGet', 'loans/open', { id: 'open' });
  check('loans/{id} with id="open" returns the open-loans payload',
    r.status === 200 && Array.isArray(r.body?.rows) && !!r.body?.stats, JSON.stringify(r));

  r = await invoke('loaneesGet', 'loanees/lookup?q=dr', { id: 'lookup' });
  check('loanees/{id} with id="lookup" returns matches',
    r.status === 200 && Array.isArray(r.body?.matches), JSON.stringify(r));

  r = await invoke('loaneesGet', 'loanees/committees', { id: 'committees' });
  check('loanees/{id} with id="committees" returns the facet rows',
    r.status === 200 && Array.isArray(r.body?.rows), JSON.stringify(r));

  r = await invoke('assetsGet', 'assets/lookup?q=fo', { id: 'lookup' });
  check('assets/{id} with id="lookup" returns matches',
    r.status === 200 && Array.isArray(r.body?.matches), JSON.stringify(r));

  section('The literal registrations still work when THEY win');
  r = await invoke('loansOpen', 'loans/open', {});
  check('loans/open', r.status === 200 && Array.isArray(r.body?.rows), JSON.stringify(r));
  r = await invoke('loaneesLookup', 'loanees/lookup?q=dr', {});
  check('loanees/lookup', r.status === 200 && Array.isArray(r.body?.matches), JSON.stringify(r));
  r = await invoke('loaneesCommittees', 'loanees/committees', {});
  check('loanees/committees', r.status === 200 && Array.isArray(r.body?.rows), JSON.stringify(r));
  r = await invoke('assetsLookup', 'assets/lookup?q=fo', {});
  check('assets/lookup', r.status === 200 && Array.isArray(r.body?.matches), JSON.stringify(r));

  section('A genuinely bad id is a clean 404, never a database 500');
  for (const [fn, bad] of [
    ['loansGet', 'not-a-uuid'], ['loaneesGet', '12345'], ['assetsGet', 'null'],
  ]) {
    const res = await invoke(fn, `x/${bad}`, { id: bad });
    check(`${fn} with id="${bad}" → 404`, res.status === 404, JSON.stringify(res));
  }

  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length) { failures.forEach(f => console.log(`  - ${f}`)); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
