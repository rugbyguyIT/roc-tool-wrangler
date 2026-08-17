// ═══════════════════════════════════════════════════════════════════════
// Repairs — sending an asset to Buildings and Grounds, and getting it back.
//
// Deliberately distinct from check-out in the UI as well as the data: the
// button says "Send for repair", the person field says which SHOP has it,
// and the thing it asks for first is what's wrong. Staff at the counter
// should never be choosing between "check out to B&G" and "send for
// repair" and guessing which one the reports want.
// ═══════════════════════════════════════════════════════════════════════

let SHOPS = null;

async function loadShops(force) {
  if (SHOPS && !force) return SHOPS;
  const { data, error } = await api('/repair-shops');
  if (error) { toastMsg('Could not load repair shops', error, 'error'); return []; }
  SHOPS = data.rows || [];
  return SHOPS;
}

// ── Send ───────────────────────────────────────────────────────────────
async function sendForRepair(assetId, assetLabel, defaultShopId) {
  const shops = await loadShops();
  if (!shops.length) {
    return toastMsg('No repair shops yet',
      'Add one under Admin → Repair shops first — Buildings and Grounds is usually the one.', 'error');
  }

  // Default to 7 days out: long enough not to nag, short enough that a
  // forgotten asset surfaces on the board rather than vanishing.
  const due = new Date(Date.now() + 7 * 864e5);
  const dueLocal = new Date(due.getTime() - due.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  formModal(`Send for repair — ${esc(assetLabel || '')}`, `
    <div class="form-group">
      <label class="form-label">What's wrong with it? *</label>
      <textarea class="form-input" name="reported_fault" rows="2" required
        placeholder="Hydraulic leak, drops the load"></textarea>
      <div class="small muted">Whoever picks this up needs to know, and so does whoever
        reads the history in six months.</div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="form-label">Who's fixing it?</label>
        <select class="form-input" name="shop_id">
          ${shops.map(s => `<option value="${s.id}"${s.id === defaultShopId ? ' selected' : ''}>${
            esc(s.name)}${s.is_internal ? '' : ' (outside)'}</option>`).join('')}
        </select>
        <div class="small muted">${defaultShopId
          ? 'Pre-set from this asset\u2019s type — change it if someone else is doing the work.'
          : 'No default for this type. Set one under Admin \u2192 Lookups.'}</div></div>
      <div class="form-group"><label class="form-label">Expected back</label>
        <input class="form-input" type="datetime-local" name="expected_back" value="${dueLocal}" />
        <div class="small muted">Leave it if you don't know — it just drives the overdue flag.</div></div>
    </div>
    <div class="small muted">
      <i class="fa-solid fa-circle-info"></i> The asset moves to Maintenance and can't be
      checked out until it's received back.
    </div>`,
    { icon: 'fa-screwdriver-wrench', submitLabel: 'Send it out' })
    .then(async form => {
      if (!form) return;
      const fault = form.querySelector('[name="reported_fault"]').value.trim();
      if (!fault) return toastMsg('Describe the fault', 'The shop needs to know what to look at.', 'error');
      const expected = form.querySelector('[name="expected_back"]').value;
      const { error } = await api('/repairs', 'POST', {
        asset_id: assetId,
        shop_id: form.querySelector('[name="shop_id"]').value,
        reported_fault: fault,
        expected_back: expected ? new Date(expected).toISOString() : null,
      });
      if (error) return toastMsg('Could not send it', error, 'error');
      toastMsg('Sent for repair', 'It will show under At repair until it comes back.');
      if (typeof loadAssets === 'function') loadAssets();
      if (typeof loadRepairs === 'function') loadRepairs();
      if (typeof openAsset === 'function' && document.getElementById('asset-detail')) openAsset(assetId);
    });
}

// ── Receive back ───────────────────────────────────────────────────────
function receiveFromRepair(repairId, assetLabel) {
  formModal(`Received back — ${esc(assetLabel || '')}`, `
    <div class="form-group">
      <label class="form-label">What happened?</label>
      <select class="form-input" name="outcome">
        <option value="repaired">Repaired — back in service</option>
        <option value="no_fault_found">No fault found — back in service</option>
        <option value="returned_unrepaired">Returned unrepaired — back on the shelf</option>
        <option value="beyond_repair">Beyond repair — retire it</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">What was done</label>
      <textarea class="form-input" name="work_done" rows="2" placeholder="Replaced hydraulic seal"></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Cost</label>
      <input class="form-input" name="cost" placeholder="185.00" />
      <div class="small muted">Optional. Useful when someone asks whether to keep fixing this one.</div>
    </div>
    <div class="small muted" id="rr-note"></div>`,
    { icon: 'fa-circle-check', submitLabel: 'Receive it back' })
    .then(async form => {
      if (!form) return;
      const costRaw = form.querySelector('[name="cost"]').value.trim();
      const dollars = costRaw ? Number(costRaw.replace(/[^0-9.]/g, '')) : null;
      const { data, error } = await api(`/repairs/${repairId}/return`, 'POST', {
        outcome: form.querySelector('[name="outcome"]').value,
        work_done: form.querySelector('[name="work_done"]').value.trim() || null,
        cost_cents: Number.isFinite(dollars) && costRaw ? Math.round(dollars * 100) : null,
      });
      if (error) return toastMsg('Could not receive it', error, 'error');
      toastMsg('Received back', data.status === 'retired'
        ? 'Marked beyond repair and retired.' : 'Back in service.');
      if (typeof loadRepairs === 'function') loadRepairs();
      if (typeof loadAssets === 'function') loadAssets();
    });
}

// ── Admin list ─────────────────────────────────────────────────────────
async function loadRepairs(state) {
  const el = document.getElementById('repairs-table');
  if (!el) return;
  const s = state || (window.REPAIR_STATE || 'open');
  window.REPAIR_STATE = s;

  const { data, error } = await api(`/repairs?state=${encodeURIComponent(s)}`);
  if (error) { el.innerHTML = `<div class="small" style="color:var(--red)">${esc(error)}</div>`; return; }

  const tabs = ['open', 'closed', 'all'].map(k =>
    `<button class="btn btn-sm ${s === k ? 'btn-primary' : ''}" onclick="loadRepairs('${k}')">${
      k === 'open' ? 'Away now' : k === 'closed' ? 'Completed' : 'Everything'}</button>`).join(' ');

  if (!data.rows.length) {
    el.innerHTML = `<div style="margin-bottom:12px">${tabs}</div>
      <div class="small muted" style="padding:20px;text-align:center">
        ${s === 'open' ? 'Nothing is away for repair.' : 'No repair records yet.'}</div>`;
    return;
  }

  const isOpen = s === 'open';
  el.innerHTML = `<div style="margin-bottom:12px">${tabs}</div>
    <div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Asset</th><th>Fault</th><th>Shop</th><th>Sent</th>
      ${isOpen ? '<th>Expected</th>' : '<th>Outcome</th><th>Cost</th>'}<th></th></tr></thead>
    <tbody>${data.rows.map(r => {
      const days = r.days_out != null ? Math.floor(r.days_out) : null;
      return `<tr${r.overdue ? ' style="background:var(--redbg)"' : ''}>
        <td><b>${esc(r.asset_tag)}</b><div class="small muted">${esc(r.asset_title || r.title || '')}</div></td>
        <td class="small">${esc(r.reported_fault || '')}</td>
        <td class="small">${esc(r.shop_name || '—')}</td>
        <td class="small">${fmtDate(r.sent_at)}${days != null ? `<div class="small muted">${days} day${days === 1 ? '' : 's'} out</div>` : ''}</td>
        ${isOpen
          ? `<td class="small">${r.expected_back ? fmtDate(r.expected_back) : '<span class="muted">—</span>'}
             ${r.overdue ? '<div class="small" style="color:var(--red)">Overdue</div>' : ''}</td>`
          : `<td class="small">${esc(OUTCOME_LABEL[r.outcome] || r.outcome || '—')}</td>
             <td class="small mono">${r.cost_cents != null ? '$' + (r.cost_cents / 100).toFixed(2) : '—'}</td>`}
        <td style="text-align:right;white-space:nowrap">
          ${isOpen ? `<button class="btn btn-sm btn-success"
             onclick="receiveFromRepair('${r.repair_id || r.id}','${esc(r.asset_tag)}')">
             <i class="fa-solid fa-circle-check"></i> Received</button>` : ''}
        </td></tr>`;
    }).join('')}</tbody></table></div>`;
}

const OUTCOME_LABEL = {
  repaired: 'Repaired',
  no_fault_found: 'No fault found',
  beyond_repair: 'Beyond repair',
  returned_unrepaired: 'Returned unrepaired',
};

// ── Shops admin ────────────────────────────────────────────────────────
async function loadRepairShops() {
  const el = document.getElementById('shops-table');
  if (!el) return;
  const shops = await loadShops(true);
  el.innerHTML = `<div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Shop</th><th>Contact</th><th>Kind</th><th></th></tr></thead>
    <tbody>${shops.map(s => `
      <tr>
        <td><b>${esc(s.name)}</b>${s.notes ? `<div class="small muted">${esc(s.notes)}</div>` : ''}</td>
        <td class="small">${esc(s.contact || '—')}</td>
        <td class="small">${s.is_internal ? 'Internal department' : 'Outside vendor'}</td>
        <td style="text-align:right">
          <button class="btn btn-sm" onclick="editShop('${s.id}')"><i class="fa-solid fa-pen"></i></button>
        </td>
      </tr>`).join('')}</tbody></table></div>
    <button class="btn btn-sm" style="margin-top:10px" onclick="editShop()">
      <i class="fa-solid fa-plus"></i> Add a shop</button>`;
}

function editShop(id) {
  const s = (SHOPS || []).find(x => x.id === id) || {};
  formModal(id ? 'Edit repair shop' : 'Add a repair shop', `
    <div class="form-group"><label class="form-label">Name *</label>
      <input class="form-input" name="name" required value="${esc(s.name || '')}"
        placeholder="Buildings and Grounds" /></div>
    <div class="form-group"><label class="form-label">Contact</label>
      <input class="form-input" name="contact" value="${esc(s.contact || '')}"
        placeholder="713-555-0100, or ask for Dave" /></div>
    <label class="toggle-row">
      <span>Internal department
        <div class="small muted">Off means an outside vendor.</div></span>
      <input type="checkbox" name="is_internal" ${s.is_internal !== false ? 'checked' : ''} />
    </label>
    ${id ? `<label class="toggle-row">
      <span>Active<div class="small muted">Inactive shops stay on old records but can't be chosen.</div></span>
      <input type="checkbox" name="active" ${s.active !== false ? 'checked' : ''} /></label>` : ''}`,
    { icon: 'fa-screwdriver-wrench', submitLabel: id ? 'Save' : 'Add' })
    .then(async form => {
      if (!form) return;
      const body = {
        name: form.querySelector('[name="name"]').value.trim(),
        contact: form.querySelector('[name="contact"]').value.trim() || null,
        is_internal: form.querySelector('[name="is_internal"]').checked,
      };
      if (id) body.active = form.querySelector('[name="active"]').checked;
      const { error } = id
        ? await api(`/repair-shops/${id}`, 'PATCH', body)
        : await api('/repair-shops', 'POST', body);
      if (error) return toastMsg('Could not save', error, 'error');
      toastMsg('Saved', body.name);
      loadRepairShops();
    });
}