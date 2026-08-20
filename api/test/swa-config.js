// ══════════════════════════════════════════════════════════════
// staticwebapp.config.json — does every route still point somewhere?
//
//   node api/test/swa-config.js
//
// No database, no server. This exists because of two separate near-misses
// on the same file:
//
//   1. A push once carried `navigationFallback` and `responseOverrides`
//      blocks that had never been in the file. Invented configuration,
//      not a typo — and a rewrite-everything-to-index fallback changes
//      what every unmatched URL on the site returns.
//   2. /1932 rewrites to a page. Rename or move that page and the route
//      keeps resolving — to nothing. SWA answers 404 and the app looks
//      broken at exactly the address someone was told to type.
//
// Neither shows up in any other suite, because nothing else in the repo
// reads this file. It is pure deployment configuration, which is another
// way of saying nothing catches a mistake in it until production does.
// ══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG = path.join(ROOT, 'staticwebapp.config.json');

let passed = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${extra !== undefined ? `\n      ${JSON.stringify(extra)}` : ''}`); }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

section('The file itself');
let cfg = null;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  check('staticwebapp.config.json is valid JSON', true);
} catch (e) {
  check('staticwebapp.config.json is valid JSON', false, e.message);
  process.exit(1);
}
check('it has a routes array', Array.isArray(cfg.routes), Object.keys(cfg));

// Everything that lands here was added on purpose and reviewed. A key
// that is NOT here arrived some other way, which is the case worth
// catching — see the invented-blocks note at the top.
const KNOWN_TOP_LEVEL = ['globalHeaders', 'routes'];
section('Nothing arrived that nobody added');
for (const key of Object.keys(cfg)) {
  check(`"${key}" is a key this project actually uses`,
    KNOWN_TOP_LEVEL.includes(key),
    'If this is deliberate, add it to KNOWN_TOP_LEVEL with a reason. '
    + 'If it is not, it was typed in by mistake and changes how the whole site serves.');
}

section('Every route points somewhere real');
// A target only needs to exist on disk if it names a specific file. A
// wildcard route is a header rule, not a destination.
const targets = [];
for (const r of cfg.routes) {
  for (const kind of ['rewrite', 'redirect']) {
    const t = r[kind];
    if (!t) continue;
    targets.push({ route: r.route, kind, target: t });
  }
}
check('at least one route has a destination', targets.length > 0);

for (const { route, kind, target } of targets) {
  if (!target.startsWith('/') || target.includes('*')) {
    check(`${route} → ${target} is an external or wildcard target, not checked`, true);
    continue;
  }
  const onDisk = path.join(ROOT, target.replace(/^\//, ''));
  check(`${route} ${kind}s to ${target}, and that file exists`,
    fs.existsSync(onDisk), onDisk);
}

section('/1932');
const nineteen = cfg.routes.filter(r => r.route === '/1932');
check('the route is present exactly once', nineteen.length === 1, nineteen.length);
if (nineteen.length === 1) {
  const r = nineteen[0];
  // A rewrite keeps the address bar saying /1932, which is the entire
  // point — it is meant to be read out loud and typed from memory.
  check('it REWRITES rather than redirects', !!r.rewrite && !r.redirect, r);
  check('its page exists', !!r.rewrite && fs.existsSync(path.join(ROOT, r.rewrite.replace(/^\//, ''))), r.rewrite);

  // The thing this route must never become. A URL that signs somebody in
  // is a backdoor whether or not the URL is easy to guess, so the shape
  // of it is asserted rather than left to a code review.
  const asText = JSON.stringify(r).toLowerCase();
  check('it carries no token, no key and no secret',
    !/token|secret|passw|apikey|api_key|bypass/.test(asText), asText);
  check('it does not set headers that could stand in for a session',
    !r.headers || !Object.keys(r.headers).some(h => /auth|cookie|token/i.test(h)), r.headers);
  check('it is not restricted to a role, because it is a public login page',
    !r.allowedRoles || r.allowedRoles.includes('anonymous'), r.allowedRoles);
}

section('The red door and the front page are the same sign-in');
// Not a style assertion — a behaviour one. If these two pages ever stop
// loading the same auth script, they have stopped being the same login,
// and the difference would be invisible until someone could sign in on
// one and not the other.
for (const page of ['index.html', '1932.html']) {
  const p = path.join(ROOT, page);
  if (!fs.existsSync(p)) { check(`${page} exists`, false, p); continue; }
  const html = fs.readFileSync(p, 'utf8');
  check(`${page} loads /js/auth.js`, html.includes('/js/auth.js'));
  check(`${page} posts through the shared form handler`, html.includes('handleLogin(event)'));
  // js/auth.js reads these by id. A renamed field is a login page that
  // silently cannot log anyone in.
  for (const id of ['login-error', 'email', 'password', 'login-btn', 'login-btn-label',
                    'pw-icon', 'password-label', 'not-you']) {
    check(`${page} has #${id}, which js/auth.js reads by id`, html.includes(`id="${id}"`));
  }
  check(`${page} keeps the name field as type="text"`,
    /id="email"[^>]*\/?>/.test(html) && /type="text"[^>]*id="email"|id="email"[^>]*type="text"/.test(html),
    'type="email" makes the browser refuse to submit a person\'s name');

  // The second field's label is rewritten at runtime — "Zip code" for a
  // committee member, "Password" for an admin. Hardcoding inputmode in
  // the markup would fight that: a static numeric keypad is wrong for a
  // passphrase, and a static text one throws away the win on five digits.
  const pwTag = (/<input[^>]*id="password"[^>]*>/.exec(html) || [''])[0];
  check(`${page} leaves inputmode on the password field to js/auth.js`,
    !/inputmode=/i.test(pwTag), pwTag);
  // The "Not you?" control must actually be wired to something, or it is
  // a button that silently does nothing on the one screen where a dead
  // control is most alarming.
  check(`${page} wires "Not you?" to clearIdentity()`,
    html.includes('onclick="clearIdentity()"'));
}

section('The login script backs those pages up');
// Cheap, and it has already earned itself once: a PLACEHOLDER string
// went out in a pushed .js file and took the whole app down. These are
// the four behaviours the two pages above depend on existing here.
const authJs = fs.readFileSync(path.join(ROOT, 'js', 'auth.js'), 'utf8');
for (const fn of ['function handleLogin', 'function clearIdentity',
                  'function prefillIdentity', 'function retitlePassword']) {
  check(`js/auth.js defines ${fn.replace('function ', '')}()`, authJs.includes(fn));
}
// The one rule about what may be remembered. Storing the second box
// would mean the tablet itself could sign somebody in.
check('js/auth.js never writes the password or zip to storage',
  !/setItem\([^)]*(password|zip)/i.test(authJs),
  'Only the identifier may be remembered.');

console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
if (failures.length) {
  console.log('\x1b[31mFailures:\x1b[0m');
  failures.forEach(f => console.log(`  · ${f}`));
}
process.exit(failures.length ? 1 : 0);
