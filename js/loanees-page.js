// ═════════════════════════════════════════════════════════════════════
// Committee Members — the whole roster, on its own page.
//
// 493 people is too many for a section buried in the admin console, and
// too many to render at once. So: 25 at a time by default, alphabetical by
// last name (which is how anyone looks for a person), with the page size
// under the reader's control.
//
// The form and the row actions come from js/loanee-form.js, shared with
// the admin console, so a member record has one definition.
// ═════════════════════════════════════════════════════════════════════
const me = requireLogin('staff', 'admin');

const PAGE_SIZES = [25, 50, 100, 250, 500];

// Alphabetical by last name, then first — the API's 'last_name' key sorts
// on both, so two Smiths come out in first-name order. This is the order
// on load and the order "Clear sorting" returns to.
const DEFAULT_SORT = { sort: 'last_name', dir: 'asc' };

let LN = { q: '', groupId: '', status: 'active', limit: 25, offset: 0, total: 0,
           ...DEFAULT_SORT,
           // Distinguishes "this is just the default" from "the reader
           // chose this", which is what decides whether Clear is offered.
           sorted: false,
           // Ticked committees. Empty means every committee, which is not
           // the same as "all of them ticked" — the roster gains committees
           // between page loads, and an explicit list would silently stop
           // including the new ones.
           committees: [] };
let COMMITTEES = null;   // [{name, n}] — loaded once, refreshed with status
let GROUPS = [];

// Selection survives paging: tick five people, go to page 2, tick five
// more, delete ten. Anything else is a trap when the list is 493 long.
let SELECTED = new Set();
let PAGE_IDS = [];      // ids in the order currently on screen
let LAST_CLICKED = null; // index of the last ticked row, for shift-range

// A Base member gets a name, a phone number and a title. The API enforces
// that; this only decides what the table draws, so the columns are REMOVED
// rather than rendered as a row of dashes. A column full of "—" reads as
// "we have no data on these people", which is a different and wrong thing
// to tell whoever is standing at the counter.
const IS_BASE = me && me.role === 'staff';

const COLUMNS = [
  { key: 'first_name',    label: 'First' },
  { key: 'last_name',     label: 'Last' },
  { key: 'member_number', label: 'Member #',  adminOnly: true },
  { key: 'email',         label: 'Email',     adminOnly: true },
  { key: 'phone_mobile',  label: 'Phone' },
  { key: 'title',         label: 'Title' },
  { key: 'sub_committee', label: 'Committee', filter: 'committees', adminOnly: true },
  { key: null,            label: 'Groups' },
  // No "Out" column. What is out is a question about equipment, and it is
  // answered on the Out Now board and the asset list. Repeating a count
  // here invited reading this page as a custody screen, which it isn't.
];

// ── Excel-style column filter (Committee) ──────────────────────
// The panel itself lives in js/assets-ui.js so the App Users role filter is
// literally the same control. This is only the committee data feeding it.

function filterButton(c) {
  return columnFilterButton('openCommitteeFilter(event)',
    LN.committees.length, 'Filter by committee');
}

async function loadCommittees(force) {
  if (COMMITTEES && !force) return COMMITTEES;
  const { data, error } = await api(`/loanees/committees?status=${encodeURIComponent(LN.status)}`);
  if (error) { toastMsg('Could not load committees', error, 'error'); return []; }
  COMMITTEES = data.rows || [];
  return COMMITTEES;
}

async function openCommitteeFilter(ev) {
  // The list has to be in hand before the panel can open, and the shared
  // opener needs the anchor element off the event — so capture it now. The
  // browser clears currentTarget as soon as this handler returns, which is
  // before the await below resolves.
  const anchor = ev.currentTarget;
  const list = await loadCommittees();
  openColumnFilter({ currentTarget: anchor, stopPropagation() {} }, {
    // '' is a real value here: the people with no committee at all.
    items: list.map(r => ({ value: r.name, label: r.name, n: r.n })),
    selected: LN.committees,
    allLabel: '(All committees)',
    placeholder: 'Search committees…',
    onApply: (values) => { LN.committees = values; LN.offset = 0; loadLoanees(); },
  });
}

async function loadGroups() {
  const { data } = await api('/groups');
  // /api/groups returns a bare array, not { rows }. Reading .rows off it
  // made GROUPS permanently empty, so the "Any group" filter never had a
  // single option in it and the page looked like it had no groups at all.
  GROUPS = Array.isArray(data) ? data : (data && data.rows) || [];
  const sel = document.getElementById('ln-group');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Any group</option>' +
    GROUPS.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  sel.value = current;
}

async function loadLoanees() {
  const el = document.getElementById('loanees-table');
  if (!el) return;

  const p = new URLSearchParams({
    limit: String(LN.limit), offset: String(LN.offset), status: LN.status,
    sort: LN.sort, dir: LN.dir,
  });
  if (LN.q) p.set('q', LN.q);
  if (LN.groupId) p.set('group_id', LN.groupId);
  // Repeated key, one per ticked committee. None ticked = no filter at all.
  // The people with no committee are asked for by name, because an empty
  // value on the wire is indistinguishable from an untouched control.
  LN.committees.forEach(c => p.append('sub_committee', c === '' ? '__none__' : c));

  const { data, error } = await api(`/loanees?${p.toString()}`);
  if (error) { el.innerHTML = `<div class="small" style="color:var(--red)">${esc(error)}</div>`; return; }

  LN.total = data.total;
  const rows = data.rows || [];

  if (!rows.length) {
    el.innerHTML = `<div class="small muted" style="padding:28px;text-align:center">
      ${LN.q || LN.groupId || LN.committees.length
        ? 'Nobody matches that. Clear the filters to see everyone.'
        : 'No committee members yet. Sync the roster to load them all in one go.'}</div>`;
    renderPager();
    return;
  }

  PAGE_IDS = rows.map(l => l.id);

  // A dropdown per column rather than click-to-sort. Click-to-sort hides
  // both what is sortable and which way it is going until you have already
  // clicked; a select states both from the moment the page loads.
  //
  // Only one column sorts at a time — the API takes a single key — so
  // choosing a direction anywhere clears every other column's selection.
  const head = COLUMNS.filter(c => !(c.adminOnly && IS_BASE)).map(c => {
    if (!c.key) return `<th>${c.label}</th>`;
    const active = LN.sort === c.key;
    return `<th class="th-sortable${active ? ' is-sorted' : ''}">
      <div class="th-label">${c.label}${active ? (LN.dir === 'asc' ? ' ▲' : ' ▼') : ''}${
        c.filter ? filterButton(c) : ''}</div>
      <select class="th-select" onchange="setSort('${c.key}', this.value)"
              title="Sort by ${c.label}">
        <option value=""${active ? '' : ' selected'}>Sort…</option>
        <option value="asc"${active && LN.dir === 'asc' ? ' selected' : ''}>Ascending</option>
        <option value="desc"${active && LN.dir === 'desc' ? ' selected' : ''}>Descending</option>
      </select>
    </th>`;
  }).join('');

  const allOnPageTicked = rows.length > 0 && rows.every(l => SELECTED.has(l.id));

  el.innerHTML = `<div style="overflow-x:auto"><table class="tbl">
    <thead><tr>
      <th style="width:34px"><input type="checkbox" ${allOnPageTicked ? 'checked' : ''}
        onclick="togglePage(this.checked)" title="Select everyone on this page" /></th>
      ${head}<th></th>
    </tr></thead>
    <tbody>${rows.map((l, i) => `
      <tr${SELECTED.has(l.id) ? ' class="is-selected"' : ''}>
        <td><input type="checkbox" ${SELECTED.has(l.id) ? 'checked' : ''}
          onclick="rowTick(event, ${i}, '${l.id}')" /></td>
        <td><b>${esc(l.first_name || '')}</b>${l.status === 'inactive'
          ? `<div class="small" style="color:var(--amber)">Inactive — ${esc(l.status_reason || 'deactivated')}</div>` : ''}</td>
        <td><b>${esc(l.last_name || '')}</b></td>
        ${IS_BASE ? '' : `<td class="small mono">${esc(l.member_number || '—')}</td>
        <td class="small">${l.email ? esc(l.email) : '<span class="muted">—</span>'}</td>`}
        <td class="small">${l.phone_mobile ? esc(fmtPhone(l.phone_mobile)) : '<span class="muted">—</span>'}</td>
        <td class="small">${esc(l.title || l.position || '—')}</td>
        ${IS_BASE ? '' : `<td class="small">${esc(l.sub_committee || '—')}</td>`}
        <td class="small">${(l.group_names || []).map(g =>
          `<span class="class-chip class-exec">${esc(g)}</span>`).join(' ') || '<span class="muted">—</span>'}</td>
        <td style="text-align:right;white-space:nowrap">
          ${IS_BASE ? '' : `<button class="btn btn-sm" onclick="editLoanee('${l.id}')" title="Edit"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-sm" onclick="loaneeGroups('${l.id}')" title="Groups"><i class="fa-solid fa-user-lock"></i></button>`}
          <button class="btn btn-sm" onclick="loaneeHistory('${l.id}')" title="History"><i class="fa-solid fa-clock-rotate-left"></i></button>
        </td>
      </tr>`).join('')}</tbody></table></div>`;

  renderSelectionBar();
  renderPager();
}

function renderPager() {
  const el = document.getElementById('ln-pager');
  if (!el) return;

  const from = LN.total === 0 ? 0 : LN.offset + 1;
  const to = Math.min(LN.offset + LN.limit, LN.total);
  const atStart = LN.offset === 0;
  const atEnd = to >= LN.total;
  const page = Math.floor(LN.offset / LN.limit) + 1;
  const pages = Math.max(1, Math.ceil(LN.total / LN.limit));

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px">
      <div class="small muted">
        ${LN.total ? `Showing <b>${from}–${to}</b> of <b>${LN.total}</b>` : 'Nothing to show'}
        ${pages > 1 ? ` · page ${page} of ${pages}` : ''}
      </div>
      <!-- Always present, disabled when there is nothing to clear. Showing
           it only once a non-default sort was chosen meant the control you
           needed was the one control that wasn't there — you had to already
           know it existed to go looking for it. -->
      <button class="btn btn-sm" ${LN.sorted ? '' : 'disabled'} onclick="clearSort()"
        title="Back to last name, then first">
        <i class="fa-solid fa-xmark"></i> Clear sorting</button>
      ${LN.sorted ? '<span class="small muted">back to last name, then first</span>' : ''}
      <div style="flex:1"></div>
      <div class="small muted">Per page</div>
      <select class="form-input" style="width:auto;padding:6px 10px" onchange="setPageSize(this.value)">
        ${PAGE_SIZES.map(n => `<option value="${n}"${n === LN.limit ? ' selected' : ''}>${n}</option>`).join('')}
      </select>
      <button class="btn btn-sm" ${atStart ? 'disabled' : ''} onclick="pageBy(-1)">
        <i class="fa-solid fa-chevron-left"></i> Previous</button>
      <button class="btn btn-sm" ${atEnd ? 'disabled' : ''} onclick="pageBy(1)">
        Next <i class="fa-solid fa-chevron-right"></i></button>
    </div>`;
}

function pageBy(dir) {
  const next = LN.offset + dir * LN.limit;
  if (next < 0 || next >= LN.total) return;
  LN.offset = next;
  loadLoanees();
  document.getElementById('loanees-table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Changing the page size keeps you near where you were rather than
// throwing you back to A — going 25 → 100 to see more of the S's should
// not send you to the top of the alphabet.
function setPageSize(n) {
  const firstVisible = LN.offset;
  LN.limit = parseInt(n, 10) || 25;
  LN.offset = Math.floor(firstVisible / LN.limit) * LN.limit;
  loadLoanees();
}

// ── Sorting ───────────────────────────────────────────
// The direction is chosen explicitly, so there is no hidden toggle state.
// Clearing the active column's select falls back to last name ascending
// rather than leaving the list in an undefined order.
function setSort(key, dir) {
  if (!dir) {
    if (LN.sort !== key) return;          // clearing an inactive column: no-op
    return clearSort();
  }
  LN.sort = key;
  LN.dir = dir === 'desc' ? 'desc' : 'asc';
  // Choosing the default column and direction is not really a sort — treat
  // it as cleared so the Clear button does not linger with nothing to do.
  LN.sorted = !(key === DEFAULT_SORT.sort && LN.dir === DEFAULT_SORT.dir);
  LN.offset = 0;
  LAST_CLICKED = null;    // ranges are meaningless once the order changes
  loadLoanees();
}

function clearSort() {
  Object.assign(LN, DEFAULT_SORT, { sorted: false, offset: 0 });
  LAST_CLICKED = null;
  loadLoanees();
}

// ── Selection ────────────────────────────────────────
function rowTick(ev, index, id) {
  // Shift extends from the last row you ticked, exactly like a file list.
  if (ev.shiftKey && LAST_CLICKED !== null) {
    const [lo, hi] = [Math.min(LAST_CLICKED, index), Math.max(LAST_CLICKED, index)];
    // The anchor's state decides the whole range, so shift-clicking can
    // deselect a block as well as select one.
    const turnOn = SELECTED.has(PAGE_IDS[LAST_CLICKED]);
    for (let i = lo; i <= hi; i++) {
      if (turnOn) SELECTED.add(PAGE_IDS[i]); else SELECTED.delete(PAGE_IDS[i]);
    }
  } else {
    if (SELECTED.has(id)) SELECTED.delete(id); else SELECTED.add(id);
    LAST_CLICKED = index;
  }
  loadLoanees();
}

function togglePage(on) {
  for (const id of PAGE_IDS) { if (on) SELECTED.add(id); else SELECTED.delete(id); }
  LAST_CLICKED = null;
  loadLoanees();
}

function clearSelection() { SELECTED.clear(); LAST_CLICKED = null; loadLoanees(); }

function renderSelectionBar() {
  const el = document.getElementById('ln-selection');
  if (!el) return;
  const n = SELECTED.size;
  if (!n) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="card card-sm" style="margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <b>${n} selected</b>
      <span class="small muted">Shift-click to select a range.</span>
      <div style="flex:1"></div>
      <button class="btn btn-sm" onclick="clearSelection()">Clear selection</button>
      <button class="btn btn-sm btn-danger" onclick="deleteSelected()">
        <i class="fa-solid fa-trash"></i> Delete ${n}</button>
    </div>`;
}

async function deleteSelected() {
  const ids = [...SELECTED];
  if (!ids.length) return;
  const ok = await typedDeleteModal(
    `Delete ${ids.length} ${ids.length === 1 ? 'person' : 'people'}?`,
    `<b>This removes ${ids.length} ${ids.length === 1 ? 'person' : 'people'} from the roster.</b>
     Anyone who has ever borrowed equipment is deactivated rather than deleted, so no
     check-out history is lost — everyone else is permanently removed.`,
    { submitLabel: `Delete ${ids.length}` });
  if (!ok) return;

  const { data, error } = await api('/loanees/bulk-delete', 'POST', { ids, confirm: 'DELETE' });
  if (error) return toastMsg('Could not delete', error, 'error');

  // Anyone with loan history is deactivated instead of deleted. Say so —
  // "delete" quietly meaning something else is how trust in a tool dies.
  const bits = [];
  if (data.deleted) bits.push(`${data.deleted} deleted`);
  if (data.deactivated) bits.push(`${data.deactivated} deactivated (they have loan history, so it was kept)`);
  toastMsg('Done', bits.join(' · '), 'ok');
  SELECTED.clear(); LAST_CLICKED = null;
  loadLoanees();
}

// ── Clear roster ──────────────────────────────────────
function clearRoster() {
  formModal('Clear the entire roster', `
    <div class="card card-sm" style="border-left:3px solid var(--red);margin-bottom:14px">
      <div class="small"><b>This removes every committee member.</b> Anyone who has ever been on a
      loan is deactivated rather than deleted, so no check-out history is lost — everyone
      else is permanently removed.</div>
    </div>
    <div class="form-group">
      <label class="form-label">PIN *</label>
      <input class="form-input" name="pin" type="password" inputmode="numeric"
             autocomplete="off" required placeholder="••••" />
    </div>
    <div class="form-group">
      <label class="form-label">Type DELETE to confirm *</label>
      <input class="form-input" name="confirm" autocomplete="off" placeholder="DELETE" required />
    </div>`,
    { icon: 'fa-triangle-exclamation', submitLabel: 'Clear the roster' })
    .then(async form => {
      if (!form) return;
      const pin = form.querySelector('[name="pin"]').value.trim();
      const confirm = form.querySelector('[name="confirm"]').value.trim();
      if (confirm !== 'DELETE') return toastMsg('Not confirmed', 'Type DELETE exactly.', 'error');

      const { data, error } = await api('/loanees/clear-roster', 'POST', { pin, confirm });
      if (error) return toastMsg('Roster not cleared', error, 'error');
      toastMsg('Roster cleared',
        `${data.deleted} deleted${data.deactivated ? ` · ${data.deactivated} kept as inactive for their loan history` : ''}`, 'ok');
      SELECTED.clear(); LAST_CLICKED = null; LN.offset = 0;
      loadLoanees();
    });
}

function setStatusFilter(v) {
  LN.status = v;
  LN.offset = 0;
  // The committee counts are per status, so they are now stale. Drop the
  // cache rather than showing active-roster counts over the inactive list.
  COMMITTEES = null;
  loadLoanees();
}

// ── Boot ───────────────────────────────
(async function () {
  brandPage();

  let t = null;
  document.getElementById('ln-q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { LN.q = e.target.value.trim(); LN.offset = 0; loadLoanees(); }, 250);
  });
  document.getElementById('ln-group').addEventListener('change', (e) => {
    LN.groupId = e.target.value; LN.offset = 0; loadLoanees();
  });

  await loadGroups();
  await loadLoanees();
})();
