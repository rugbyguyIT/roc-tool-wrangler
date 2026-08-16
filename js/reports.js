// ──────────────────────────────────────────────────────────
// HLSR Asset Tracker — reports.
//
// Six reports, one shape. Each declares its endpoint, its table columns
// and its CSV columns; everything else — date range, loading, export —
// is shared. Adding a seventh report means adding one entry to REPORTS.
//
// The CSV is built from exactly the rows on screen (js/csv.js), so the
// export can never disagree with what the person is looking at.
// ──────────────────────────────────────────────────────────
const me = requireLogin('admin');

let CURRENT = 'out-now';
let ROWS = [];
let LOANEES_CACHE = [];

const cond = v => v ? String(v).replace(/_/g, ' ') : '';
const yesNo = v => (v ? 'Yes' : 'No');

const REPORTS = {
  'out-now': {
    label: 'Out now', icon: 'fa-person-walking-luggage',
    path: () => `/reports/out-now?${dateParams()}`,
    blurb: 'Everything signed out right now, overdue first.',
    columns: [
      { label: 'Item', html: r => `<b>${esc(r.asset_title)}</b><div class="small muted mono">${esc(r.asset_tag)}</div>` },
      { label: 'Category', html: r => esc(r.category || '—') },
      { label: 'With', html: r => `<b>${esc(r.loanee_name)}</b><div class="small muted">${esc(r.sub_committee || '')}</div>` },
      { label: 'Out since', html: r => `${esc(fmtWhen(r.checked_out_at))}<div class="small muted">${esc(fmtAgo(r.checked_out_at))}</div>` },
      { label: 'Due', html: r => r.due_at
          ? `<span style="${r.overdue ? 'color:var(--red);font-weight:700' : ''}">${esc(fmtWhen(r.due_at))}</span>`
          : '<span class="muted">Indefinite</span>' },
      { label: 'Status', html: r => statusBadge('checked_out', r.overdue) },
    ],
    csv: [
      { key: 'asset_tag', label: 'Asset tag' }, { key: 'asset_title', label: 'Item' },
      { key: 'category', label: 'Category' }, { key: 'serial', label: 'Serial' },
      { key: 'loanee_name', label: 'Loanee' }, { key: 'sub_committee', label: 'Sub-committee' },
      { key: 'position', label: 'Position' }, { key: 'loanee_email', label: 'Email' },
      { key: 'loanee_phone', label: 'Cell' },
      { key: 'checked_out_at', label: 'Checked out', fmt: csvDate },
      { key: 'due_at', label: 'Due', fmt: csvDate },
      { key: 'hours_out', label: 'Hours out' },
      { key: 'overdue', label: 'Overdue', fmt: yesNo },
      { key: 'hours_overdue', label: 'Hours overdue' },
      { key: 'checked_out_by_name', label: 'Checked out by' },
      { key: 'home_location', label: 'Home location' },
    ],
  },

  overdue: {
    label: 'Overdue', icon: 'fa-triangle-exclamation',
    path: () => `/reports/overdue?${dateParams()}`,
    blurb: 'Past due, oldest first. Chase from the top.',
    columns: [
      { label: 'Item', html: r => `<b>${esc(r.asset_title)}</b><div class="small muted mono">${esc(r.asset_tag)}</div>` },
      { label: 'With', html: r => `<b>${esc(r.loanee_name)}</b><div class="small muted">${esc(r.sub_committee || '')}</div>` },
      { label: 'Contact', html: r => r.loanee_phone
          ? `<a href="tel:${esc(r.loanee_phone)}">${esc(fmtPhone(r.loanee_phone))}</a>`
          : esc(r.loanee_email || '—') },
      { label: 'Was due', html: r => `<span style="color:var(--red);font-weight:700">${esc(fmtWhen(r.due_at))}</span>` },
      { label: 'Late by', html: r => `<span class="mono">${Math.round(r.hours_overdue)}h</span>` },
    ],
    csv: [
      { key: 'asset_tag', label: 'Asset tag' }, { key: 'asset_title', label: 'Item' },
      { key: 'loanee_name', label: 'Loanee' }, { key: 'sub_committee', label: 'Sub-committee' },
      { key: 'loanee_phone', label: 'Cell' }, { key: 'loanee_email', label: 'Email' },
      { key: 'checked_out_at', label: 'Checked out', fmt: csvDate },
      { key: 'due_at', label: 'Was due', fmt: csvDate },
      { key: 'hours_overdue', label: 'Hours overdue' },
      { key: 'checked_out_by_name', label: 'Checked out by' },
    ],
  },

  'by-loanee': {
    label: 'By person', icon: 'fa-user',
    path: () => `/reports/by-loanee?${dateParams()}${filterParam('loanee_id')}`,
    blurb: 'Everything a person has had, current and historical.',
    filters: () => loaneeFilter(),
    rollup: true,
    columns: [
      { label: 'Person', html: r => `<b>${esc(r.full_name)}</b><div class="small muted">${esc(r.sub_committee || '')}</div>` },
      { label: 'Item', html: r => `${esc(r.asset_title)}<div class="small muted mono">${esc(r.asset_tag)}</div>` },
      { label: 'Out', html: r => esc(fmtWhen(r.checked_out_at)) },
      { label: 'Back', html: r => r.checked_in_at ? esc(fmtWhen(r.checked_in_at)) : '<span class="badge badge-live">Still out</span>' },
      { label: 'Held', html: r => `<span class="mono">${r.hours_held}h</span>` },
      { label: 'Flags', html: r => [
          r.currently_overdue ? '<span class="badge badge-no">Overdue</span>' : '',
          r.returned_late ? '<span class="badge badge-pending">Returned late</span>' : '',
          r.in_condition && r.in_condition !== 'good' ? `<span class="badge badge-pending">${esc(cond(r.in_condition))}</span>` : '',
        ].join(' ') },
    ],
    csv: [
      { key: 'full_name', label: 'Loanee' }, { key: 'sub_committee', label: 'Sub-committee' },
      { key: 'position', label: 'Position' }, { key: 'email', label: 'Email' }, { key: 'phone_mobile', label: 'Cell' },
      { key: 'asset_tag', label: 'Asset tag' }, { key: 'asset_title', label: 'Item' }, { key: 'category', label: 'Category' },
      { key: 'checked_out_at', label: 'Checked out', fmt: csvDate },
      { key: 'due_at', label: 'Due', fmt: csvDate },
      { key: 'checked_in_at', label: 'Checked in', fmt: csvDate },
      { key: 'hours_held', label: 'Hours held' }, { key: 'state', label: 'State' },
      { key: 'currently_overdue', label: 'Currently overdue', fmt: yesNo },
      { key: 'returned_late', label: 'Returned late', fmt: yesNo },
      { key: 'out_condition', label: 'Condition out', fmt: cond },
      { key: 'in_condition', label: 'Condition in', fmt: cond },
      { key: 'in_notes', label: 'Return notes' }, { key: 'checked_out_by', label: 'Checked out by' },
    ],
  },

  'by-asset': {
    label: 'By asset', icon: 'fa-boxes-stacked',
    path: () => `/reports/by-asset?${dateParams()}${filterParam('asset_id')}`,
    blurb: 'The full custody chain — every hand an item has passed through.',
    filters: () => assetFilter(),
    columns: [
      { label: 'Item', html: r => `<b>${esc(r.title)}</b><div class="small muted mono">${esc(r.asset_tag)}</div>` },
      { label: 'Held by', html: r => r.loanee_name ? `<b>${esc(r.loanee_name)}</b><div class="small muted">${esc(r.sub_committee || '')}</div>` : '<span class="muted">Never issued</span>' },
      { label: 'Out', html: r => esc(fmtWhen(r.checked_out_at)) },
      { label: 'Back', html: r => r.checked_in_at ? esc(fmtWhen(r.checked_in_at)) : (r.checked_out_at ? '<span class="badge badge-live">Still out</span>' : '—') },
      { label: 'Held', html: r => r.hours_held != null ? `<span class="mono">${r.hours_held}h</span>` : '—' },
      { label: 'Condition back', html: r => esc(cond(r.in_condition) || '—') },
    ],
    csv: [
      { key: 'asset_tag', label: 'Asset tag' }, { key: 'title', label: 'Item' }, { key: 'serial', label: 'Serial' },
      { key: 'category', label: 'Category' }, { key: 'home_location', label: 'Home location' },
      { key: 'status', label: 'Current status' },
      { key: 'loanee_name', label: 'Held by' }, { key: 'sub_committee', label: 'Sub-committee' },
      { key: 'checked_out_at', label: 'Checked out', fmt: csvDate },
      { key: 'due_at', label: 'Due', fmt: csvDate },
      { key: 'checked_in_at', label: 'Checked in', fmt: csvDate },
      { key: 'hours_held', label: 'Hours held' },
      { key: 'returned_late', label: 'Returned late', fmt: yesNo },
      { key: 'out_condition', label: 'Condition out', fmt: cond },
      { key: 'in_condition', label: 'Condition in', fmt: cond },
      { key: 'in_notes', label: 'Return notes' },
      { key: 'checked_out_by', label: 'Checked out by' }, { key: 'checked_in_by', label: 'Checked in by' },
    ],
  },

  inventory: {
    label: 'Inventory', icon: 'fa-warehouse',
    path: () => `/reports/inventory`,
    blurb: 'What you own, by category and location. Totals are rolled up.',
    columns: [
      { label: 'Category', html: r => r.g_category ? '<b>ALL CATEGORIES</b>' : `<b>${esc(r.category)}</b>` },
      { label: 'Location', html: r => r.g_location ? '<span class="muted">— all —</span>' : esc(r.location) },
      { label: 'Total', html: r => `<span class="mono">${r.asset_count}</span>` },
      { label: 'Available', html: r => `<span class="mono" style="color:var(--green)">${r.available}</span>` },
      { label: 'Out', html: r => `<span class="mono" style="color:var(--orange)">${r.checked_out}</span>` },
      { label: 'Maintenance', html: r => `<span class="mono" style="color:var(--amber)">${r.maintenance}</span>` },
      { label: 'Retired', html: r => `<span class="mono muted">${r.retired}</span>` },
      { label: 'Value', html: r => r.total_value ? `<span class="mono">$${Number(r.total_value).toLocaleString()}</span>` : '—' },
    ],
    csv: [
      { key: 'category', label: 'Category' }, { key: 'location', label: 'Location' },
      { key: 'asset_count', label: 'Total' }, { key: 'available', label: 'Available' },
      { key: 'checked_out', label: 'Checked out' }, { key: 'maintenance', label: 'Maintenance' },
      { key: 'retired', label: 'Retired' }, { key: 'total_value', label: 'Total value' },
    ],
  },

  activity: {
    label: 'Activity', icon: 'fa-clock-rotate-left',
    path: () => `/reports/activity?${dateParams()}`,
    blurb: 'Every recorded action, newest first.',
    columns: [
      { label: 'When', html: r => `<span class="mono small">${esc(fmtWhen(r.created_at))}</span>` },
      { label: 'What', html: r => `${esc((EVENT_META[r.event]?.text(r)) || r.event)}` },
      { label: 'Item', html: r => `${esc(r.asset_title)}<div class="small muted mono">${esc(r.asset_tag)}</div>` },
      { label: 'Person', html: r => esc(r.loanee_name || '—') },
      { label: 'By', html: r => `${esc(r.actor_name || 'System')}<div class="small muted">${esc(r.actor_role || '')}</div>` },
      { label: 'Reason', html: r => esc(r.reason || '') },
    ],
    csv: [
      { key: 'created_at', label: 'When', fmt: csvDate },
      { key: 'event', label: 'Event' }, { key: 'asset_tag', label: 'Asset tag' },
      { key: 'asset_title', label: 'Item' }, { key: 'loanee_name', label: 'Loanee' },
      { key: 'actor_name', label: 'By' }, { key: 'actor_role', label: 'Role' },
      { key: 'reason', label: 'Reason' },
    ],
  },
};

// ── Date range ────────────────────────────────────────────
function dateParams() {
  const p = new URLSearchParams();
  const from = document.getElementById('r-from').value;
  const to = document.getElementById('r-to').value;
  if (from) p.set('from', new Date(`${from}T00:00:00`).toISOString());
  // "To" is inclusive of the whole day, which is what a person means when
  // they pick a date — an exclusive bound would silently drop the last day.
  if (to) { const d = new Date(`${to}T00:00:00`); d.setDate(d.getDate() + 1); p.set('to', d.toISOString()); }
  return p.toString();
}
function setRange(kind) {
  const now = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  const from = document.getElementById('r-from');
  const to = document.getElementById('r-to');
  if (kind === 'all') { from.value = ''; to.value = ''; }
  else if (kind === 'today') { from.value = iso(now); to.value = iso(now); }
  else if (kind === 'week') { const d = new Date(now); d.setDate(d.getDate() - 7); from.value = iso(d); to.value = iso(now); }
  else if (kind === 'month') { const d = new Date(now); d.setDate(d.getDate() - 30); from.value = iso(d); to.value = iso(now); }
  else if (kind === 'season') {
    // The HLSR season runs roughly Feb–Mar; "season to date" means since
    // the start of the current show year, which begins the previous autumn.
    const year = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
    from.value = `${year}-09-01`; to.value = iso(now);
  }
  load();
}

// ── Per-report filters ──────────────────────────────────────
let FILTER_VALUE = '';
function filterParam(name) {
  return FILTER_VALUE ? `&${name}=${encodeURIComponent(FILTER_VALUE)}` : '';
}
function loaneeFilter() {
  return `<div class="card card-sm" style="margin-bottom:14px">
    <div class="form-group" style="margin:0">
      <label class="form-label">Narrow to one person (optional)</label>
      <select class="form-input" id="r-filter" onchange="onFilterChange()">
        <option value="">Everyone</option>
        ${LOANEES_CACHE.map(l => `<option value="${l.id}"${FILTER_VALUE === l.id ? ' selected' : ''}>${esc(l.full_name)}${l.sub_committee ? ` — ${esc(l.sub_committee)}` : ''}</option>`).join('')}
      </select>
    </div></div>`;
}
function assetFilter() {
  return `<div class="card card-sm" style="margin-bottom:14px">
    <div class="form-group" style="margin:0">
      <label class="form-label">Narrow to one asset (optional)</label>
      <input class="form-input" id="r-asset-q" placeholder="Type a tag or title, then pick from the list…"
             list="asset-list" onchange="onAssetPick(this.value)" />
      <datalist id="asset-list"></datalist>
    </div></div>`;
}
function onFilterChange() {
  FILTER_VALUE = document.getElementById('r-filter').value;
  load();
}
async function onAssetPick(v) {
  const { data } = await api(`/assets?q=${encodeURIComponent(v)}&limit=1`);
  FILTER_VALUE = data?.rows?.[0]?.id || '';
  load();
}

// ── Rendering ─────────────────────────────────────────────
function renderTabs() {
  document.getElementById('report-tabs').innerHTML = Object.entries(REPORTS).map(([k, r]) =>
    `<button class="btn btn-sm nav-item${k === CURRENT ? ' active' : ''}" onclick="setReport('${k}')">
       <i class="fa-solid ${r.icon}"></i> ${r.label}</button>`).join('');
}
function setReport(k) {
  CURRENT = k;
  FILTER_VALUE = '';
  renderTabs();
  load();
}

// A per-person summary computed from the SAME rows as the detail table,
// so the two can never disagree and there is no second query.
function rollupHtml() {
  const by = new Map();
  for (const r of ROWS) {
    const k = r.loanee_id;
    if (!by.has(k)) by.set(k, { name: r.full_name, sub: r.sub_committee, n: 0, out: 0, late: 0, hours: 0 });
    const e = by.get(k);
    e.n++;
    if (r.state === 'out') e.out++;
    if (r.returned_late || r.currently_overdue) e.late++;
    e.hours += Number(r.hours_held) || 0;
  }
  const rows = [...by.values()].sort((a, b) => b.n - a.n).map(e => `
    <tr>
      <td><b>${esc(e.name)}</b><div class="small muted">${esc(e.sub || '')}</div></td>
      <td class="mono">${e.n}</td>
      <td class="mono">${e.out || ''}</td>
      <td class="mono" style="${e.late ? 'color:var(--red);font-weight:700' : ''}">${e.late || ''}</td>
      <td class="mono">${Math.round(e.hours)}h</td>
    </tr>`).join('');
  return `<div class="card" style="padding:8px 14px 4px;margin-bottom:16px;overflow-x:auto">
    <table class="tbl">
      <thead><tr><th>Person</th><th>Items borrowed</th><th>Still out</th><th>Late</th><th>Total hours</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function render() {
  const r = REPORTS[CURRENT];
  document.getElementById('page-sub').textContent = `${r.blurb} · ${ROWS.length} row${ROWS.length === 1 ? '' : 's'}`;
  document.getElementById('report-filters').innerHTML = r.filters ? r.filters() : '';

  if (!ROWS.length) {
    document.getElementById('report-body').innerHTML =
      `<div class="card"><div style="padding:34px;text-align:center">
        <i class="fa-solid ${r.icon}" style="font-size:28px;color:var(--muted2);display:block;margin-bottom:10px"></i>
        <div style="font-weight:600">Nothing to show for this period.</div>
        <div class="small muted" style="margin-top:6px">Try widening the date range.</div>
      </div></div>`;
    return;
  }

  const head = r.columns.map(c => `<th>${c.label}</th>`).join('');
  const body = ROWS.map(row =>
    `<tr>${r.columns.map(c => `<td>${c.html(row)}</td>`).join('')}</tr>`).join('');

  document.getElementById('report-body').innerHTML =
    `${r.rollup ? rollupHtml() : ''}
     <div class="card" style="padding:8px 14px 4px;overflow-x:auto">
       <table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
     </div>`;
}

async function load() {
  const r = REPORTS[CURRENT];
  document.getElementById('report-body').innerHTML = '<div class="card"><div class="small muted" style="padding:24px;text-align:center">Loading…</div></div>';
  const { data, error } = await api(r.path());
  if (error) {
    document.getElementById('report-body').innerHTML =
      `<div class="card"><div class="small" style="padding:24px;color:var(--red)">${esc(error)}</div></div>`;
    return;
  }
  ROWS = data.rows || [];
  render();
}

function doExport() {
  exportRows(CURRENT, ROWS, REPORTS[CURRENT].csv);
}

// ── Boot ───────────────────────────────────────────────────
(async function init() {
  if (!me) return;
  renderTabs();
  setRange('month');

  ['r-from', 'r-to'].forEach(id => document.getElementById(id).addEventListener('change', load));

  const { data } = await api('/loanees?limit=500');
  LOANEES_CACHE = data?.rows || [];
})();
