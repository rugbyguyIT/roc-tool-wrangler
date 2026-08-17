// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — admin console.
// One page, seven sections, all rendered from the API. Nothing here
// bypasses a role check: every call it makes is admin-gated server-side.
// ─────────────────────────────────────────────────────────────
const me = requireLogin('admin');

let GROUPS = [];
let CATEGORIES = [];
let LOCATIONS = [];
let SETTINGS = {};
let lnDebounce = null;

// ══ Dashboard ══════════════════════════════════════════════════
async function loadDashboard() {
  const [open, assets, loanees, groups] = await Promise.all([
    api('/loans/open'), api('/assets?limit=1'), api('/loanees?limit=1'), api('/groups'),
  ]);
  const s = open.data?.stats || {};
  const tiles = [
    { n: assets.data?.total ?? '—', label: 'Assets', icon: 'fa-boxes-stacked', color: 'var(--navy)' },
    { n: s.out_now ?? '—', label: 'Out now', icon: 'fa-person-walking-luggage', color: 'var(--orange)' },
    { n: s.overdue ?? '—', label: 'Overdue', icon: 'fa-triangle-exclamation', color: 'var(--red)' },
    { n: s.maintenance ?? '—', label: 'Maintenance', icon: 'fa-screwdriver-wrench', color: 'var(--amber)' },
    { n: loanees.data?.total ?? '—', label: 'Loanees', icon: 'fa-users', color: 'var(--blue)' },
    { n: groups.data?.length ?? '—', label: 'Groups', icon: 'fa-user-lock', color: 'var(--green)' },
  ];
  document.getElementById('dash-stats').innerHTML = tiles.map(t => `
    <div class="stat-card" style="border-top-color:${t.color}">
      <div class="stat-num mono">${t.n}</div>
      <div class="stat-label"><i class="fa-solid ${t.icon}"></i> ${t.label}</div>
    </div>`).join('');

  const { data: act } = await api('/reports/activity?limit=15');
  document.getElementById('dash-activity').innerHTML = act && act.rows.length
    ? `<ul class="tline">${act.rows.map(e => eventLine({
        ...e, actor_name: e.actor_name, loanee_name: e.loanee_name,
      })).join('')}</ul>`
    : '<div class="small muted">Nothing has happened yet.</div>';
}

// ══ Loanees ════════════════════════════════════════════════════
async function loadLoanees() {
  const p = new URLSearchParams();
  const q = document.getElementById('ln-q').value.trim();
  if (q) p.set('q', q);
  const g = document.getElementById('ln-group').value;
  if (g) p.set('group_id', g);
  p.set('limit', '250');

  const { data, error } = await api(`/loanees?${p}`);
  const el = document.getElementById('loanees-table');
  if (error) { el.innerHTML = `<div class="small" style="color:var(--red)">${esc(error)}</div>`; return; }
  if (!data.rows.length) {
    el.innerHTML = `<div class="small muted" style="padding:20px;text-align:center">
      No loanees yet. Add one, or import your roster with the button above.</div>`;
    return;
  }
  el.innerHTML = `<div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Name</th><th>Member #</th><th>Contact</th><th>Title</th><th>Committee</th><th>Groups</th><th>Out</th><th></th></tr></thead>
    <tbody>${data.rows.map(l => `
      <tr>
        <td><b>${esc(l.full_name)}</b>${l.status === 'inactive'
            ? `<div class="small" style="color:var(--amber)">Inactive — ${esc(l.status_reason || 'deactivated')}</div>` : ''}</td>
        <td class="small mono">${esc(l.member_number || '—')}</td>
        <td class="small">${[l.email, l.phone_mobile && fmtPhone(l.phone_mobile)].filter(Boolean).map(esc).join('<br>') || '<span class="muted">—</span>'}</td>
        <td class="small">${esc(l.title || l.position || '—')}</td>
        <td class="small">${esc(l.sub_committee || '—')}</td>
        <td class="small">${(l.group_names || []).map(g => `<span class="class-chip class-exec">${esc(g)}</span>`).join(' ') || '<span class="muted">—</span>'}</td>
        <td>${l.items_out ? `<span class="badge badge-active">${l.items_out}</span>` : ''}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm" onclick="editLoanee('${l.id}')" title="Edit"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-sm" onclick="loaneeGroups('${l.id}')" title="Groups"><i class="fa-solid fa-user-lock"></i></button>
          <button class="btn btn-sm" onclick="loaneeHistory('${l.id}')" title="History"><i class="fa-solid fa-clock-rotate-left"></i></button>
          <button class="btn btn-sm btn-danger" onclick="deactivateLoanee('${l.id}','${esc(l.full_name)}')" title="Deactivate"><i class="fa-solid fa-user-slash"></i></button>
        </td>
      </tr>`).join('')}</tbody></table></div>
    <div class="small muted" style="margin-top:8px">${data.total} active loanee${data.total === 1 ? '' : 's'}</div>`;
}

// Loanee form + actions live in js/loanee-form.js, shared with the
// dedicated Loanees page.

// ══ Groups ═════════════════════════════════════════════════════
async function loadGroups() {
  const { data, error } = await api('/groups');
  if (error) return;
  GROUPS = data;
  const sel = document.getElementById('ln-group');
  const keep = sel.value;
  sel.innerHTML = '<option value="">Any group</option>';
  GROUPS.forEach(g => sel.add(new Option(g.name, g.id)));
  sel.value = keep;

  document.getElementById('groups-table').innerHTML = GROUPS.length
    ? `<div style="overflow-x:auto"><table class="tbl">
        <thead><tr><th>Group</th><th>Members</th><th>Restricted assets</th><th></th></tr></thead>
        <tbody>${GROUPS.map(g => `
          <tr>
            <td><b>${esc(g.name)}</b>${g.description ? `<div class="small muted">${esc(g.description)}</div>` : ''}
                ${g.active ? '' : '<span class="badge badge-neutral">Inactive</span>'}</td>
            <td><span class="badge badge-active">${g.member_count}</span></td>
            <td>${g.asset_count ? `<span class="badge badge-neutral">${g.asset_count}</span>` : '<span class="muted small">—</span>'}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn btn-sm" onclick="groupMembers('${g.id}')"><i class="fa-solid fa-users"></i> Members</button>
              <button class="btn btn-sm" onclick="openImport('group-members','${g.id}')" title="Import members"><i class="fa-solid fa-file-import"></i></button>
              <button class="btn btn-sm" onclick="editGroup('${g.id}')"><i class="fa-solid fa-pen"></i></button>
              <button class="btn btn-sm btn-danger" onclick="deleteGroup('${g.id}','${esc(g.name)}')"><i class="fa-solid fa-trash"></i></button>
            </td>
          </tr>`).join('')}</tbody></table></div>`
    : '<div class="small muted" style="padding:20px;text-align:center">No groups yet.</div>';
}

async function newGroup() {
  const form = await formModal('New group', `
    <div class="form-group"><label class="form-label">Name *</label>
      <input class="form-input" name="name" required placeholder="Forklift Certified" /></div>
    <div class="form-group"><label class="form-label">Description</label>
      <input class="form-input" name="description" placeholder="Who belongs in here and why" /></div>`,
    { icon: 'fa-plus', submitLabel: 'Create' });
  if (!form) return;
  const { error } = await api('/groups', 'POST', formValues(form));
  if (error) return toastMsg('Could not create it', error, 'error');
  toastMsg('Group created', '', 'ok');
  loadGroups();
}

async function editGroup(id) {
  const g = GROUPS.find(x => x.id === id);
  if (!g) return;
  const form = await formModal(`Edit ${g.name}`, `
    <div class="form-group"><label class="form-label">Name *</label>
      <input class="form-input" name="name" required value="${esc(g.name)}" /></div>
    <div class="form-group"><label class="form-label">Description</label>
      <input class="form-input" name="description" value="${esc(g.description || '')}" /></div>
    <label class="toggle-row"><span>Active</span>
      <input type="checkbox" name="active"${g.active ? ' checked' : ''} /></label>`,
    { icon: 'fa-pen' });
  if (!form) return;
  const { error } = await api(`/groups/${id}`, 'PATCH', formValues(form));
  if (error) return toastMsg('Could not save', error, 'error');
  loadGroups();
}

async function deleteGroup(id, name) {
  let ok = await confirmModal(`Delete the group "${name}"?`, { confirmLabel: 'Delete' });
  if (!ok) return;
  let res = await api(`/groups/${id}`, 'DELETE');
  // The API refuses the first time if assets depend on this group, and
  // tells us how many. Surfacing that number before the second, explicit
  // confirmation is the whole point.
  if (res.error && res.detail?.requires_confirm) {
    ok = await confirmModal(
      `${res.detail.asset_count} asset(s) are restricted to "${name}". Deleting it makes them borrowable by anyone.`,
      { title: 'This removes restrictions', confirmLabel: 'Delete anyway' });
    if (!ok) return;
    res = await api(`/groups/${id}?confirm=1`, 'DELETE');
  }
  if (res.error) return toastMsg('Could not delete', res.error, 'error');
  toastMsg('Group deleted', '', 'ok');
  loadGroups();
  loadLoanees();
}

async function groupMembers(id) {
  const g = GROUPS.find(x => x.id === id);
  const { data: members } = await api(`/groups/${id}/members`);
  const { data: assets } = await api(`/groups/${id}/assets`);
  const rows = (members || []).map(m => `
    <tr>
      <td><b>${esc(m.full_name)}</b><div class="small muted">${esc(m.sub_committee || '')}</div></td>
      <td class="small">${esc(m.email || '')}</td>
      <td style="text-align:right">
        <button class="btn btn-sm btn-danger" onclick="removeMember('${id}','${m.id}')"><i class="fa-solid fa-xmark"></i></button>
      </td>
    </tr>`).join('');

  await formModal(`${g.name}`, `
    <div class="section-title" style="font-size:14px"><i class="fa-solid fa-users"></i> Members (${(members || []).length})</div>
    <div style="max-height:280px;overflow-y:auto"><table class="tbl">
      <tbody>${rows || '<tr><td class="small muted">Nobody in this group yet.</td></tr>'}</tbody></table></div>
    <div class="pill-row" style="margin-top:12px">
      <button type="button" class="btn btn-sm" onclick="openImport('group-members','${id}')">
        <i class="fa-solid fa-file-import"></i> Import members from a spreadsheet</button>
    </div>
    <div class="section-title" style="font-size:14px;margin-top:22px"><i class="fa-solid fa-boxes-stacked"></i> Assets restricted to this group (${(assets || []).length})</div>
    ${(assets || []).length
      ? `<div style="max-height:200px;overflow-y:auto"><table class="tbl"><tbody>${assets.map(a => `
          <tr><td><b>${esc(a.title)}</b><div class="small muted mono">${esc(a.asset_tag)}</div></td>
              <td>${statusBadge(a.status)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="small muted">No assets are restricted to this group, so it currently does nothing.</div>'}`,
    { icon: 'fa-user-lock', submitLabel: 'Close', wide: true });
}

async function removeMember(groupId, loaneeId) {
  const { error } = await api(`/groups/${groupId}/members/${loaneeId}`, 'DELETE');
  if (error) return toastMsg('Could not remove', error, 'error');
  _closeUiModal();
  loadGroups();
  groupMembers(groupId);
}

// ══ App users ══════════════════════════════════════════════════
// 'staff' is the stored value; 'Base' is what everyone at the grounds
// calls it. Renaming the stored value would mean migrating the CHECK
// constraint, every JWT in circulation and every route guard for a
// wording change, so the mapping lives here instead.
const ROLE_LABEL = { admin: 'Administrator', staff: 'Base', leader: 'Leadership' };

async function loadUsers() {
  const { data, error } = await api('/users');
  if (error) return;
  document.getElementById('users-table').innerHTML = `<div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last signed in</th><th></th></tr></thead>
    <tbody>${data.map(u => `
      <tr${u.status === 'inactive' ? ' style="opacity:.55"' : ''}>
        <td><b>${esc(u.full_name)}</b>${u.status === 'inactive' ? ' <span class="badge badge-neutral">Disabled</span>' : ''}</td>
        <td class="small">${esc(u.email)}</td>
        <td><span class="class-chip ${u.role === 'admin' ? 'class-vip' : u.role === 'staff' ? 'class-exec' : 'class-performer'}">${ROLE_LABEL[u.role]}</span></td>
        <td class="small">${u.last_login_at ? esc(fmtWhen(u.last_login_at)) : '<span class="muted">Never</span>'}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm" onclick="editUser('${u.id}')" title="Edit"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-sm" onclick="resetPassword('${u.id}','${esc(u.full_name)}')" title="Reset password"><i class="fa-solid fa-key"></i></button>
          <button class="btn btn-sm" onclick="forceLogout('${u.id}','${esc(u.full_name)}')" title="Sign them out everywhere"><i class="fa-solid fa-power-off"></i></button>
          ${u.id !== me.id ? `<button class="btn btn-sm btn-danger" onclick="toggleUser('${u.id}','${u.status}','${esc(u.full_name)}')" title="${u.status === 'active' ? 'Disable' : 'Enable'}"><i class="fa-solid fa-${u.status === 'active' ? 'user-slash' : 'user-check'}"></i></button>` : ''}
        </td>
      </tr>`).join('')}</tbody></table></div>`;
}

function userFields(u) {
  u = u || {};
  return `
    <div class="form-row">
      <div class="form-group"><label class="form-label">First name *</label>
        <input class="form-input" name="first_name" required value="${esc(u.first_name || '')}" /></div>
      <div class="form-group"><label class="form-label">Last name *</label>
        <input class="form-input" name="last_name" required value="${esc(u.last_name || '')}" /></div>
    </div>
    <div class="form-group"><label class="form-label">Email *</label>
      <input class="form-input" name="email" type="email" required value="${esc(u.email || '')}" /></div>
    <div class="form-group"><label class="form-label">Cell</label>
      <input class="form-input" name="phone_mobile" value="${esc(u.phone_mobile || '')}" /></div>
    <div class="form-group"><label class="form-label">Role *</label>
      <select class="form-input" name="role" required>
        ${Object.entries(ROLE_LABEL).map(([v, l]) =>
          `<option value="${v}"${u.role === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      <div class="small muted" style="margin-top:6px">
        Administrators manage everything. Base members check equipment in and out.
        Leadership can only view what's out.
      </div>
    </div>`;
}

async function newUser() {
  const form = await formModal('Add user', userFields() + `
    <div class="form-group"><label class="form-label">Temporary password *</label>
      <input class="form-input" name="password" type="text" required minlength="10"
             value="${suggestPassword()}" />
      <div class="small muted" style="margin-top:6px">
        At least 10 characters. Give it to them directly — they can change it after signing in.
      </div></div>`,
    { icon: 'fa-user-plus', submitLabel: 'Create user' });
  if (!form) return;
  const v = formValues(form);
  const { error } = await api('/users', 'POST', v);
  if (error) return toastMsg('Could not create the user', error, 'error');
  toastMsg('User created', `${v.first_name} can sign in with ${v.email}.`, 'ok');
  loadUsers();
}

// Memorable but not guessable: three words plus digits beats a random
// string someone will write on a sticky note because they can't read it.
function suggestPassword() {
  const words = ['rodeo', 'haybarn', 'longhorn', 'lasso', 'saddle', 'corral', 'wrangler', 'bronco', 'stirrup', 'roundup'];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(1000 + Math.random() * 9000)}`;
}

async function editUser(id) {
  const { data: all } = await api('/users');
  const u = all.find(x => x.id === id);
  if (!u) return;
  const form = await formModal(`Edit ${u.full_name}`, userFields(u), { icon: 'fa-pen' });
  if (!form) return;
  const v = formValues(form);
  const { data, error } = await api(`/users/${id}`, 'PATCH', v);
  if (error) return toastMsg('Could not save', error, 'error');
  toastMsg('Saved', data.sessions_revoked ? 'They will need to sign in again.' : '', 'ok');
  loadUsers();
}

async function resetPassword(id, name) {
  const pw = await promptModal(`Set a new password for ${name}. Give it to them directly.`,
    { title: 'Reset password', value: suggestPassword(), required: true, okLabel: 'Set password' });
  if (!pw) return;
  if (pw.length < 10) return toastMsg('Too short', 'Use at least 10 characters.', 'error');
  const { error } = await api(`/users/${id}`, 'PATCH', { password: pw });
  if (error) return toastMsg('Could not reset it', error, 'error');
  toastMsg('Password reset', `${name} is signed out everywhere and needs the new password.`, 'ok');
  loadUsers();
}

async function forceLogout(id, name) {
  const ok = await confirmModal(`${name} will be signed out on every device immediately.`,
    { title: 'Sign them out?', confirmLabel: 'Sign out' });
  if (!ok) return;
  const { error } = await api(`/users/${id}`, 'PATCH', { force_logout: true });
  if (error) return toastMsg('Could not do that', error, 'error');
  toastMsg('Signed out', `${name}'s sessions have been revoked.`, 'ok');
}

async function toggleUser(id, status, name) {
  const disabling = status === 'active';
  const ok = await confirmModal(
    disabling ? `${name} will not be able to sign in.` : `${name} will be able to sign in again.`,
    { title: disabling ? 'Disable this account?' : 'Enable this account?', danger: disabling,
      confirmLabel: disabling ? 'Disable' : 'Enable' });
  if (!ok) return;
  const { error } = await api(`/users/${id}`, 'PATCH', { status: disabling ? 'inactive' : 'active' });
  if (error) return toastMsg('Could not do that', error, 'error');
  loadUsers();
}

async function changeMyPassword() {
  const form = await formModal('Change my password', `
    <div class="form-group"><label class="form-label">Current password</label>
      <input class="form-input" name="current_password" type="password" required autocomplete="current-password" /></div>
    <div class="form-group"><label class="form-label">New password</label>
      <input class="form-input" name="new_password" type="password" required minlength="10" autocomplete="new-password" />
      <div class="small muted" style="margin-top:6px">At least 10 characters. You'll be signed out everywhere afterwards.</div></div>`,
    { icon: 'fa-key', submitLabel: 'Change password', wide: false });
  if (!form) return;
  const { error } = await api('/auth/change-password', 'POST', formValues(form));
  if (error) return toastMsg('Could not change it', error, 'error');
  toastMsg('Password changed', 'Signing you out…', 'ok');
  setTimeout(signOut, 1500);
}

// ══ Lookups ════════════════════════════════════════════════════
function lookupPanel(kind, title, icon, rows) {
  return `<div class="card card-sm">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div class="section-title" style="margin:0"><i class="fa-solid ${icon}"></i> ${title}</div>
      <button class="btn btn-sm btn-primary" onclick="newLookup('${kind}')"><i class="fa-solid fa-plus"></i></button>
    </div>
    <table class="tbl" style="margin-top:10px"><tbody>
      ${rows.map(r => `<tr${r.active ? '' : ' style="opacity:.5"'}>
        <td>${r.icon ? `<i class="fa-solid ${esc(r.icon)}" style="width:20px;color:var(--accent)"></i>` : ''}
            <b>${esc(r.name)}</b>${r.active ? '' : ' <span class="badge badge-neutral">Inactive</span>'}</td>
        <td class="small muted">${r.asset_count} asset${r.asset_count === 1 ? '' : 's'}</td>
        <td style="text-align:right;white-space:nowrap">
          <button class="btn btn-sm" onclick="renameLookup('${kind}','${r.id}','${esc(r.name)}')"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-sm" onclick="toggleLookup('${kind}','${r.id}',${r.active})" title="${r.active ? 'Hide' : 'Show'}">
            <i class="fa-solid fa-eye${r.active ? '-slash' : ''}"></i></button>
          <button class="btn btn-sm btn-danger" onclick="deleteLookup('${kind}','${r.id}','${esc(r.name)}')"><i class="fa-solid fa-trash"></i></button>
        </td></tr>`).join('') || '<tr><td class="small muted">None yet.</td></tr>'}
    </tbody></table>
  </div>`;
}

async function loadLookups() {
  const [c, l] = await Promise.all([api('/categories?all=1'), api('/locations?all=1')]);
  CATEGORIES = c.data || []; LOCATIONS = l.data || [];
  document.getElementById('categories-panel').innerHTML =
    lookupPanel('categories', 'Categories', 'fa-tags', CATEGORIES);
  document.getElementById('locations-panel').innerHTML =
    lookupPanel('locations', 'Locations', 'fa-location-dot', LOCATIONS);
}

async function newLookup(kind) {
  const name = await promptModal(null,
    { title: kind === 'categories' ? 'New category' : 'New location', placeholder: 'Name', okLabel: 'Add' });
  if (!name) return;
  const { error } = await api(`/${kind}`, 'POST', { name });
  if (error) return toastMsg('Could not add it', error, 'error');
  loadLookups();
}
async function renameLookup(kind, id, current) {
  const name = await promptModal(null, { title: 'Rename', value: current, okLabel: 'Save' });
  if (!name || name === current) return;
  const { error } = await api(`/${kind}/${id}`, 'PATCH', { name });
  if (error) return toastMsg('Could not rename it', error, 'error');
  loadLookups();
}
async function toggleLookup(kind, id, active) {
  const { error } = await api(`/${kind}/${id}`, 'PATCH', { active: !active });
  if (error) return toastMsg('Could not save', error, 'error');
  loadLookups();
}
async function deleteLookup(kind, id, name) {
  const ok = await confirmModal(`Delete "${name}"?`, { confirmLabel: 'Delete' });
  if (!ok) return;
  const { error, detail } = await api(`/${kind}/${id}`, 'DELETE');
  if (error) {
    // The API refuses while assets still reference it and suggests the
    // alternative; offer that instead of just reporting a failure.
    if (detail?.suggest === 'deactivate') {
      const alt = await confirmModal(`${error} Hide it from the pickers instead?`,
        { title: 'Still in use', danger: false, confirmLabel: 'Hide it' });
      if (alt) { await api(`/${kind}/${id}`, 'PATCH', { active: false }); loadLookups(); }
      return;
    }
    return toastMsg('Could not delete', error, 'error');
  }
  loadLookups();
}

// ══ Settings ═══════════════════════════════════════════════════
async function loadSettings() {
  const { data, error } = await api('/settings');
  if (error) return;
  SETTINGS = data;
  document.getElementById('settings-panel').innerHTML = `
    <div class="form-row">
      <div class="form-group"><label class="form-label">Organisation name</label>
        <input class="form-input" id="s-org" value="${esc(data.org_display_name || '')}" /></div>
      <div class="form-group"><label class="form-label">App name</label>
        <input class="form-input" id="s-app" value="${esc(data.app_display_name || '')}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Support phone</label>
        <input class="form-input" id="s-phone" value="${esc(data.support_phone || '')}" /></div>
      <div class="form-group"><label class="form-label">Support email</label>
        <input class="form-input" id="s-email" value="${esc(data.support_email || '')}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Default loan length (hours)</label>
        <input class="form-input" id="s-hours" type="number" min="0" max="8760" value="${data.default_loan_hours ?? 12}" />
        <div class="small muted" style="margin-top:6px">
          Pre-fills the due date at check-out. Base members can always change it. Set 0 for no default due date.
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Overdue grace (hours)</label>
        <input class="form-input" id="s-grace" type="number" min="0" max="720" value="${data.overdue_grace_hours ?? 0}" />
        <div class="small muted" style="margin-top:6px">
          How long past due before it shows on the overdue report.
        </div>
      </div>
    </div>
    <label class="toggle-row">
      <span>Require a condition when checking equipment out</span>
      <label class="switch"><input type="checkbox" id="s-cond"${data.require_out_condition ? ' checked' : ''} /><span class="slider"></span></label>
    </label>
    <label class="toggle-row">
      <span>Pilot mode banner</span>
      <label class="switch"><input type="checkbox" id="s-pilot"${data.pilot_mode ? ' checked' : ''} /><span class="slider"></span></label>
    </label>
    <button class="btn btn-primary btn-block" style="margin-top:16px" onclick="saveSettings()">
      <i class="fa-solid fa-check"></i> Save settings
    </button>
    <div class="small muted" style="margin-top:10px">
      Last changed ${esc(fmtWhen(data.updated_at))}
    </div>`;
}

async function saveSettings() {
  const body = {
    org_display_name: document.getElementById('s-org').value.trim(),
    app_display_name: document.getElementById('s-app').value.trim(),
    support_phone: document.getElementById('s-phone').value.trim() || null,
    support_email: document.getElementById('s-email').value.trim() || null,
    default_loan_hours: parseInt(document.getElementById('s-hours').value, 10) || 0,
    overdue_grace_hours: parseInt(document.getElementById('s-grace').value, 10) || 0,
    require_out_condition: document.getElementById('s-cond').checked,
    pilot_mode: document.getElementById('s-pilot').checked,
  };
  const { error } = await api('/settings', 'PATCH', body);
  if (error) return toastMsg('Could not save', error, 'error');
  // Repaint the header straight away. Renaming the app and seeing the old
  // name still in the corner is the bug this whole path exists to fix.
  if (typeof refreshBrand === 'function') await refreshBrand();
  toastMsg('Settings saved', '', 'ok');
  loadSettings();
}

// ══ Logs ═══════════════════════════════════════════════════════
let logTab = 'audit';
function setLogTab(t) {
  logTab = t;
  ['audit', 'app', 'import'].forEach(x =>
    document.getElementById(`log-tab-${x}`).classList.toggle('active', x === t));
  loadLogs();
}

async function loadLogs() {
  const el = document.getElementById('logs-panel');
  el.innerHTML = '<div class="small muted">Loading…</div>';

  if (logTab === 'audit') {
    const { data } = await api('/audit-logs?limit=300');
    el.innerHTML = `
      <button class="btn btn-sm" style="margin-bottom:10px" onclick="exportRows('audit-log', window._auditRows, [
        {key:'created_at',label:'When',fmt:csvDate},{key:'full_name',label:'User'},{key:'email',label:'Email'},
        {key:'action',label:'Action'},{key:'detail',label:'Detail'},{key:'ip_address',label:'IP'}])">
        <i class="fa-solid fa-download"></i> Export CSV</button>
      <div style="overflow-x:auto;max-height:520px"><table class="tbl">
      <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead>
      <tbody>${(data || []).map(r => `<tr>
        <td class="small mono">${esc(fmtWhen(r.created_at))}</td>
        <td class="small">${esc(r.full_name || r.email || '—')}</td>
        <td><span class="badge ${r.action?.includes('failed') ? 'badge-no' : 'badge-neutral'}">${esc(r.action)}</span></td>
        <td class="small">${esc(r.detail || '')}</td>
        <td class="small mono muted">${esc(r.ip_address || '')}</td>
      </tr>`).join('')}</tbody></table></div>`;
    window._auditRows = data || [];
    return;
  }

  if (logTab === 'app') {
    const { data } = await api('/app-logs?limit=300');
    el.innerHTML = `<div style="overflow-x:auto;max-height:520px"><table class="tbl">
      <thead><tr><th>When</th><th>Level</th><th>Event</th><th>Detail</th><th>Who</th></tr></thead>
      <tbody>${(data || []).map(r => `<tr>
        <td class="small mono">${esc(fmtWhen(r.created_at))}</td>
        <td><span class="badge ${r.level === 'error' ? 'badge-no' : r.level === 'warn' ? 'badge-pending' : 'badge-neutral'}">${esc(r.level)}</span></td>
        <td class="small mono">${esc(r.event)}</td>
        <td class="small" style="max-width:420px;word-break:break-word">${esc((r.detail || '').slice(0, 300))}</td>
        <td class="small">${esc(r.full_name || r.email || '')}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="small muted">Nothing logged — that\'s good news.</td></tr>'}</tbody></table></div>`;
    return;
  }

  const { data } = await api('/imports?limit=50');
  el.innerHTML = `<div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>When</th><th>Type</th><th>File</th><th>Rows</th><th>Result</th><th>By</th><th></th></tr></thead>
    <tbody>${(data || []).map(b => `<tr>
      <td class="small mono">${esc(fmtWhen(b.created_at))}</td>
      <td class="small">${esc(b.kind)}${b.target_group ? ` → ${esc(b.target_group)}` : ''}</td>
      <td class="small">${esc(b.filename || '—')}</td>
      <td class="small mono">${b.row_count}</td>
      <td class="small">
        <span class="badge ${b.status === 'committed' ? 'badge-approved' : 'badge-pending'}">${esc(b.status)}</span>
        ${b.error_count ? `<span class="badge badge-no">${b.error_count} errors</span>` : ''}
      </td>
      <td class="small">${esc(b.created_by_name || '')}</td>
      <td><button class="btn btn-sm" onclick="downloadImportErrors('${b.id}')" title="Download error rows">
        <i class="fa-solid fa-download"></i></button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="small muted">No imports yet.</td></tr>'}</tbody></table></div>`;
}

async function downloadImportErrors(batchId) {
  const { data } = await api(`/imports/${batchId}/rows?verdict=error`);
  if (!data || !data.length) return toastMsg('No errors', 'Every row in that import was fine.', 'ok');
  // Re-export the ORIGINAL columns plus an error column, so the admin can
  // fix the file in place and re-upload it rather than hunting rows by number.
  const cols = Object.keys(data[0].raw).filter(k => k !== 'row_number');
  const rows = data.map(r => ({ row_number: r.row_number, ...r.raw, error: r.message }));
  exportRows('import-errors', rows, [
    { key: 'row_number', label: 'Row' },
    ...cols.map(c => ({ key: c, label: c })),
    { key: 'error', label: 'error' },
  ]);
}

// ══ Boot ═══════════════════════════════════════════════════════
(async function init() {
  if (!me) return;
  document.getElementById('ln-q').addEventListener('input', () => {
    clearTimeout(lnDebounce);
    lnDebounce = setTimeout(loadLoanees, 250);
  });
  document.getElementById('ln-group').addEventListener('change', loadLoanees);

  // Highlight the sidenav entry for whichever section is on screen.
  const items = [...document.querySelectorAll('.admin-sidenav-item')];
  const sections = items.map(a => document.querySelector(a.getAttribute('href')));
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const i = sections.indexOf(e.target);
      items.forEach((a, j) => a.classList.toggle('active', i === j));
    });
  }, { rootMargin: '-20% 0px -70% 0px' });
  sections.forEach(s => s && io.observe(s));

  await loadGroups();
  await Promise.all([
    loadDashboard(), loadLoanees(), loadUsers(), loadLookups(), loadSettings(), loadLogs(),
    // Guarded because repairs.js is loaded on three different pages and
    // only admin.html has somewhere to render these.
    typeof loadRepairs === 'function' ? loadRepairs() : null,
    typeof loadRepairShops === 'function' ? loadRepairShops() : null,
  ]);

  if (location.hash) document.querySelector(location.hash)?.scrollIntoView({ behavior: 'smooth' });
})();
