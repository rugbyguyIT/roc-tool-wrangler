// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — the check-out / check-in counter.
// This is the screen the app exists for; everything else supports it.
// ─────────────────────────────────────────────────────────────
const me = requireLogin('staff', 'admin');

// The big orange button has never had a disabled state — it looks exactly
// as clickable with an empty cart as with a full one, and there are now
// three ways to reach it dead (empty cart, a blocked item, a member at
// their limit). A primary action that looks alive and does nothing is how
// someone ends up jabbing a tablet at a busy counter.
//
// Injected here rather than added to css/style.css so the counter's own
// ergonomics travel with the counter's own file; fold it into the
// .drive-action block next time that stylesheet is edited for other reasons.
(function injectCounterStyles() {
  if (document.getElementById('counter-styles')) return;
  const el = document.createElement('style');
  el.id = 'counter-styles';
  el.textContent = `
    .drive-action:disabled{
      background:var(--surface3); color:var(--muted2);
      box-shadow:none; cursor:not-allowed;
    }
    .drive-action:disabled:active{ transform:none }
  `;
  document.head.appendChild(el);
})();
let SETTINGS = { default_loan_hours: 12 };
let checkinItems = [];   // open loan items currently listed on the check-in side
let checkinContext = ''; // a heading describing where that list came from
// What the item limit means for whoever is currently chosen, or null when
// no limit applies to them (an officer, or the rule switched off).
let limitInfo = null;

// ── View switching ────────────────────────────────
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

// ── Due date ────────────────────────────────────
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

// ── Cart rendering ───────────────────────────────
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
  picked.insertAdjacentHTML('beforeend', limitNoticeHtml());
  picked.style.display = 'block';
  search.style.display = 'none';
  assetInput.disabled = false;
  assetInput.placeholder = 'Search or scan an asset tag, title or serial…';
}

// The rule, stated on the person's card the moment they are chosen. A
// refusal that only arrives after the cart is built and the button is
// clicked is a rule nobody at the counter can plan around.
function limitNoticeHtml() {
  if (!limitInfo) return '';
  const held = limitInfo.holding || [];
  const rows = held.map(h => `<li style="margin:2px 0">
      <span class="mono">${esc(h.asset_tag)}</span> — ${esc(h.asset_title)}
      <span class="muted">· out ${esc(fmtAgo(h.checked_out_at))}${
        h.due_at ? `, due ${esc(fmtWhen(h.due_at))}` : ''}</span></li>`).join('');

  const rule = limitInfo.per_category
    ? `${limitInfo.limit} of each kind`
    : `${limitInfo.limit} item${limitInfo.limit === 1 ? '' : 's'}`;

  if (!limitInfo.at_limit) {
    if (!held.length) return '';
    return `<div class="small muted" style="margin-top:10px">
      <i class="fa-solid fa-circle-info"></i> Already holding ${held.length}. As a
      ${esc(limitInfo.title)} they may have ${esc(rule)} at a time.</div>`;
  }

  return `<div class="card card-sm" style="margin-top:12px;border-left:3px solid var(--red)">
    <div class="small" style="font-weight:700;color:var(--red)">
      <i class="fa-solid fa-hand"></i> At their limit — nothing more can go out
    </div>
    <div class="small muted" style="margin:6px 0 4px">
      A ${esc(limitInfo.title)} may hold ${esc(rule)} at a time. ${esc(Cart.loanee.full_name)}
      currently has:
    </div>
    <ul class="small" style="margin:0 0 6px 18px;padding:0">${rows}</ul>
    <div class="small muted">
      Check one of those in first. If they should not be under this limit, their
      roster title is what decides it — an admin can change the rule under
      Admin → Settings.
    </div>
  </div>`;
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
        ${assetMarkings(i)}
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
  // so the failure is visible before the click rather than after it. The
  // item limit is the same idea — the server refuses it either way, but a
  // dead button beside a stated reason beats a 409 after the click.
  btn.disabled = blocked.length > 0 || !!(limitInfo && limitInfo.at_limit);
  label.textContent = `Check Out ${Cart.items.length} Item${Cart.items.length === 1 ? '' : 's'}`;
}

async function refreshCart() {
  await Cart.revalidate();
  renderCart();
}

async function loadLimit() {
  limitInfo = null;
  if (!Cart.loanee) return renderLoanee();
  const { data } = await api(`/loanees/${Cart.loanee.id}/limit`);
  limitInfo = (data && data.applies) ? data : null;
  renderLoanee();
  renderCart();
}

function clearLoanee() {
  Cart.setLoanee(null);
  limitInfo = null;
  renderLoanee();
  refreshCart();
  document.getElementById('loanee-input').focus();
}
function removeItem(id) {
  Cart.remove(id);
  renderCart();
}

// ── Check out ──────────────────────────────────
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
  // No condition-going-out field at the counter. The column and the API
  // still accept one, so a later screen can record it without a migration;
  // it is simply not asked for during a handoff.

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
    // The limit refusal carries the list of what they hold; show it as a
    // dialog rather than a toast, because it is a decision to act on and a
    // toast disappears before it can be read out to whoever is waiting.
    if (detail && detail.member_limit) {
      const held = detail.member_limit.holding || [];
      await confirmModal(
        `${error}\n\n${held.map(h => `${h.asset_tag} — ${h.asset_title}`).join('\n')}`,
        { title: 'Already at their limit', danger: true,
          confirmLabel: 'OK', cancelLabel: 'Close' });
      await loadLimit();
    } else {
      toastMsg('Nothing was checked out', error, 'error');
    }
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
  // The Assets Out list beside this form is now short by exactly the items
  // that just went out — refresh it rather than making anyone wonder.
  loadOutNow();
  limitInfo = null;
}

// ── Assets Out ────────────────────────────────
// The same list on BOTH tabs. On check-in it is the default view; on
// check-out it sits beside the handoff form, because a return that walks
// up while you are mid-checkout should not cost a tab change and a search.
//
// One data load, one row renderer, two mount points — a second copy of
// this would drift, and the half that drifts is the one nobody is
// looking at.
//
// The searched view still wins on the check-in tab when there is one:
// picking a person is how you take back five things at once with a
// condition recorded on each.
let outNow = [];

async function loadOutNow() {
  const { data, error } = await api('/loans/open');
  outNow = (error ? [] : (data.rows || []));
  renderOutEverywhere();
}

// Repaint every mount point that is on this page. renderCheckin() is what
// decides whether the check-in side shows this list or a search result, so
// it is called rather than the panel renderer directly.
function renderOutEverywhere() {
  renderOutNowPanel('out-panel');
  renderCheckin();
}

function outRowHtml(v) {
  return `
    <tr${v.overdue ? ' style="background:var(--redbg)"' : ''}>
      <td style="width:56px">${assetThumb(v.primary_photo_url, 40)}</td>
      <td>
        <div style="font-weight:600">${esc(v.asset_title)}</div>
        <div class="small muted mono">${esc(v.asset_tag)}</div>
        ${assetMarkings(v)}
      </td>
      <td>
        <div class="small"><b>${esc(v.loanee_name)}</b></div>
        <div class="small ${v.overdue ? '' : 'muted'}" style="${v.overdue ? 'color:var(--red);font-weight:600' : ''}">
          out ${esc(fmtAgo(v.checked_out_at))}${v.due_at ? ` · due ${esc(fmtWhen(v.due_at))}` : ''}${v.overdue ? ' · OVERDUE' : ''}
        </div>
      </td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm btn-success"
          onclick="quickCheckin('${v.loan_item_id}')">
          <i class="fa-solid fa-arrow-right-to-bracket"></i> Check In</button>
      </td>
    </tr>`;
}

function renderOutNowPanel(targetId) {
  // Both tabs call this; only one of the two mount points exists per view,
  // and on a page that dropped one entirely this simply does nothing.
  const panel = document.getElementById(targetId || 'checkin-panel');
  if (!panel) return;

  if (!outNow.length) {
    panel.innerHTML = `<div class="card">
      <div class="section-title"><i class="fa-solid fa-person-walking-luggage"></i> Assets Out</div>
      <div class="small muted" style="padding:22px 4px;text-align:center">
        Nothing is checked out right now.</div></div>`;
    return;
  }

  const overdue = outNow.filter(v => v.overdue).length;
  panel.innerHTML = `
    <div class="card">
      <div class="section-title">
        <i class="fa-solid fa-person-walking-luggage"></i> Assets Out (${outNow.length})
        ${overdue ? `<span class="badge badge-no" style="margin-left:8px">${overdue} overdue</span>` : ''}
      </div>
      <div class="small muted" style="margin-bottom:10px">
        Click Check In, then Yes, and it is back on the shelf. To take several
        back at once, or to record damage, use the Check In tab and find the person.
      </div>
      <div style="overflow-x:auto"><table class="tbl">
        <thead><tr><th></th><th>Item</th><th>Who has it</th><th></th></tr></thead>
        <tbody>${outNow.map(outRowHtml).join('')}</tbody>
      </table></div>
    </div>`;
}

// Two clicks: Check In, then Yes. No condition picker here on purpose —
// this is the "it came back fine" path, and anything that did not come back
// fine deserves the full form, which is one tab away.
async function quickCheckin(loanItemId) {
  const v = outNow.find(x => x.loan_item_id === loanItemId);
  if (!v) return;
  const ok = await confirmModal(
    `${v.asset_tag} — ${v.asset_title}, back from ${v.loanee_name}.`,
    { title: 'Check this in?', danger: false, confirmLabel: 'Yes, check it in' });
  if (!ok) return;

  const { data, error } = await api('/checkin', 'POST', {
    loan_item_ids: [loanItemId],
    per_item: [{ loan_item_id: loanItemId, in_condition: null }],
  });
  if (error) return toastMsg('Could not check that in', error, 'error');
  toastMsg('Back in', `${v.asset_tag} is on the shelf.`, 'ok');
  // Drop it locally first so the row disappears on the click rather than
  // one network round trip later, then re-read to pick up anything a
  // colleague at the other tablet did in the meantime.
  outNow = outNow.filter(x => x.loan_item_id !== loanItemId);
  renderOutEverywhere();
  loadOutNow();
}

function renderCheckin() {
  const panel = document.getElementById('checkin-panel');
  if (!panel) return;
  if (!checkinItems.length) return renderOutNowPanel('checkin-panel');
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
  // Both copies of the Assets Out list are now stale by exactly these items.
  loadOutNow();
}

// ── Boot ──────────────────────────────────────
(async function init() {
  if (!me) return;
  document.getElementById('operator-name').textContent = me.full_name || me.email;

  // No condition picker on the way out any more. CONDITIONS itself stays
  // in assets-ui.js — IN_CONDITIONS is built from it, and check-IN is
  // where a damaged item actually needs recording.

  const { data: s } = await api('/settings');
  if (s) SETTINGS = s;
  setDue(SETTINGS.default_loan_hours && SETTINGS.default_loan_hours > 0 ? SETTINGS.default_loan_hours : null);

  Cart.load();
  renderLoanee();
  await refreshCart();
  // A cart restored from a reload already has a person on it.
  if (Cart.loanee) loadLimit();

  // What is out, on BOTH tabs, without anyone searching first.
  loadOutNow();

  // Check-out pickers
  attachPicker(document.getElementById('loanee-input'), {
    kind: 'loanee',
    onPick: async (l) => {
      Cart.setLoanee(l);
      renderLoanee();
      // Eligibility AND the item limit are both per person, so anything
      // already in the cart has to be re-checked against the new one.
      await Promise.all([refreshCart(), loadLimit()]);
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
