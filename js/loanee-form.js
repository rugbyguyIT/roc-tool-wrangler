// ══════════════════════════════════════════════════════════════════════
// Committee-member form and actions — shared by the Committee Members page
// and the admin console, so there is exactly one definition of what a
// member record looks like and one place to change it.
//
// Both callers define their own loadLoanees(); these call it by name after
// a save, which is why every one of them is guarded.
//
// NAMING: everything a person reads says "committee member". Everything the
// machine reads — the table, the columns, the /loanees routes, the function
// names in this file — still says "loanee". Renaming those would touch the
// schema, every query and every saved URL to change nothing anyone sees.
// ══════════════════════════════════════════════════════════════════════

function loaneeFields(l) {
  l = l || {};
  return `
    <div class="form-row">
      <div class="form-group"><label class="form-label">First name *</label>
        <input class="form-input" name="first_name" required value="${esc(l.first_name || '')}" /></div>
      <div class="form-group"><label class="form-label">Last name *</label>
        <input class="form-input" name="last_name" required value="${esc(l.last_name || '')}" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Email</label>
        <input class="form-input" name="email" type="email" value="${esc(l.email || '')}" /></div>
      <div class="form-group"><label class="form-label">Cell</label>
        <input class="form-input" name="phone_mobile" value="${esc(l.phone_mobile || '')}" placeholder="713-555-0142" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Member number</label>
        <input class="form-input mono" name="member_number" value="${esc(l.member_number || '')}"
               placeholder="1175843" />
        <div class="small muted">Customer Number from the roster. This is what a roster
          re-import matches on — changing it will orphan this record from the roster.</div></div>
      <div class="form-group"><label class="form-label">Title</label>
        <input class="form-input" name="title" value="${esc(l.title || '')}" placeholder="Committee Member" /></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Committee</label>
        <input class="form-input" name="sub_committee" value="${esc(l.sub_committee || '')}" /></div>
      <div class="form-group"><label class="form-label">Position</label>
        <input class="form-input" name="position" value="${esc(l.position || '')}" /></div>
    </div>
    <div class="form-group"><label class="form-label">Notes</label>
      <textarea class="form-input" name="notes" rows="2">${esc(l.notes || '')}</textarea></div>`;
}

async function newLoanee() {
  const form = await formModal('Add committee member', loaneeFields(), { icon: 'fa-user-plus', submitLabel: 'Add' });
  if (!form) return;
  const { error } = await api('/loanees', 'POST', formValues(form));
  if (error) return toastMsg('Could not add them', error, 'error');
  toastMsg('Committee member added', '', 'ok');
  if (typeof loadLoanees === 'function') loadLoanees();
}

async function editLoanee(id) {
  const { data: l } = await api(`/loanees/${id}`);
  if (!l) return;
  const form = await formModal(`Edit ${l.full_name}`, loaneeFields(l), { icon: 'fa-pen' });
  if (!form) return;
  const { error } = await api(`/loanees/${id}`, 'PATCH', formValues(form));
  if (error) return toastMsg('Could not save', error, 'error');
  toastMsg('Saved', '', 'ok');
  if (typeof loadLoanees === 'function') loadLoanees();
}

async function loaneeGroups(id) {
  const { data: l } = await api(`/loanees/${id}`);
  if (!l) return;
  const have = new Set(l.groups.map(g => g.id));
  const fields = GROUPS.length ? GROUPS.map(g => `
    <label class="toggle-row" style="cursor:pointer">
      <span><span style="font-weight:600">${esc(g.name)}</span>
        <span class="small muted"> · ${g.asset_count} restricted asset${g.asset_count === 1 ? '' : 's'}</span></span>
      <input type="checkbox" name="g" data-multi value="${g.id}"${have.has(g.id) ? ' checked' : ''} />
    </label>`).join('') : '<div class="small muted">No groups exist yet.</div>';

  const form = await formModal(`${l.full_name}'s groups`, fields, { icon: 'fa-user-lock' });
  if (!form) return;
  const ids = [...form.querySelectorAll('input[name="g"]:checked')].map(c => c.value);
  const { error } = await api(`/loanees/${id}/groups`, 'PATCH', { group_ids: ids });
  if (error) return toastMsg('Could not save', error, 'error');
  toastMsg('Groups saved', '', 'ok');
  if (typeof loadLoanees === 'function') loadLoanees();
}

async function loaneeHistory(id) {
  const [{ data: l }, { data: h }] = await Promise.all([api(`/loanees/${id}`), api(`/loanees/${id}/history`)]);
  if (!l) return;
  const rows = (h || []).map(r => `
    <tr>
      <td><b>${esc(r.asset_title)}</b><div class="small muted mono">${esc(r.asset_tag)}</div></td>
      <td class="small">${esc(fmtWhen(r.checked_out_at))}</td>
      <td class="small">${r.still_out
        ? '<span class="badge badge-live">Still out</span>'
        : esc(fmtWhen(r.checked_in_at))}</td>
      <td class="small mono">${r.hours_held}h</td>
      <td>${r.returned_late ? '<span class="badge badge-no">Late</span>' : ''}</td>
    </tr>`).join('');
  await formModal(`${l.full_name} — history`,
    `<div class="small muted" style="margin-bottom:12px">
       ${(h || []).length} item${(h || []).length === 1 ? '' : 's'} borrowed · ${l.open_items.length} currently out
     </div>
     <div style="overflow-x:auto"><table class="tbl">
       <thead><tr><th>Item</th><th>Out</th><th>Back</th><th>Held</th><th></th></tr></thead>
       <tbody>${rows || '<tr><td colspan="5" class="small muted">Nothing yet.</td></tr>'}</tbody>
     </table></div>`,
    { icon: 'fa-clock-rotate-left', submitLabel: 'Close', wide: true });
}

async function deactivateLoanee(id, name) {
  const ok = await confirmModal(
    `${name} will stop appearing at the check-out counter. Their history is kept.`,
    { title: 'Deactivate this committee member?', confirmLabel: 'Deactivate' });
  if (!ok) return;
  const { error } = await api(`/loanees/${id}`, 'DELETE');
  if (error) return toastMsg('Could not deactivate', error, 'error');
  toastMsg('Deactivated', '', 'ok');
  if (typeof loadLoanees === 'function') loadLoanees();
}
