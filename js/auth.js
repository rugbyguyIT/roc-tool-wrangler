// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — login page controller.
//
// One step: email + password. No identify round-trip, no OTP, no PIN —
// every account is created by an administrator, so there is nothing to
// branch on and no reason to make people wait for a lookup before they
// can type their password.
// ─────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function loginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.style.display = 'block';
  setBusy(false);
  return false;
}
function clearError() {
  document.getElementById('login-error').style.display = 'none';
}
function setBusy(on) {
  const btn = document.getElementById('login-btn');
  const label = document.getElementById('login-btn-label');
  btn.disabled = on;
  label.textContent = on ? 'Signing in…' : 'Sign In';
}
function togglePw() {
  const f = document.getElementById('password');
  const i = document.getElementById('pw-icon');
  const show = f.type === 'password';
  f.type = show ? 'text' : 'password';
  i.className = show ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye';
}

async function handleLogin(ev) {
  ev.preventDefault();
  clearError();
  // Whatever they typed. An "@" means it is an email address and is
  // lower-cased; anything else is a name and is sent as typed, because the
  // server matches names case- and space-insensitively and mangling it
  // here would only hide what was actually entered from the audit log.
  const typed = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!typed) return loginError('Please enter your name or email address.');
  if (!password) return loginError('Please enter your password.');

  const isEmail = typed.includes('@');
  if (isEmail && !EMAIL_RE.test(typed)) {
    return loginError('That does not look like a valid email address.');
  }

  setBusy(true);
  const { data, error } = await api('/auth/login', 'POST',
    isEmail ? { email: typed.toLowerCase(), password } : { name: typed, password });
  if (error) return loginError(error);

  saveSession(data.token, data.profile);
  window.location.href = data.portal || '/pages/board.html';
}

// Already signed in? Skip the form entirely and go straight to the portal
// for this role. Matters most for the leader PWA, which is launched from
// a home-screen icon and should open on the board, not a login screen.
(function autoRedirect() {
  const p = getProfile();
  if (!p || !getToken()) return;
  const portal = {
    admin: '/pages/admin.html',
    staff: '/pages/staff.html',
    leader: '/pages/board.html',
  }[p.role];
  if (portal) window.location.href = portal;
})();
