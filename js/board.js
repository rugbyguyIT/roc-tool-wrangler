// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — the leadership board.
//
// The one screen leadership will actually open, usually on a phone, from
// a home-screen icon, often while walking. Design rules that follow from
// that: no actions, big numbers, overdue in red and impossible to miss,
// the borrower's phone number tappable, and a view that keeps working
// when the wifi drops.
// ─────────────────────────────────────────────────────────────
const me = requireLogin('leader', 'staff', 'admin');
let REPAIRS = [];

const POLL_MS = 60000;
let ROWS = [];
let STATS = {};
let FILTER = { overdue: false, category: null, sub_committee: null };
let SEARCH = '';
let pollTimer = null;

// ── Kiosk mode ──────────────────────────────────────
// The same board, sized for a screen on a wall that nobody is standing at.
// Three differences, and they all follow from "nobody is standing at it":
//
//   · No phone numbers. This hangs in a shed people walk through, and a
//     volunteer's mobile number is not wall material. It is one tap away
//     on the ordinary board for anyone who actually needs to ring them.
//   · How long each item has been held, spelled out.
//   · A live countdown to due, because a static "due 6:00 PM" is a sum
//     you have to do in your head from across the room.
//
// The state lives in the URL (?kiosk=1) so a display can be pointed
// straight at it and survive a reboot, a refresh or the 60-second poll.
let KIOSK = new URLSearchParams(location.search).get('kiosk') === '1';

function setKiosk(on) {
  KIOSK = on;
  document.body.classList.toggle('kiosk', on);
  const u = new URL(location.href);
  if (on) u.searchParams.set('kiosk', '1'); else u.searchParams.delete('kiosk');
  history.replaceState(null, '', u);
  renderAll();
  // Wake the screen's data as soon as it becomes a display, rather than
  // showing whatever was on it up to a minute ago.
  if (on) refresh();
}

(function injectKioskStyles() {
  if (document.getElementById('kiosk-styles')) return;
  const s = document.createElement('style');
  s.id = 'kiosk-styles';
  s.textContent = `
    /* Chrome nobody can click from across a room. */
    body.kiosk .topnav,
    body.kiosk .site-footer,
    body.kiosk .board-search,
    body.kiosk #board-search,
    body.kiosk .topbar-actions .btn { display:none !important; }
    body.kiosk .main-panel { max-width:none; padding:18px 26px 26px; }
    body.kiosk .topbar { padding:16px 26px; }
    body.kiosk .page-title { font-size:34px }
    body.kiosk .page-sub { font-size:15px }
    /* Read from a distance: everything one step up in size. */
    body.kiosk .stat-num { font-size:52px }
    body.kiosk .stat-label { font-size:13px }
    body.kiosk .event-title { font-size:19px }
    body.kiosk .event-meta { font-size:15px; gap:16px }
    body.kiosk .event-meta-item i { font-size:13px }
    body.kiosk .ec-body { padding:20px 24px 18px }
    /* Two columns once there is room, so a full shed fits on one screen
       instead of scrolling past the bottom where nobody can reach it. */
    @media (min-width:1200px) {
      body.kiosk #feed { display:grid; grid-template-columns:1fr 1fr; gap:0 16px; align-items:start }
    }
    @media (min-width:1900px) {
      body.kiosk #feed { grid-template-columns:1fr 1fr 1fr }
    }
    body.kiosk .kiosk-exit {
      position:fixed; right:14px; bottom:14px; z-index:50; opacity:.35;
    }
    body.kiosk .kiosk-exit:hover { opacity:1 }
    body:not(.kiosk) .kiosk-exit { display:none }
  `;
  document.head.appendChild(s);
})();

function renderStats() {
  const tiles = [
    { n: STATS.out_now, label: 'Out now', icon: 'fa-person-walking-luggage', color: 'var(--orange)' },
    { n: STATS.overdue, label: 'Overdue', icon: 'fa-triangle-exclamation', color: 'var(--red)' },
    { n: STATS.available, label: 'Available', icon: 'fa-circle-check', color: 'var(--green)' },
    { n: STATS.maintenance, label: 'Maintenance', icon: 'fa-screwdriver-wrench', color: 'var(--amber)' },
  ];
  document.getElementById('stats').innerHTML = tiles.map(t => `
    <div class="stat-card" style="border-top-color:${t.color}">
      <div class="stat-num mono">${t.n ?? '—'}</div>
      <div class="stat-label"><i class="fa-solid ${t.icon}"></i> ${t.label}</div>
    </div>`).join('');
}

function renderFilters() {
  const cats = [...new Set(ROWS.map(r => r.category).filter(Boolean))].sort();
  const subs = [...new Set(ROWS.map(r => r.sub_committee).filter(Boolean))].sort();
  const chip = (label, on, handler, danger) =>
    `<div class="board-chip${on ? ' on' : ''}${danger ? ' danger' : ''}" onclick="${handler}">${esc(label)}</div>`;

  let html = chip('All', !FILTER.overdue && !FILTER.category && !FILTER.sub_committee, 'clearFilters()');
  if (STATS.overdue) {
    html += chip(`Overdue (${STATS.overdue})`, FILTER.overdue, 'toggleOverdue()', true);
  }
  html += cats.map(c => chip(c, FILTER.category === c, `setCategory('${esc(c).replace(/'/g, "\\'")}')`)).join('');
  if (subs.length > 1) {
    html += subs.slice(0, 8).map(s => chip(s, FILTER.sub_committee === s, `setSub('${esc(s).replace(/'/g, "\\'")}')`)).join('');
  }
  document.getElementById('filters').innerHTML = html;
}

function clearFilters() { FILTER = { overdue: false, category: null, sub_committee: null }; renderAll(); }
function toggleOverdue() { FILTER.overdue = !FILTER.overdue; renderAll(); }
function setCategory(c) { FILTER.category = FILTER.category === c ? null : c; renderAll(); }
function setSub(s) { FILTER.sub_committee = FILTER.sub_committee === s ? null : s; renderAll(); }

// Filtering is client-side: at peak this is a few hundred open items, and
// keeping it local means the chips respond instantly and keep working
// when the connection doesn't.
function visibleRows() {
  const q = SEARCH.toLowerCase();
  return ROWS.filter(r => {
    if (FILTER.overdue && !r.overdue) return false;
    if (FILTER.category && r.category !== FILTER.category) return false;
    if (FILTER.sub_committee && r.sub_committee !== FILTER.sub_committee) return false;
    if (!q) return true;
    return [r.asset_title, r.asset_tag, r.loanee_name, r.sub_committee, r.category, r.serial]
      .filter(Boolean).some(v => String(v).toLowerCase().includes(q));
  });
}

function renderFeed() {
  const rows = visibleRows();
  const feed = document.getElementById('feed');
  if (!rows.length) {
    feed.innerHTML = `<div class="card"><div style="padding:34px 10px;text-align:center">
      <i class="fa-solid fa-circle-check" style="font-size:30px;color:var(--green);margin-bottom:12px;display:block"></i>
      <div style="font-weight:600">${ROWS.length ? 'Nothing matches that filter.' : 'Nothing is checked out right now.'}</div>
      ${ROWS.length ? '<div class="small muted" style="margin-top:6px">Tap “All” to clear it.</div>' : ''}
    </div></div>`;
    return;
  }
  feed.innerHTML = rows.map(v => {
    const card = openItemCard(v, null, { hidePhone: KIOSK, countdown: KIOSK });
    return v.overdue ? card.replace('class="event-card"', 'class="event-card is-overdue"') : card;
  }).join('');
  // Re-render wipes the previous countdown elements, so the ticker is
  // re-pointed at the new ones every time the feed is rebuilt.
  if (KIOSK) startCountdowns();
}

function renderRepairs() {
  const el = document.getElementById('repair-feed');
  if (!el) return;
  const rows = REPAIRS || [];
  if (!rows.length) { el.innerHTML = ''; return; }

  el.innerHTML = `
    <div style="margin:22px 0 10px;display:flex;align-items:center;gap:10px">
      <i class="fa-solid fa-screwdriver-wrench" style="color:var(--amber)"></i>
      <div style="font-weight:600">At repair</div>
      <span class="badge badge-neutral">${rows.length}</span>
    </div>
    ${rows.map(r => {
      const days = r.days_out != null ? Math.floor(r.days_out) : null;
      return `<div class="event-card${r.overdue ? ' is-overdue' : ''}">
        <div style="display:flex;justify-content:space-between;gap:12px">
          <div>
            <div style="font-weight:600">${esc(r.asset_tag)} — ${esc(r.asset_title || '')}</div>
            <div class="small muted">${esc(r.reported_fault || '')}</div>
            <div class="small" style="margin-top:4px">
              <i class="fa-solid fa-screwdriver-wrench"></i> ${esc(r.shop_name || 'Unassigned')}
            </div>
          </div>
          <div style="text-align:right;white-space:nowrap">
            <div class="small muted">${days != null ? days + ' day' + (days === 1 ? '' : 's') : ''}</div>
            ${r.overdue ? '<div class="small" style="color:var(--red)">Overdue back</div>' : ''}
          </div>
        </div>
      </div>`;
    }).join('')}`;
}

function renderAll() { renderStats(); renderFilters(); renderFeed(); renderRepairs(); }

async function refresh(manual) {
  const icon = document.getElementById('refresh-icon');
  if (manual) icon.classList.add('fa-spin');
  const [{ data, error }, rep] = await Promise.all([
    api('/loans/open'),
    // Failure here must not blank the loan board, so it is tolerated
    // separately rather than sharing the error path below.
    api('/repairs?state=open').catch(() => ({ data: null })),
  ]);
  if (rep && rep.data) REPAIRS = rep.data.rows || [];
  if (manual) setTimeout(() => icon.classList.remove('fa-spin'), 400);

  if (error) {
    // Keep whatever is on screen — a leader out of coverage is better
    // served by slightly stale numbers than by an empty page.
    document.body.classList.add('is-offline');
    // Say which of the two it actually is. Reporting a server error as
    // "no connection" sends people to check their wifi when the fault is
    // ours, and they have no way to tell the difference from the banner.
    const note = document.getElementById('board-offline-text');
    if (note) {
      note.textContent = navigator.onLine
        ? `Couldn't reach the server (${error}) — showing the last data loaded.`
        : 'No connection — showing the last data loaded.';
    }
    if (manual) toastMsg('Could not refresh', error, 'error');
    return;
  }
  document.body.classList.remove('is-offline');
  ROWS = data.rows || [];
  STATS = data.stats || {};
  document.getElementById('updated-at').textContent = new Date().toLocaleTimeString('en-US',
    { hour: 'numeric', minute: '2-digit' });
  renderAll();
}

(function init() {
  if (!me) return;
  document.getElementById('board-search').addEventListener('input', (e) => {
    SEARCH = e.target.value.trim();
    renderFeed();
  });

  // Added from here rather than the markup so the button and the mode it
  // toggles stay in one file.
  document.querySelector('.topbar-actions')?.insertAdjacentHTML('beforeend',
    `<button class="btn btn-sm" id="kiosk-btn" onclick="setKiosk(true)" title="Full-screen wall display">
       <i class="fa-solid fa-tv"></i> Kiosk</button>`);
  document.body.insertAdjacentHTML('beforeend',
    `<button class="btn btn-sm kiosk-exit" onclick="setKiosk(false)">
       <i class="fa-solid fa-xmark"></i> Exit kiosk</button>`);
  document.body.classList.toggle('kiosk', KIOSK);

  refresh();
  pollTimer = setInterval(refresh, POLL_MS);

  // Don't poll a screen nobody is looking at; refresh the moment they
  // come back to it, so the first thing they see is current.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearInterval(pollTimer); pollTimer = null; }
    else if (!pollTimer) { refresh(); pollTimer = setInterval(refresh, POLL_MS); }
  });
  window.addEventListener('online', () => refresh());
  window.addEventListener('offline', () => document.body.classList.add('is-offline'));
})();
