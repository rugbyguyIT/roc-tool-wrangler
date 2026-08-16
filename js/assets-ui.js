// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — shared UI. The rides-ui.js analogue.
// Loaded on every page except the login screen.
//   · STATUS_META      one place that decides what each status looks like
//   · assetCard()      the .event-card used by the board and the lists
//   · confirmModal / promptModal / formModal  — styled replacements for
//     the browser's native dialogs, all Promise-based
//   · renderTopNav()   role-aware nav for pages that don't hardcode it
// ─────────────────────────────────────────────────────────────

// Single source of truth for status appearance. Add a status here and
// every screen picks it up.
const STATUS_META = {
  available:   { badge: 'badge-approved', strip: 'var(--green)',  label: 'Available',    icon: 'fa-circle-check' },
  checked_out: { badge: 'badge-live',     strip: 'var(--orange)', label: 'Checked out',  icon: 'fa-person-walking-luggage' },
  maintenance: { badge: 'badge-pending',  strip: 'var(--amber)',  label: 'Maintenance',  icon: 'fa-screwdriver-wrench' },
  retired:     { badge: 'badge-neutral',  strip: 'var(--navy)',   label: 'Retired',      icon: 'fa-box-archive' },
};
const OVERDUE_META = { badge: 'badge-no', strip: 'var(--red)', label: 'Overdue', icon: 'fa-triangle-exclamation' };

const CONDITIONS = [
  { value: 'good',          label: 'Good' },
  { value: 'fair',          label: 'Fair' },
  { value: 'damaged',       label: 'Damaged' },
  { value: 'needs_service', label: 'Needs service' },
];
const IN_CONDITIONS = [...CONDITIONS, { value: 'missing', label: 'Missing / not returned' }];

// Anything in this list must not go back on the shelf as available.
function conditionNeedsService(c) {
  return ['damaged', 'needs_service', 'missing'].includes(c);
}

function statusBadge(status, overdue) {
  const m = overdue ? OVERDUE_META : (STATUS_META[status] || STATUS_META.available);
  return `<span class="badge ${m.badge}"><i class="fa-solid ${m.icon}"></i> ${m.label}</span>`;
}

function assetThumb(url, size = 44) {
  return url
    ? `<img src="${esc(url)}" alt="" style="width:${size}px;height:${size}px;border-radius:8px;object-fit:cover;border:1px solid var(--border)" loading="lazy" />`
    : `<div style="width:${size}px;height:${size}px;border-radius:8px;background:var(--surface3);display:flex;align-items:center;justify-content:center;color:var(--muted2)"><i class="fa-solid fa-camera"></i></div>`;
}

// The card the board and the check-in screen both render. One function
// so an overdue radio looks identical wherever you see it.
function openItemCard(v, actionsHtml) {
  const m = v.overdue ? OVERDUE_META : STATUS_META.checked_out;
  const due = v.due_at
    ? (v.overdue
        ? `<span class="event-meta-item" style="color:var(--red);font-weight:700"><i class="fa-solid fa-triangle-exclamation"></i> Due ${esc(fmtWhen(v.due_at))} · ${esc(fmtAgo(v.due_at))}</span>`
        : `<span class="event-meta-item"><i class="fa-solid fa-clock"></i> Due ${esc(fmtWhen(v.due_at))}</span>`)
    : `<span class="event-meta-item"><i class="fa-solid fa-infinity"></i> No due date</span>`;
  const phone = v.loanee_phone
    ? `<a class="event-meta-item" href="tel:${esc(v.loanee_phone)}" style="text-decoration:none"><i class="fa-solid fa-phone"></i> ${esc(fmtPhone(v.loanee_phone))}</a>`
    : '';
  return `<div class="event-card"><div class="ec-strip" style="background:${m.strip}"></div><div class="ec-body">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start">
      <div style="display:flex;gap:12px;align-items:center;min-width:0">
        ${assetThumb(v.primary_photo_url)}
        <div style="min-width:0">
          <div class="event-title">${esc(v.asset_title)}</div>
          <div class="small mono muted">${esc(v.asset_tag)}${v.category ? ' · ' + esc(v.category) : ''}</div>
        </div>
      </div>
      <span class="badge ${m.badge}"><i class="fa-solid ${m.icon}"></i> ${m.label}</span>
    </div>
    <div class="event-meta">
      <span class="event-meta-item"><i class="fa-solid fa-user"></i> <b>${esc(v.loanee_name)}</b></span>
      ${v.sub_committee ? `<span class="event-meta-item"><i class="fa-solid fa-people-group"></i> ${esc(v.sub_committee)}</span>` : ''}
      ${phone}
      <span class="event-meta-item"><i class="fa-solid fa-arrow-right-from-bracket"></i> Out ${esc(fmtAgo(v.checked_out_at))}</span>
      ${due}
    </div>
    ${actionsHtml ? `<div class="event-footer"><span class="small muted">Checked out by ${esc(v.checked_out_by_name || '—')}</span><div class="event-actions">${actionsHtml}</div></div>` : ''}
  </div></div>`;
}

// Human sentence for one row of the append-only event log.
const EVENT_META = {
  created:           { icon: 'fa-plus',                 text: () => 'Added to the catalog' },
  imported:          { icon: 'fa-file-import',          text: () => 'Imported' },
  updated:           { icon: 'fa-pen',                  text: e => `Details updated${e.payload?.fields ? ` (${e.payload.fields.join(', ')})` : ''}` },
  location_changed:  { icon: 'fa-location-dot',         text: e => `Moved from ${e.payload?.from_location || 'nowhere'}` },
  groups_changed:    { icon: 'fa-user-lock',            text: e => e.payload?.groups?.length ? `Restricted to ${e.payload.groups.join(', ')}` : 'Restrictions removed' },
  checked_out:       { icon: 'fa-arrow-right-from-bracket', text: e => `Checked out to ${e.loanee_name || 'someone'}` },
  checked_in:        { icon: 'fa-arrow-right-to-bracket',   text: e => `Returned by ${e.loanee_name || 'someone'}${e.payload?.condition ? ` — ${e.payload.condition.replace(/_/g, ' ')}` : ''}` },
  maintenance_start: { icon: 'fa-screwdriver-wrench',   text: () => 'Sent to maintenance' },
  maintenance_end:   { icon: 'fa-circle-check',         text: () => 'Back from maintenance' },
  retired:           { icon: 'fa-box-archive',          text: () => 'Retired' },
  unretired:         { icon: 'fa-rotate-left',          text: () => 'Un-retired' },
  photo_added:       { icon: 'fa-camera',               text: () => 'Photo added' },
  photo_removed:     { icon: 'fa-trash',                text: () => 'Photo removed' },
  due_extended:      { icon: 'fa-clock-rotate-left',    text: e => `Due date changed to ${e.payload?.due_at ? fmtWhen(e.payload.due_at) : 'indefinite'}` },
  note_added:        { icon: 'fa-note-sticky',          text: () => 'Note added' },
};
function eventLine(e) {
  const m = EVENT_META[e.event] || { icon: 'fa-circle', text: () => e.event };
  return `<li class="done">
    <div><i class="fa-solid ${m.icon}" style="color:var(--accent);width:16px"></i> ${esc(m.text(e))}</div>
    <div class="small muted">${esc(e.actor_name || 'System')}${e.actor_role ? ` · ${esc(e.actor_role)}` : ''} · <span class="t-time mono">${esc(fmtWhen(e.created_at))}</span></div>
    ${e.reason ? `<div class="small" style="color:var(--muted)">“${esc(e.reason)}”</div>` : ''}
  </li>`;
}

// ─────────────────────────────────────────────────────────────
// Modals — styled replacements for confirm()/prompt(), Promise-based so
// call sites just await them. Styles are injected once rather than added
// to style.css so this file stays self-contained.
// ─────────────────────────────────────────────────────────────
(function injectModalStyles() {
  if (document.getElementById('ui-modal-styles')) return;
  const s = document.createElement('style');
  s.id = 'ui-modal-styles';
  s.textContent = `
    @keyframes uiModalFade{from{opacity:0}to{opacity:1}}
    @keyframes uiModalPop{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}
    .ui-modal-card{
      background:linear-gradient(165deg, rgba(255,255,255,0.68), rgba(255,255,255,0.46));
      backdrop-filter:blur(28px) saturate(180%); -webkit-backdrop-filter:blur(28px) saturate(180%);
      border:1px solid rgba(255,255,255,0.85);
      box-shadow:0 20px 60px rgba(0,46,93,0.22), 0 2px 8px rgba(0,46,93,0.08),
                 inset 0 1px 0 rgba(255,255,255,0.9), inset 0 0 0 1px rgba(255,255,255,0.15);
      position:relative; overflow:hidden; max-height:88vh; overflow-y:auto;
    }
    .ui-modal-card::before{
      content:''; position:absolute; inset:0; pointer-events:none; border-radius:inherit;
      background:linear-gradient(125deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 32%),
                 radial-gradient(120% 90% at 100% 0%, rgba(239,118,34,0.10) 0%, transparent 55%);
    }
    .ui-modal-card > *{ position:relative; }
    .ui-modal-card .form-input{
      background:rgba(255,255,255,0.55); border-color:rgba(0,46,93,0.14);
      transition:background .18s ease, border-color .18s ease, box-shadow .18s ease;
    }
    .ui-modal-card .form-input:focus{ background:rgba(255,255,255,0.92); }
    body.theme-glass .ui-modal-card{
      background:linear-gradient(165deg, rgba(20,32,52,0.92), rgba(10,20,38,0.88));
      border-color:rgba(255,255,255,0.16);
    }
  `;
  document.head.appendChild(s);
})();

let _uiModalEscHandler = null;
function _closeUiModal() {
  document.getElementById('ui-modal-overlay')?.remove();
  if (_uiModalEscHandler) { document.removeEventListener('keydown', _uiModalEscHandler); _uiModalEscHandler = null; }
}
function _openUiModal(innerHtml, onMount, onEscape, maxWidth) {
  _closeUiModal();
  const overlay = document.createElement('div');
  overlay.id = 'ui-modal-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(4,10,20,0.60);backdrop-filter:blur(10px) saturate(120%);'
    + '-webkit-backdrop-filter:blur(10px) saturate(120%);z-index:2000;display:flex;align-items:center;justify-content:center;'
    + 'padding:20px;animation:uiModalFade .15s ease both';
  // Fluid width up to maxWidth: naturally roomy on a desktop, shrinks to
  // fit a phone with no separate mobile styling.
  overlay.innerHTML = `<div class="card ui-modal-card" style="width:100%;max-width:${maxWidth || 380}px;padding:22px;animation:uiModalPop .18s cubic-bezier(.21,1.02,.73,1) both">${innerHtml}</div>`;
  document.body.appendChild(overlay);
  _uiModalEscHandler = (e) => { if (e.key === 'Escape' && typeof onEscape === 'function') onEscape(); };
  document.addEventListener('keydown', _uiModalEscHandler);
  if (typeof onMount === 'function') onMount(overlay);
  return overlay;
}

function confirmModal(message, opts) {
  opts = opts || {};
  const danger = opts.danger !== false;
  return new Promise((resolve) => {
    function finish(val) { _closeUiModal(); resolve(val); }
    _openUiModal(`
      <div class="section-title" style="margin-bottom:8px"><i class="fa-solid ${danger ? 'fa-triangle-exclamation' : 'fa-circle-question'}"></i> ${esc(opts.title || 'Please confirm')}</div>
      <div class="small muted" style="line-height:1.55;margin-bottom:18px">${esc(message)}</div>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn" style="flex:1;justify-content:center" data-act="cancel">${esc(opts.cancelLabel || 'Cancel')}</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" style="flex:1;justify-content:center" data-act="ok">${esc(opts.confirmLabel || 'Confirm')}</button>
      </div>
    `, (ov) => {
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) finish(false); });
      ov.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
      ov.querySelector('[data-act="ok"]').addEventListener('click', () => finish(true));
      ov.querySelector('[data-act="ok"]').focus();
    }, () => finish(false));
  });
}

function promptModal(message, opts) {
  opts = opts || {};
  const required = opts.required !== false;
  const multiline = !!opts.multiline;
  return new Promise((resolve) => {
    function finish(val) { _closeUiModal(); resolve(val); }
    const fieldHtml = multiline
      ? `<textarea class="form-input" rows="3" placeholder="${esc(opts.placeholder || '')}" style="resize:vertical">${esc(opts.value || '')}</textarea>`
      : `<input class="form-input" type="${opts.type || 'text'}" placeholder="${esc(opts.placeholder || '')}" value="${esc(opts.value || '')}" />`;
    _openUiModal(`
      <div class="section-title" style="margin-bottom:8px"><i class="fa-solid ${opts.icon || 'fa-pen'}"></i> ${esc(opts.title || 'One more thing')}</div>
      ${message ? `<div class="small muted" style="line-height:1.55;margin-bottom:12px">${esc(message)}</div>` : ''}
      <div class="form-group" style="margin-bottom:6px">${fieldHtml}</div>
      <div class="small" style="color:var(--red);margin-bottom:12px;display:none" data-err>This field is required.</div>
      <div style="display:flex;gap:8px">
        <button type="button" class="btn" style="flex:1;justify-content:center" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" style="flex:1;justify-content:center" data-act="ok">${esc(opts.okLabel || 'Submit')}</button>
      </div>
    `, (ov) => {
      const field = ov.querySelector('.form-input');
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) finish(null); });
      ov.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
      const submit = () => {
        const val = field.value.trim();
        if (required && !val) { ov.querySelector('[data-err]').style.display = 'block'; field.focus(); return; }
        finish(val || null);
      };
      ov.querySelector('[data-act="ok"]').addEventListener('click', submit);
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) { e.preventDefault(); submit(); } });
      field.focus();
      if (opts.value) field.select();
    }, () => finish(null));
  });
}

// Resolves with the submitted <form> element (read it with FormData or
// querySelector) or null if cancelled.
function formModal(title, fieldsHtml, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    function finish(val) { _closeUiModal(); resolve(val); }
    _openUiModal(`
      <div class="section-title" style="margin-bottom:14px"><i class="fa-solid ${opts.icon || 'fa-pen'}"></i> ${esc(title)}</div>
      <form id="ui-modal-form">${fieldsHtml}
        <div style="display:flex;gap:8px;margin-top:16px">
          <button type="button" class="btn" style="flex:1;justify-content:center" data-act="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" style="flex:1;justify-content:center">${esc(opts.submitLabel || 'Save')}</button>
        </div>
      </form>
    `, (ov) => {
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) finish(null); });
      ov.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
      const form = ov.querySelector('#ui-modal-form');
      form.addEventListener('submit', (e) => { e.preventDefault(); finish(form); });
      ov.querySelector('input,select,textarea')?.focus();
      if (typeof opts.onMount === 'function') opts.onMount(ov, form);
    }, () => finish(null), opts.wide === false ? 380 : 560);
  });
}

// Pull a plain object out of a formModal form.
function formValues(form) {
  const o = {};
  new FormData(form).forEach((v, k) => {
    if (o[k] === undefined) o[k] = v;
    else if (Array.isArray(o[k])) o[k].push(v);
    else o[k] = [o[k], v];
  });
  form.querySelectorAll('input[type=checkbox]').forEach(c => {
    if (!c.name) return;
    if (c.dataset.multi === undefined) o[c.name] = c.checked;
  });
  return o;
}

// ── Shared top nav ─────────────────────────────────────────────
// Fills any EMPTY .topnav-links with the right links for the signed-in
// role, so the menu persists as you move between pages. admin.html
// hardcodes its own (its tabs are in-page view switches, not URLs), and
// this leaves any non-empty nav alone.
function renderTopNav() {
  const el = document.querySelector('.topnav-links');
  if (!el || el.children.length) return;
  const prof = getProfile();
  if (!prof) return;
  const path = window.location.pathname;
  const link = (href, icon, label) =>
    `<a class="nav-item${path === href.split('#')[0] ? ' active' : ''}" href="${href}" style="text-decoration:none"><i class="fa-solid ${icon}"></i><span>${label}</span></a>`;
  let items = '';
  if (prof.role === 'admin') {
    items = link('/pages/staff.html', 'fa-right-left', 'Check In / Out')
      + link('/pages/board.html', 'fa-tower-observation', 'Out Now')
      + link('/pages/assets.html', 'fa-boxes-stacked', 'Assets')
      + link('/pages/reports.html', 'fa-chart-line', 'Reports')
      + link('/pages/admin.html', 'fa-gear', 'Admin');
  } else if (prof.role === 'staff') {
    items = link('/pages/staff.html', 'fa-right-left', 'Check In / Out')
      + link('/pages/board.html', 'fa-tower-observation', 'Out Now')
      + link('/pages/assets.html', 'fa-boxes-stacked', 'Assets');
  } else if (prof.role === 'leader') {
    items = link('/pages/board.html', 'fa-tower-observation', 'Out Now')
      + link('/pages/assets.html', 'fa-boxes-stacked', 'Assets');
  }
  if (items) el.innerHTML = items;
}

// Fills the .topnav-user block from the stored profile.
function renderUserChip() {
  const prof = getProfile();
  if (!prof) return;
  const nameEl = document.getElementById('user-name');
  const roleEl = document.getElementById('user-role-label');
  const avatar = document.getElementById('user-avatar');
  if (nameEl) nameEl.textContent = prof.full_name || prof.email;
  if (roleEl) roleEl.textContent = { admin: 'Administrator', staff: 'Counter staff', leader: 'Leadership' }[prof.role] || prof.role;
  if (avatar) {
    const initials = (prof.full_name || prof.email || '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase();
    avatar.innerHTML = prof.photo_url
      ? `<img src="${esc(prof.photo_url)}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover" />`
      : esc(initials);
  }
}

(function initChrome() {
  const go = () => { renderTopNav(); renderUserChip(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();
