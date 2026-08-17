// ═══════════════════════════════════════════════════════════════════════
// Loanees — the whole roster, on its own page.
//
// 493 people is too many for a section buried in the admin console, and
// too many to render at once. So: 25 at a time by default, alphabetical by
// last name (which is how anyone looks for a person), with the page size
// under the reader's control.
//
// The form and the row actions come from js/loanee-form.js, shared with
// the admin console, so a loanee record has one definition.
// ═══════════════════════════════════════════════════════════════════════
const me = requireLogin('staff', 'admin');

const PAGE_SIZES = [25, 50, 100, 250, 500];
let LN = { q: '', groupId: '', status: 'active', limit: 25, offset: 0, total: 0 };
let GROUPS = [];

async function loadGroups() {
  const { data } = await api('/groups');
  GROUPS = (data && data.rows) || [];
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
  });
  if (LN.q) p.set('q', LN.q);
  if (LN.groupId) p.set('group_id', LN.groupId);

  const { data, error } = await api(`/loanees?${p.toString()}`);
  if (error) { el.innerHTML = `<div class="small" style="color:var(--red)">${esc(error)}</div>`; return; }

  LN.total = data.total;
  const rows = data.rows || [];

  if (!rows.length) {
    el.innerHTML = `<div class="small muted" style="padding:28px;text-align:center">
      ${LN.q || LN.groupId
        ? 'Nobody matches that. Clear the filters to see everyone.'
        : 'No loanees yet. Sync the roster to load them all in one go.'}</div>`;
    renderPager();
    return;
  }

  el.innerHTML = `<div style="overflow-x:auto"><table class="tbl">
    <thead><tr>
      <th>Name</th><th>Member #</th><th>Contact</th><th>Title</th>
      <th>Committee</th><th>Groups</th><th>Out</th><th></th>
    </tr></thead>
    <tbody>${rows.map(l => `
      <tr>
        <td><b>${esc(l.full_name)}</b>${l.status === 'inactive'
          ? `<div class="small" style="color:var(--amber)">Inactive — ${esc(l.status_reason || 'deactivated')}</div>` : ''}</td>
        <td class="small mono">${esc(l.member_number || '—')}</td>
        <td class="small">${[l.email, l.phone_mobile && fmtPhone(l.phone_mobile)]
          .filter(Boolean).map(esc).join('<br>') || '<span class="muted">—</span>'}</td>
        <td class="small">${esc(l.title || l.position || '—')}</td>
        <td class="small">${esc(l.sub_committee || '—')}</td>
        <td class="small">${(l.group_names || []).map(g =>
          `<span class="class-chip class-exec">${esc(g)}</span>`).join(' ') || '<span class="muted">—</span>'}</td>
        <td>${l.items_out ? `<span class="badge badge-active">${l.items_out}</span>` : ''}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm" onclick="editLoanee('${l.id}')" title="Edit"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-sm" onclick="loaneeGroups('${l.id}')" title="Groups"><i class="fa-solid fa-user-lock"></i></button>
          <button class="btn btn-sm" onclick="loaneeHistory('${l.id}')" title="History"><i class="fa-solid fa-clock-rotate-left"></i></button>
          <button class="btn btn-sm btn-danger" onclick="deactivateLoanee('${l.id}','${esc(l.full_name)}')" title="Deactivate"><i class="fa-solid fa-user-slash"></i></button>
        </td>
      </tr>`).join('')}</tbody></table></div>`;

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

function setStatusFilter(v) {
  LN.status = v;
  LN.offset = 0;
  loadLoanees();
}

// ── Boot ───────────────────────────────────────────────────────────────
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
