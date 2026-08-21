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
// ── Ending a session, and saying why ───────────────────────
// Kyle: "I need to make the app auto log you out and not just stay in the
// app when login time expires. and a message of why."
//
// Both halves matter. Before this, a session only died when someone
// happened to make an API call — so a tablet could sit on the counter all
// night looking signed in, and the first tap the next morning would throw
// you to a login screen with no explanation. That reads as the app
// breaking, not as the app doing its job.
//
// The reason travels in the URL because the storage it would otherwise
// live in has just been cleared. The login page reads it once and strips
// it from the address bar, so a refresh does not re-accuse anyone.
const SESSION_ENDED = {
  EXPIRED: 'expired',   // the token passed its own exp
  REVOKED: 'revoked',   // still in date, but the server refused it anyway
  OUT: 'out',           // they pressed Sign out; no explanation is owed
};

function endSession(reason) {
  [localStorage, sessionStorage].forEach(s => { s.removeItem(TOKEN_KEY); s.removeItem(PROFILE_KEY); });
  localStorage.removeItem('assets.brand');
  window.location.href = reason && reason !== SESSION_ENDED.OUT
    ? `/index.html?ended=${encodeURIComponent(reason)}`
    : '/index.html';
}

// The nav's Sign out button. Deliberate, so it explains nothing.
function signOut() { endSession(SESSION_ENDED.OUT); }

// When this token says it dies, in ms since the epoch, or 0 if it cannot
// be read. The payload is the middle segment of the JWT, base64url and
// unsigned — reading it proves nothing and is not meant to. The server
// remains the only thing that decides whether a token is good; this is
// purely so the app can get ahead of it and say something useful.
function tokenExpiresAt(token) {
  try {
    let seg = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (seg.length % 4) seg += '=';
    const exp = JSON.parse(atob(seg)).exp;
    return exp ? exp * 1000 : 0;
  } catch { return 0; }
}

// Five minutes' notice. Worth having precisely BECAUSE the logout is now
// automatic: being dropped mid-cart with no warning would lose the cart.
const SESSION_WARN_MS = 5 * 60 * 1000;
let sessionTimer = null;
let sessionWarned = false;
let sessionWatching = false;

function checkSession() {
  clearTimeout(sessionTimer);
  const token = getToken();
  if (!token) return;                       // already signed out
  const endsAt = tokenExpiresAt(token);
  if (!endsAt) return;                      // unreadable; the server still decides

  const left = endsAt - Date.now();
  if (left <= 0) return endSession(SESSION_ENDED.EXPIRED);

  if (left <= SESSION_WARN_MS && !sessionWarned && document.body) {
    sessionWarned = true;
    toastMsg('Your session ends in a few minutes',
      'You will need to sign in again. Anything you submit before then still goes through.', 'error');
  }

  // Re-check at the expiry moment, or in 30 seconds, whichever is sooner.
  // Never one long sleep, for two separate reasons: setTimeout silently
  // fires IMMEDIATELY past about 24.8 days, which a 30-day leader session
  // would sail straight through, and a device that sleeps does not run
  // timers at all while it is asleep.
  sessionTimer = setTimeout(checkSession, Math.min(left, 30000));
}

// The events matter as much as the timer. A tablet that slept through the
// expiry wakes up with a dead token and no timer having fired, so the
// check runs again the moment the page is looked at.
function watchSession() {
  if (sessionWatching) return;
  sessionWatching = true;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSession(); });
  window.addEventListener('focus', checkSession);
  window.addEventListener('pageshow', checkSession);   // back/forward cache
  checkSession();
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
      if (hadToken) {
        // The server says no, and deliberately says only "Unauthorized" to
        // everybody. Which kind of no it is gets decided from the token we
        // still hold: past its own exp means the clock ran out; still in
        // date means something about the account changed underneath us — a
        // password reset, a role change, an admin signing them out
        // everywhere. Read locally rather than asking the API to explain
        // itself to an unauthenticated caller.
        const endsAt = tokenExpiresAt(getToken());
        endSession(!endsAt || endsAt <= Date.now()
          ? SESSION_ENDED.EXPIRED : SESSION_ENDED.REVOKED);
        return { data: null, error: 'Session expired' };
      }
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
  const token = getToken();
  if (!p || !token) { window.location.href = '/index.html'; return null; }

  // The tablet that sat on the counter all night lands here. Catching it
  // at page load means the login screen explains itself, instead of the
  // first tap on a button doing it half a second later.
  const endsAt = tokenExpiresAt(token);
  if (endsAt && endsAt <= Date.now()) { endSession(SESSION_ENDED.EXPIRED); return null; }

  if (roles.length && !roles.includes(p.role)) { window.location.href = '/index.html'; return null; }

  // Every authenticated page calls requireLogin, which makes it the one
  // place the watcher has to be started from.
  watchSession();
  return p;
}

// ── Formatting helpers ───────────────────────────────────
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

// ── Branding ────────────────────────────────────────────
// Two sources, deliberately, in this order:
//
//   1. The constants in js/config.js — always available, including on the
//      login page where nobody is authenticated yet. These are the
//      fallback and the anti-flash value.
//   2. app_settings.app_display_name / org_display_name from the database
//      — what Admin → Settings actually edits. Fetched once after sign-in
//      and cached in localStorage, so every later page load paints the
//      right name immediately rather than flashing the old one.
//
// Before this existed, renaming the app in Admin → Settings changed the
// setting and nothing on screen, because the markup was filled purely
// from the compile-time constants.
const BRAND_CACHE_KEY = 'assets.brand';

function _cachedBrand() {
  try { return JSON.parse(localStorage.getItem(BRAND_CACHE_KEY) || 'null'); }
  catch { return null; }
}

// "…and Rodeo" → "…and Rodeo™", without ever doubling it up.
function orgWithMark(org) {
  const s = String(org || '').trim();
  if (!s || /[™®]\s*$/.test(s)) return s;
  return /rodeo$/i.test(s) ? s + '™' : s;
}

function applyBrand(brand) {
  const b = brand || {};
  const name = b.app_display_name || APP_NAME;
  // No separate short name in the database: a short name that drifts from
  // the real one is worse than a slightly long header.
  const short = b.app_display_name || APP_SHORT;
  // The show's name is a registered mark. The database value is edited by
  // hand in Admin → Settings and will not always carry the symbol, so add
  // it here rather than relying on whoever typed it last.
  const org = orgWithMark(b.org_display_name || APP_ORG);

  const map = { 'data-app-name': name, 'data-app-short': short, 'data-app-org': org };
  for (const [attr, val] of Object.entries(map)) {
    document.querySelectorAll(`[${attr}]`).forEach(el => { el.textContent = val; });
  }
  if (document.title.includes('{{app}}')) document.title = document.title.replace('{{app}}', name);
  // Keep the manifest's name in step so an installed PWA does not keep the
  // old label on the home screen.
  const mt = document.querySelector('meta[name="application-name"]');
  if (mt) mt.setAttribute('content', name);
}

function brandPage() { applyBrand(_cachedBrand()); }

// Refreshes the cache from the server. Cheap, and only meaningful once
// signed in — the login page has no token and simply keeps the constants.
async function refreshBrand() {
  try {
    const { data } = await api('/settings');
    if (!data) return;
    const brand = {
      app_display_name: data.app_display_name || null,
      org_display_name: data.org_display_name || null,
    };
    localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(brand));
    applyBrand(brand);
  } catch { /* offline or signed out: the cached/constant name stands */ }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', brandPage);
else brandPage();

// Pull the live name shortly after paint, so an admin's rename reaches
// every other page on its next load without anyone clearing a cache.
if (typeof window !== 'undefined') {
  // getToken() is the single accessor for the JWT — never re-derive the
  // storage key here, it has been wrong once already.
  setTimeout(() => { if (typeof getToken === 'function' && getToken()) refreshBrand(); }, 50);
}

// Register the service worker on every page.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ── Client-side application/error logging ─────────────────────
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
