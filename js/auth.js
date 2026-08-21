// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — login page controller.
//
// One step, one box for who you are and one for what you know. No
// identify round-trip, no OTP, no PIN — every account is created by an
// administrator, so there is nothing to branch on and no reason to make
// people wait for a lookup before they can type their password.
//
// Shared with 1932.html, which is the same form in a red coat. Both
// pages read the same element ids; api/test/swa-config.js asserts that
// they still do, because a renamed field here is a login page that
// silently cannot log anyone in.
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

// ── What the second box is called ────────────────────────
// Kyle: "the word password should change if they need to use their zip
// to login."
//
// He is right, and it is not cosmetic. A committee member's password IS
// their zip code — that is what the roster import set — so a box
// labelled "Password" is a box 493 people will stand at the counter
// trying to fill in with something nobody ever gave them. Naming the
// thing they actually have to type removes the whole question.
//
// The rule is the same one the server uses: an "@" means an email
// address, which means an admin, who has a real password. Everything
// else is a name. It reads ONLY what has been typed into the first box,
// so it reveals nothing about whether any account exists — this is a
// relabelling, not a lookup.
function pwWord() {
  const el = document.getElementById('password-label');
  return (el ? el.textContent : 'Password').toLowerCase();
}

function retitlePassword() {
  const typed = document.getElementById('email').value.trim();
  const label = document.getElementById('password-label');
  const field = document.getElementById('password');
  if (!label || !field) return;

  // An empty box makes no claim either way yet, so it keeps the neutral
  // wording rather than guessing at the person before they have typed.
  const zip = typed.length > 0 && !typed.includes('@');

  label.textContent = zip ? 'Zip code' : 'Password';
  field.placeholder = zip ? 'Your 5-digit zip code' : '••••••••••';
  // A numeric keypad is a real gain on a phone when the answer is five
  // digits, and actively wrong when it is a passphrase. This is why the
  // markup does not hardcode inputmode either way.
  field.inputMode = zip ? 'numeric' : 'text';
}

// Retitling on every keystroke flickers: the first four characters of
// "kyle@..." contain no "@", so the label would say "Zip code" and then
// change its mind. Settling for a moment, and immediately on the way out
// of the field, means it is correct by the time anyone looks at it.
function wireRetitle() {
  const f = document.getElementById('email');
  if (!f) return;
  let t = null;
  f.addEventListener('input', () => { clearTimeout(t); t = setTimeout(retitlePassword, 350); });
  f.addEventListener('blur', () => { clearTimeout(t); retitlePassword(); });
}

// ── Remembering who you are ────────────────────────────
// Kyle: "when logging in, it should auto populate your name."
//
// Only the identifier is stored. Never the password, never the zip —
// remembering a name saves typing; remembering a zip would mean the
// tablet itself could sign somebody in, which is the thing this app has
// consistently refused to build.
//
// It lives in localStorage on that one device. On a phone that is pure
// convenience. On the shared counter tablet it means the next person
// sees the last person's name already in the box, so "Not you?" sits
// right under the field and clears both the box and the memory. A name
// is not a secret here — any Base member can already see the whole
// roster's names — but it should still take one tap to be rid of.
const REMEMBER_KEY = 'roc.last_identity';

// Every access is guarded: Safari in private mode throws on localStorage
// rather than returning null, and a login page that throws before it
// paints is a login page nobody can use.
function rememberIdentity(typed) {
  try { localStorage.setItem(REMEMBER_KEY, typed); } catch { /* private mode */ }
}
function recallIdentity() {
  try { return localStorage.getItem(REMEMBER_KEY) || ''; } catch { return ''; }
}
function clearIdentity() {
  try { localStorage.removeItem(REMEMBER_KEY); } catch { /* private mode */ }
  const f = document.getElementById('email');
  const n = document.getElementById('not-you');
  if (f) { f.value = ''; f.focus(); }
  if (n) n.style.display = 'none';
  retitlePassword();
}

function prefillIdentity() {
  const f = document.getElementById('email');
  if (!f || f.value) return;
  const last = recallIdentity();
  if (!last) return;
  f.value = last;
  const n = document.getElementById('not-you');
  if (n) n.style.display = '';
  retitlePassword();
  // Straight to the only box they still have to fill in.
  document.getElementById('password')?.focus();
}

async function handleLogin(ev) {
  ev.preventDefault();
  clearError();
  // Whatever they typed. An "@" means it is an email address and is
  // lower-cased; anything else is a name and is sent as typed, because
  // the server matches names case- and space-insensitively and mangling
  // it here would only hide what was actually entered from the audit log.
  const typed = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  if (!typed) return loginError('Please enter your name or email address.');
  if (!password) return loginError(`Please enter your ${pwWord()}.`);

  const isEmail = typed.includes('@');
  if (isEmail && !EMAIL_RE.test(typed)) {
    return loginError('That does not look like a valid email address.');
  }

  setBusy(true);
  const { data, error } = await api('/auth/login', 'POST',
    isEmail ? { email: typed.toLowerCase(), password } : { name: typed, password });
  if (error) return loginError(error);

  // Only on the way in. A name that was just refused is not worth
  // offering back to whoever picks the tablet up next.
  rememberIdentity(typed);
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

// ── Why you are looking at this screen ──────────────────────
// Kyle: "auto log you out ... and a message of why."
//
// Landing on a login page you did not ask for reads as the app having
// broken. It is worth two sentences to say it did the opposite.
//
// Deliberate sign-out gets no note at all: pressing Sign out and then
// being told why you are signed out is the app explaining a thing you
// just did.
const ENDED_NOTES = {
  expired: {
    title: 'Your session ended.',
    body: 'Sign-ins do not stay open forever, so a tablet left on the counter '
        + 'cannot be picked up by the next person. Sign in again to carry on.',
  },
  revoked: {
    title: 'You were signed out.',
    body: 'Something about your account changed — a new password, a different role, '
        + 'or an admin signing you out everywhere. Signing in again should sort it.',
  },
};

function showEndedNote() {
  const params = new URLSearchParams(location.search);
  const note = ENDED_NOTES[params.get('ended')];

  // Strip it either way, including a value we do not recognise. A reason
  // in the address bar can be bookmarked, re-shown by a refresh, or typed
  // in by anyone; it has done its job the moment it is read once.
  if (params.has('ended')) {
    params.delete('ended');
    const q = params.toString();
    history.replaceState(null, '', location.pathname + (q ? `?${q}` : ''));
  }

  if (!note) return;
  const el = document.getElementById('login-note');
  if (!el) return;
  el.innerHTML = `<b>${esc(note.title)}</b> ${esc(note.body)}`;
  el.style.display = 'block';
}

// After the redirect check, so a signed-in visitor never sees the form
// flicker into a filled-in state on its way somewhere else.
wireRetitle();
prefillIdentity();
showEndedNote();
