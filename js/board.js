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
    const card = openItemCard(v);
    return v.overdue ? card.replace('class="event-card"', 'class="event-card is-overdue"') : card;
  }).join('');
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
