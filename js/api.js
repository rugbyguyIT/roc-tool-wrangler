// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — API helper
//
// Azure Static Web Apps strips Authorization headers before they reach
// the API functions, so the JWT travels in x-assets-token instead. If
// every call suddenly 401s, check that first.
//
// Token storage differs by role on purpose:
//   staff  → localStorage, 12h JWT. Staff work from a shared tablet in a
//            shed; the session must survive a page reload and a pocket,
//            but must NOT still be live the next morning for whoever
//            picks the tablet up.
//   leader → localStorage, 30d. A read-only phone PWA that nags for a
//            password every week is a phone PWA nobody opens.
//   admin  → sessionStorage, 12h. Dies with the tab as well as the clock.
// ─────────────────────────────────────────────────────────────
const TOKEN_KEY = 'assets_token';
const PROFILE_KEY = 'assets_profile';
const PERSISTENT_ROLES = ['staff', 'leader'];

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || '';
}
function saveSession(token, profile) {
  const store = PERSISTENT_ROLES.includes(profile.role) ? localStorage : sessionStorage;
  store.setItem(TOKEN_KEY, token);
  store.setItem(PROFILE_KEY, JSON.stringify(profile));
}
function getProfile() {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || sessionStorage.getItem(PROFILE_KEY) || 'null'); }
  catch { return null; }
}
function signOut() {
  [localStorage, sessionStorage].forEach(s => { s.removeItem(TOKEN_KEY); s.removeItem(PROFILE_KEY); });
  window.location.href = '/index.html';
}

// Every call returns { data, error } and NEVER throws, so call sites are
// always `const { data, error } = await api(...)` with no try/catch.
async function api(path, method = 'GET', body) {
  try {
    // Snapshot whether we HAD a token before the call. A 401 only means
    // "your session expired, sign in again" if we actually sent one —
    // /auth/login returns 401 for a wrong password and carries no token,
    // and bouncing to the login page from the login page would just look
    // like the form silently clearing itself.
    const hadToken = !!getToken();
    const res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-assets-token': getToken() },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      const data = await res.json().catch(() => null);
      if (hadToken) { signOut(); return { data: null, error: 'Session expired' }; }
      return { data: null, error: (data && data.error) || 'Unauthorized' };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) return { data: null, error: (data && data.error) || `HTTP ${res.status}`, detail: data };
    return { data, error: null };
  } catch (e) {
    return { data: null, error: 'Could not reach the server. Check your connection.' , detail: { message: e.message } };
  }
}

// Page guard. This is UX, not security — it stops someone landing on a
// screen that won't work for them. The real boundary is requireRole() on
// every API handler.
function requireLogin(...roles) {
  const p = getProfile();
  if (!p || !getToken()) { window.location.href = '/index.html'; return null; }
  if (roles.length && !roles.includes(p.role)) { window.location.href = '/index.html'; return null; }
  return p;
}

// ── Formatting helpers ──────────────────────────────────────
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

function fmtWhen(iso, fallback = '—') {
  if (!iso) return fallback;
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}
function fmtDate(iso, fallback = '—') {
  if (!iso) return fallback;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
// "3h ago" / "in 45m" — the board is read at arm's length, and a relative
// figure answers "is this a problem?" faster than a timestamp does.
function fmtAgo(iso) {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  const a = Math.abs(mins);
  const unit = a < 60 ? `${a}m` : a < 1440 ? `${Math.round(a / 60)}h` : `${Math.round(a / 1440)}d`;
  return mins >= 0 ? `${unit} ago` : `in ${unit}`;
}
function fmtPhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return v || '';
}
// <input type="datetime-local"> wants local wall-clock time with no zone,
// so a plain toISOString() would silently shift the value by the UTC offset.
function toLocalInput(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}
function fromLocalInput(v) {
  return v ? new Date(v).toISOString() : null;
}

function toastMsg(title, body, kind) {
  let stack = document.getElementById('toastStack');
  if (!stack) { stack = document.createElement('div'); stack.id = 'toastStack'; stack.className = 'toast-stack'; document.body.appendChild(stack); }
  const el = document.createElement('div'); el.className = 'toast';
  const icon = kind === 'error' ? 'fa-circle-exclamation' : kind === 'ok' ? 'fa-circle-check' : 'fa-bell';
  if (kind === 'error') el.style.borderLeftColor = 'var(--red)';
  if (kind === 'ok') el.style.borderLeftColor = 'var(--green)';
  el.innerHTML = `<i class="fa-solid ${icon}"></i><div><div class="t-title">${esc(title)}</div><div class="t-body">${esc(body || '')}</div></div>`;
  stack.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, kind === 'error' ? 8000 : 5000);
}

// ── Branding (swap point 1 of 4 lives in js/config.js) ─────────
// Nothing hardcodes the app name in markup. Any element carrying
// data-app-name / data-app-short / data-app-org is filled in here, so
// renaming the app is a one-line change in config.js.
function brandPage() {
  const map = { 'data-app-name': APP_NAME, 'data-app-short': APP_SHORT, 'data-app-org': APP_ORG };
  for (const [attr, val] of Object.entries(map)) {
    document.querySelectorAll(`[${attr}]`).forEach(el => { el.textContent = val; });
  }
  if (document.title.includes('{{app}}')) document.title = document.title.replace('{{app}}', APP_NAME);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', brandPage);
else brandPage();

// Register the service worker on every page.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ── Client-side application/error logging ─────────────────
// Fire and forget: never blocks the UI, never throws. Surfaces in
// Admin → Settings → Application Logs. Only sent when signed in;
// the login page just console.errors.
function appLog(level, event, detail) {
  if (!getToken()) { console[level === 'error' ? 'error' : 'log'](`[${event}]`, detail); return; }
  fetch('/api/app-logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-assets-token': getToken() },
    body: JSON.stringify({ level, event, detail: String(detail).slice(0, 2000), page_url: location.pathname }),
    keepalive: true,
  }).catch(() => {});
}
// Catch anything unhandled so real bugs land in the log instead of dying
// silently in a browser on a tablet in a shed with nobody watching.
window.addEventListener('error', (e) => {
  appLog('error', 'client.exception', `${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  appLog('error', 'client.unhandled_rejection', e.reason?.stack || e.reason?.message || String(e.reason));
});
