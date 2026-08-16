// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — the check-out / check-in counter.
// This is the screen the app exists for; everything else supports it.
// ─────────────────────────────────────────────────────────────
const me = requireLogin('staff', 'admin');
let SETTINGS = { default_loan_hours: 12 };
let checkinItems = [];   // open loan items currently listed on the check-in side
let checkinContext = ''; // a heading describing where that list came from

// ── View switching ─────────────────────────────────────────────
function setView(v) {
  document.getElementById('view-out').classList.toggle('active', v === 'out');
  document.getElementById('view-in').classList.toggle('active', v === 'in');
  document.getElementById('tab-out').classList.toggle('active', v === 'out');
  document.getElementById('tab-in').classList.toggle('active', v === 'in');
  document.getElementById('page-sub').textContent =
    v === 'out' ? 'Hand equipment out' : 'Take equipment back in';
  if (v === 'out') document.getElementById('loanee-input')?.focus();
  else document.getElementById('in-asset-input')?.focus();
}

// ── Due date ───────────────────────────────────────────────────
// Pre-filled to now + the configured default (12 hours). Staff can
// change it or clear it; a cleared field means an indefinite loan and is
// sent to the server as an explicit null, not as "unset".
function setDue(hours) {
  const el = document.getElementById('due-input');
  el.value = hours === null ? '' : toLocalInput(new Date(Date.now() + hours * 3600 * 1000));
}
function setDueTonight() {
  const d = new Date();
  d.setHours(18, 0, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  document.getElementById('due-input').value = toLocalInput(d);
}

// ── Cart rendering ─────────────────────────────────────────────
function renderLoanee() {
  const picked = document.getElementById('loanee-picked');
  const search = document.getElementById('loanee-search');
  const assetInput = document.getElementById('asset-input');

  if (!Cart.loanee) {
    picked.style.display = 'none';
    search.style.display = 'block';
    assetInput.disabled = true;
    assetInput.placeholder = 'Choose who is taking it first…';
    return;
  }
  const l = Cart.loanee;
  const groups = (l.group_names || []).map(g => `<span class="class-chip class-exec">${esc(g)}</span>`).join(' ');
  picked.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap">
      <div>
        <div style="font-size:18px;font-weight:700">${esc(l.full_name)}</div>
        <div class="small muted">${[l.position, l.sub_committee].filter(Boolean).map(esc).join(' · ') || 'No committee on file'}</div>
        <div class="small muted">${[l.email, l.phone_mobile && fmtPhone(l.phone_mobile)].filter(Boolean).map(esc).join(' · ')}</div>
        <div class="pill-row" style="margin-top:8px">${groups || '<span class="small muted">No groups</span>'}</div>
      </div>
      <div style="text-align:right">
        ${l.items_out ? `<span class="badge badge-active">${l.items_out} already out</span>` : ''}
        <div style="margin-top:8px">
          <button class="btn btn-sm btn-ghost" onclick="clearLoanee()"><i class="fa-solid fa-xmark"></i> Change</button>
        </div>
      </div>
    </div>`;
  picked.style.display = 'block';
  search.style.display = 'none';
  assetInput.disabled = false;
  assetInput.placeholder = 'Search or scan an asset tag, title or serial…';
}

function renderCart() {
  const wrap = document.getElementById('cart-wrap');
  const btn = document.getElementById('checkout-btn');
  const label = document.getElementById('checkout-label');

  if (!Cart.items.length) {
    wrap.innerHTML = `<div class="small muted" style="padding:18px 4px;text-align:center">
      Nothing in the cart yet. Add as many items as they're taking — they all go out together.</div>`;
    btn.disabled = true;
    label.textContent = 'Check Out';
    return;
  }

  const rows = Cart.items.map(i => `
    <tr${i.blocked_reason ? ' style="background:var(--redbg)"' : ''}>
      <td style="width:56px">${assetThumb(i.primary_photo_url, 40)}</td>
      <td>
        <div style="font-weight:600">${esc(i.title)}</div>
        <div class="small muted mono">${esc(i.asset_tag)}${i.category ? ' · ' + esc(i.category) : ''}</div>
        ${i.blocked_reason ? `<div class="small" style="color:var(--red);font-weight:600">
            <i class="fa-solid fa-ban"></i> ${esc(i.blocked_reason)}</div>` : ''}
      </td>
      <td style="text-align:right;width:48px">
        <button class="btn btn-sm btn-ghost" onclick="removeItem('${i.asset_id}')" title="Remove">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </td>
    </tr>`).join('');

  const blocked = Cart.blocked();
  wrap.innerHTML = `
    <div style="overflow-x:auto"><table class="tbl">
      <thead><tr><th></th><th>Item</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${blocked.length ? `<div class="small" style="color:var(--red);margin-top:10px;font-weight:600">
      <i class="fa-solid fa-triangle-exclamation"></i>
      ${blocked.length} item${blocked.length === 1 ? '' : 's'} can't go out. Remove ${blocked.length === 1 ? 'it' : 'them'} to continue —
      nothing is checked out until everything in the cart is clear.</div>` : ''}`;

  // All-or-nothing: the button stays disabled while anything is blocked,
  // so the failure is visible before the click rather than after it.
  btn.disabled = blocked.length > 0;
  label.textContent = `Check Out ${Cart.items.length} Item${Cart.items.length === 1 ? '' : 's'}`;
}

async function refreshCart() {
  await Cart.revalidate();
  renderCart();
}

function clearLoanee() {
  Cart.setLoanee(null);
  renderLoanee();
  refreshCart();
  document.getElementById('loanee-input').focus();
}
function removeItem(id) {
  Cart.remove(id);
  renderCart();
}

// ── Check out ──────────────────────────────────────────────────
async function doCheckout() {
  if (!Cart.loanee) return toastMsg('Choose a person first', 'Search for who is taking the equipment.', 'error');
  if (!Cart.items.length) return toastMsg('The cart is empty', 'Add at least one item.', 'error');

  const btn = document.getElementById('checkout-btn');
  btn.disabled = true;

  const dueRaw = document.getElementById('due-input').value;
  const body = {
    loanee_id: Cart.loanee.id,
    asset_ids: Cart.ids(),
    due_at: dueRaw ? fromLocalInput(dueRaw) : null,  // explicit null = indefinite
    notes: document.getElementById('notes-input').value.trim() || null,
  };
  const cond = document.getElementById('cond-input').value;
  if (cond) body.items = Cart.ids().map(id => ({ asset_id: id, out_condition: cond }));

  const { data, error, detail } = await api('/checkout', 'POST', body);
  if (error) {
    // The server sends back exactly which rows blocked it; flag those in
    // place rather than dumping the cart and making staff start over.
    if (detail && Array.isArray(detail.blocked)) {
      const byId = new Map(detail.blocked.map(b => [b.asset_id, b.reason]));
      Cart.items.forEach(i => { i.blocked_reason = byId.get(i.asset_id) || null; });
      Cart.save();
      renderCart();
    }
    toastMsg('Nothing was checked out', error, 'error');
    btn.disabled = false;
    return;
  }

  const n = data.items.length;
  const due = data.loan.due_at ? `Due back ${fmtWhen(data.loan.due_at)}.` : 'No due date set.';
  toastMsg(`${n} item${n === 1 ? '' : 's'} out to ${data.loanee.full_name}`, due, 'ok');

  Cart.clear();
  renderLoanee();
  renderCart();
  document.getElementById('notes-input').value = '';
  setDue(SETTINGS.default_loan_hours || null);
  document.getElementById('loanee-input').focus();
}

// ── Check in ───────────────────────────────────────────────────
function renderCheckin() {
  const panel = document.getElementById('checkin-panel');
  if (!checkinItems.length) {
    panel.innerHTML = `<div class="card"><div class="small muted" style="padding:26px 4px;text-align:center">
      Search for an asset or a person on the left to see what's out.</div></div>`;
    return;
  }
  const rows = checkinItems.map(v => `
    <tr>
      <td style="width:38px">
        <input type="checkbox" class="ci-pick" data-id="${v.loan_item_id}" checked />
      </td>
      <td style="width:56px">${assetThumb(v.primary_photo_url, 40)}</td>
      <td>
        <div style="font-weight:600">${esc(v.asset_title)}</div>
        <div class="small muted mono">${esc(v.asset_tag)}</div>
        <div class="small ${v.overdue ? '' : 'muted'}" style="${v.overdue ? 'color:var(--red);font-weight:600' : ''}">
          ${esc(v.loanee_name)} · out ${esc(fmtAgo(v.checked_out_at))}${v.due_at ? ` · due ${esc(fmtWhen(v.due_at))}` : ''}
          ${v.overdue ? ' · OVERDUE' : ''}
        </div>
      </td>
      <td style="width:170px">
        <select class="form-input ci-cond" data-id="${v.loan_item_id}" style="padding:7px 10px;font-size:13px"
                onchange="onConditionChange(this)">
          <option value="">Condition…</option>
          ${IN_CONDITIONS.map(c => `<option value="${c.value}">${c.label}</option>`).join('')}
        </select>
      </td>
    </tr>`).join('');

  panel.innerHTML = `
    <div class="card">
      <div class="section-title"><i class="fa-solid fa-arrow-right-to-bracket"></i> ${esc(checkinContext)}</div>
      <div style="display:flex;gap:8px;margin-bottom:10px">
        <button class="btn btn-sm" onclick="pickAll(true)">Select all</button>
        <button class="btn btn-sm btn-ghost" onclick="pickAll(false)">Select none</button>
      </div>
      <div style="overflow-x:auto"><table class="tbl">
        <thead><tr><th></th><th></th><th>Item</th><th>Coming back as</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="form-group" style="margin-top:14px">
        <label class="form-label" for="ci-notes">Notes</label>
        <textarea class="form-input" id="ci-notes" rows="2"
                  placeholder="Damage, missing parts, anything to flag…"></textarea>
      </div>
      <div class="small muted" style="margin-bottom:12px">
        <i class="fa-solid fa-circle-info"></i>
        Anything marked damaged, needs service or missing goes to maintenance instead of back on the shelf.
      </div>
      <button class="drive-action green" onclick="doCheckin()">
        <i class="fa-solid fa-arrow-right-to-bracket"></i> <span id="ci-label">Check In</span>
      </button>
    </div>`;
  updateCheckinLabel();
}

function pickAll(on) {
  document.querySelectorAll('.ci-pick').forEach(c => { c.checked = on; });
  updateCheckinLabel();
}
function onConditionChange(sel) {
  // Visible consequence: a bad condition visibly routes to maintenance
  // rather than quietly doing something different from what was clicked.
  const row = sel.closest('tr');
  row.style.background = conditionNeedsService(sel.value) ? 'var(--amberbg)' : '';
}
function updateCheckinLabel() {
  const n = document.querySelectorAll('.ci-pick:checked').length;
  const el = document.getElementById('ci-label');
  if (el) el.textContent = `Check In ${n} Item${n === 1 ? '' : 's'}`;
}

async function doCheckin() {
  const picks = [...document.querySelectorAll('.ci-pick:checked')].map(c => c.dataset.id);
  if (!picks.length) return toastMsg('Nothing selected', 'Tick at least one item.', 'error');

  const perItem = picks.map(id => {
    const cond = document.querySelector(`.ci-cond[data-id="${id}"]`)?.value || null;
    return { loan_item_id: id, in_condition: cond || null };
  });
  const notes = document.getElementById('ci-notes').value.trim() || null;

  const toService = perItem.filter(p => conditionNeedsService(p.in_condition)).length;
  if (toService) {
    const ok = await confirmModal(
      `${toService} item${toService === 1 ? '' : 's'} will go to maintenance instead of back on the shelf.`,
      { danger: false, title: 'Send to maintenance?', confirmLabel: 'Yes, check them in' });
    if (!ok) return;
  }

  const { data, error } = await api('/checkin', 'POST', { loan_item_ids: picks, per_item: perItem, in_notes: notes });
  if (error) return toastMsg('Could not check that in', error, 'error');

  const n = data.checked_in.length;
  const svc = data.checked_in.filter(i => i.to_status === 'maintenance').length;
  toastMsg(
    `${n} item${n === 1 ? '' : 's'} back in`,
    svc ? `${svc} sent to maintenance.` : 'All back on the shelf.', 'ok');

  // Drop the ones just returned; keep anything still out visible so
  // "some now, some later" doesn't need a re-search.
  const done = new Set(data.checked_in.map(i => i.id));
  checkinItems = checkinItems.filter(v => !done.has(v.loan_item_id));
  renderCheckin();
}

// ── Boot ───────────────────────────────────────────────────────
(async function init() {
  if (!me) return;
  document.getElementById('operator-name').textContent = me.full_name || me.email;

  const cond = document.getElementById('cond-input');
  CONDITIONS.forEach(c => cond.add(new Option(c.label, c.value)));

  const { data: s } = await api('/settings');
  if (s) SETTINGS = s;
  setDue(SETTINGS.default_loan_hours && SETTINGS.default_loan_hours > 0 ? SETTINGS.default_loan_hours : null);

  Cart.load();
  renderLoanee();
  await refreshCart();

  // Check-out pickers
  attachPicker(document.getElementById('loanee-input'), {
    kind: 'loanee',
    onPick: async (l) => {
      Cart.setLoanee(l);
      renderLoanee();
      // Eligibility is per person, so anything already in the cart has to
      // be re-checked against the new one.
      await refreshCart();
      document.getElementById('asset-input').focus();
    },
  });
  attachPicker(document.getElementById('asset-input'), {
    kind: 'asset',
    forLoanee: () => Cart.loanee?.id,
    onPick: (a) => {
      if (!Cart.add(a)) { toastMsg('Already in the cart', `${a.asset_tag} is on the list.`); return; }
      renderCart();
      document.getElementById('asset-input').focus();
    },
  });

  // Check-in pickers
  attachPicker(document.getElementById('in-asset-input'), {
    kind: 'asset',
    onPick: async (a) => {
      const { data, error } = await api(`/loans/open`);
      if (error) return toastMsg('Could not load', error, 'error');
      const hit = (data.rows || []).filter(v => v.asset_id === a.id);
      if (!hit.length) return toastMsg('Not checked out', `${a.asset_tag} isn't out right now.`, 'error');
      checkinItems = hit;
      checkinContext = `${hit[0].asset_tag} — ${hit[0].asset_title}`;
      renderCheckin();
    },
  });
  attachPicker(document.getElementById('in-loanee-input'), {
    kind: 'loanee',
    onPick: async (l) => {
      const { data, error } = await api(`/loanees/${l.id}`);
      if (error) return toastMsg('Could not load', error, 'error');
      if (!data.open_items.length) return toastMsg('Nothing out', `${l.full_name} has nothing checked out.`);
      checkinItems = data.open_items;
      checkinContext = `${l.full_name} — ${data.open_items.length} item${data.open_items.length === 1 ? '' : 's'} out`;
      renderCheckin();
    },
  });

  renderCheckin();
  document.addEventListener('change', (e) => {
    if (e.target.classList?.contains('ci-pick')) updateCheckinLabel();
  });
  document.getElementById('loanee-input').focus();
})();
