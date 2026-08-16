// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — route authorisation audit.
//
// `leader` is the first genuinely read-only role in either app, which
// means a single mutating handler that forgets requireRole() silently
// grants leadership write access — and nothing in the UI would reveal it,
// because the leader never sees the button. This is the cheap check that
// makes that impossible to ship by accident.
//
//   node api/test/routes-audit.js
//
// Run it before every release. Exits non-zero if any mutating route is
// missing a role gate, or any read route is missing an auth check.
// ─────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

// Routes that are unauthenticated or self-service ON PURPOSE. Adding to
// this list should be a deliberate, reviewed act — that's why it names
// each one and says why.
const ALLOWED = {
  authLogin:          'public by design — it is the sign-in endpoint',
  authBootstrap:      'gated on the BOOTSTRAP_SECRET app setting; also refuses once an admin exists',
  authChangePassword: 'self-service; requireAuth is the correct gate (any signed-in role changes their own password)',
  appLogsCreate:      'self-service; requireAuth is correct (any signed-in role may report a client error)',
  health:             'unauthenticated on purpose; returns no data and no secrets',
};

const dir = path.join(__dirname, '..', 'src', 'functions');
const issues = [];
let total = 0, mutating = 0;

for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const part of src.split(/app\.http\(/).slice(1)) {
    const name = (part.match(/^\s*['"`]([\w${}]+)['"`]/) || [])[1] || '(computed)';
    const methods = (part.match(/methods:\s*\[([^\]]*)\]/) || [])[1] || '';
    const route = (part.match(/route:\s*['"`]([^'"`,]+)['"`]/) || [])[1] || '(computed)';
    const body = part.split(/\n\}\);/)[0];
    total++;

    if (!/authLevel:\s*['"]anonymous['"]/.test(body)) {
      issues.push(`${f} · ${name}: authLevel must be 'anonymous' (auth is enforced in-handler)`);
    }

    const isMutating = /POST|PATCH|PUT|DELETE/.test(methods);
    const hasRole = /requireRole\(/.test(body);
    const hasAuth = /requireAuth\(/.test(body);
    const excused = Object.keys(ALLOWED).some(k => name.includes(k));

    if (isMutating) {
      mutating++;
      if (!hasRole && !excused) {
        issues.push(`${f} · ${methods} /${route} (${name}): MUTATING route with no requireRole()`);
      }
      if (!hasRole && !hasAuth && excused && name !== 'authLogin' && name !== 'authBootstrap') {
        issues.push(`${f} · ${name}: excused from requireRole but has no requireAuth either`);
      }
    } else if (!hasAuth && !hasRole && !excused) {
      issues.push(`${f} · GET /${route} (${name}): no auth check at all`);
    }
  }
}

console.log(`Scanned ${total} route registrations (${mutating} mutating).`);
if (issues.length) {
  console.log('\n\x1b[31mFAILED\x1b[0m');
  issues.forEach(i => console.log(`  · ${i}`));
  process.exit(1);
}
console.log('\x1b[32m✓\x1b[0m Every mutating route has a role gate; every read has an auth check.');
console.log('  Deliberate exceptions:');
for (const [k, why] of Object.entries(ALLOWED)) console.log(`    · ${k} — ${why}`);
