// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — asset browse + detail.
// Readable by every role; editing is admin-only and the buttons simply
// aren't rendered for anyone else (the API enforces it for real).
// ─────────────────────────────────────────────────────────────
const me = requireLogin();
const isAdmin = me && me.role === 'admin';
const canService = me && ['admin', 'staff'].includes(me.role);

let CATEGORIES = [];
let LOCATIONS = [];
let GROUPS = [];
let ROWS = [];
let debounceTimer = null;
// Why a lookup list is empty, kept so the asset form can say so. An empty
// dropdown with no explanation is indistinguishable from a broken one, and
// that is exactly how this arrived as a bug report.
let LOOKUP_ERR = { categories: null, locations: null };

// Manufacturer suggestions. Seeded with the makes this committee is most
// likely to be holding, then topped up with whatever is already in the
// catalog so the list learns as equipment is added. It is a datalist, not
// a select — anything can still be typed, including a make nobody here has
// seen before. The point is only that the common ones land spelled the
// same way every time, because three spellings of "Club Car" is what makes
// a report grouped by manufacturer worthless.
const MANUFACTURER_SEED = [
  'Club Car', 'E-Z-GO', 'Yamaha',              // golf carts
  'Toyota', 'Hyster', 'Crown', 'John Deere',   // forklifts and loaders
  'Motorola', 'Kenwood',                       // radios
  'DeWalt', 'Milwaukee', 'Makita', 'Honda',    // tools and generators
];
function manufacturerList() {
  const seen = new Set(MANUFACTURER_SEED);
  for (const a of ROWS) if (a.manufacturer) seen.add(a.manufacturer);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function filters() {
  const g = document.getElementById('f-group').value;
  const p = new URLSearchParams();
  const q = document.getElementById('f-q').value.trim();
  if (q) p.set('q', q);
  const st = document.getElementById('f-status').value;
  if (st) p.set('status', st);
  const c = document.getElementById('f-category').value;
  if (c) p.set('category_id', c);
  const l = document.getElementById('f-location').value;
  if (l) p.set('location_id', l);
  if (g === '__none') p.set('restricted', '0');
  else if (g === '__any') p.set('restricted', '1');
  else if (g) p.set('group_id', g);
  return p;
}

function clearFilters() {
  ['f-q', 'f-status', 'f-category', 'f-location', 'f-group'].forEach(id => { document.getElementById(id).value = ''; });
  load();
}

async function load() {
  const { data, error } = await api(`/assets?${filters()}`);
  if (error) { toastMsg('Could not load assets', error, 'error'); return; }
  ROWS = data.rows;
  const s = data.by_status || {};
  document.getElementById('page-sub').innerHTML =
    `${data.total} shown · ${s.available || 0} available · ${s.checked_out || 0} out · ${s.maintenance || 0} in maintenance`;
  render();
}

function render() {
  const el = document.getElementById('results');
  if (!ROWS.length) {
    // An empty catalog and a filter that matched nothing are different
    // situations. Blaming filters nobody has touched reads as a bug and
    // sends people hunting for a filter to clear.
    const filtered = [...filters().keys()].length > 0;
    el.innerHTML = `<div class="card"><div style="padding:34px;text-align:center">
      <div style="font-weight:600">${filtered
        ? 'No assets match those filters.'
        : 'No equipment in the catalog yet.'}</div>
      ${filtered
        ? '<div class="small muted" style="margin-top:6px">Clear the filters to see everything.</div>'
        : (isAdmin ? '<div class="small muted" style="margin-top:6px">Add one with the button above, or import a spreadsheet from Admin → Assets.</div>' : '')}
    </div></div>`;
    return;
  }
  const rows = ROWS.map(a => `
    <tr style="cursor:pointer" onclick="openAsset('${a.id}')">
      <td style="width:56px">${assetThumb(a.primary_photo_url, 40)}</td>
      <td>
        <div style="font-weight:600">${esc(a.title)}</div>
        <div class="small muted mono">${esc(a.asset_tag)}</div>
      </td>
      <td class="small">${esc(a.category || '—')}
        ${assetMarkings(a)}</td>
      <td>${statusBadge(a.status, a.current_overdue)}</td>
      <td class="small">${esc(a.location || '—')}</td>
      <td class="small">${a.current_loanee
        ? `<b>${esc(a.current_loanee)}</b>${a.current_due_at ? `<div class="muted">due ${esc(fmtWhen(a.current_due_at))}</div>` : ''}`
        : '<span class="muted">—</span>'}</td>
      <td class="small">${a.restriction_count
        ? `<span class="badge badge-neutral"><i class="fa-solid fa-user-lock"></i> ${a.restriction_count}</span>`
        : ''}</td>
    </tr>`).join('');

  el.innerHTML = `<div class="card" style="padding:8px 14px 4px;overflow-x:auto">
    <table class="tbl">
      <thead><tr>
        <th></th><th>Asset</th><th>Category</th><th>Status</th>
        <th>Location</th><th>Currently with</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// ── Detail ──────────────────────────────────────
async function openAsset(id) {
  const { data: a, error } = await api(`/assets/${id}`);
  if (error) return toastMsg('Could not open that asset', error, 'error');
  const { data: events } = await api(`/assets/${id}/events?limit=60`);

  const photos = a.photos.length
    ? `<div style="display:flex;gap:8px;overflow-x:auto;margin-bottom:16px">
        ${a.photos.map(p => `<div style="position:relative;flex:0 0 auto">
          <img src="${esc(p.url)}" alt="" style="height:120px;border-radius:10px;border:1px solid var(--border)" />
          ${isAdmin ? `<button class="btn btn-sm btn-danger" style="position:absolute;top:6px;right:6px;padding:4px 8px"
            onclick="removePhoto('${a.id}','${p.id}')"><i class="fa-solid fa-trash"></i></button>` : ''}
        </div>`).join('')}
      </div>`
    : '';

  const current = a.current ? `
    <div class="card card-sm" style="margin-bottom:16px;border-left:3px solid ${a.current.overdue ? 'var(--red)' : 'var(--orange)'}">
      <div class="small muted">Currently with</div>
      <div style="font-weight:700;font-size:16px">${esc(a.current.loanee_name)}</div>
      <!-- Committee is absent for a Base session. Joining the parts rather
           than concatenating avoids a stray leading "·" when it is. -->
      <div class="small">${[
        a.current.sub_committee ? esc(a.current.sub_committee) : '',
        a.current.loanee_phone ? `<a href="tel:${esc(a.current.loanee_phone)}">${esc(fmtPhone(a.current.loanee_phone))}</a>` : '',
      ].filter(Boolean).join(' · ')}</div>
      <div class="small ${a.current.overdue ? '' : 'muted'}" style="${a.current.overdue ? 'color:var(--red);font-weight:600' : ''}">
        Out ${esc(fmtAgo(a.current.checked_out_at))}${a.current.due_at ? ` · due ${esc(fmtWhen(a.current.due_at))}` : ' · no due date'}
        ${a.current.overdue ? ' · OVERDUE' : ''}
      </div>
    </div>` : '';

  const fields = [
    ['Tag', `<span class="mono">${esc(a.asset_tag)}</span>`],
    ['Category', esc(a.category || '—')],
    ['Manufacturer', esc(a.manufacturer || '—')],
    ['Color', a.color ? colorChip(a.color) : '—'],
    ['Location', esc(a.location || '—')],
    ['Description', esc(a.description || '—')],
    ['Notes', esc(a.notes || '—')],
    ['Restricted to', a.groups.length
      ? a.groups.map(g => `<span class="class-chip class-exec">${esc(g.name)}</span>`).join(' ')
      : '<span class="muted">Anyone may borrow it</span>'],
    ['Value', a.value_cents != null ? `$${(a.value_cents / 100).toFixed(2)}` : '—'],
  ].map(([k, v]) => `<tr><th style="width:140px">${k}</th><td>${v}</td></tr>`).join('');

  const actions = [];
  if (canService) {
    // ONE way to take something out of service. There used to be two —
    // "To maintenance" flipped the status and nothing else, "Send for
    // repair" flipped the same status AND recorded who has it, what is
    // wrong, when it is due back and what it cost. Same workflow at the
    // counter, two buttons, and no rule for choosing between them. The
    // tracked one does everything the bare one did, so the bare one is
    // gone; the shop pre-fills from the asset's category, which keeps the
    // quick case down to one field.
    if (['available', 'maintenance'].includes(a.status)) actions.push(`<button class="btn btn-sm" onclick="sendForRepair('${a.id}','${esc(a.asset_tag)}','${a.default_repair_shop_id || ''}')"><i class="fa-solid fa-screwdriver-wrench"></i> Send for repair</button>`);
    if (a.status === 'maintenance') actions.push(`<button class="btn btn-sm btn-success" onclick="assetAction('${a.id}','maintenance_end')"><i class="fa-solid fa-circle-check"></i> Back in service</button>`);
  }
  if (isAdmin) {
    if (['available', 'maintenance'].includes(a.status)) actions.push(`<button class="btn btn-sm btn-danger" onclick="assetAction('${a.id}','retire')"><i class="fa-solid fa-box-archive"></i> Retire</button>`);
    if (a.status === 'retired') actions.push(`<button class="btn btn-sm" onclick="assetAction('${a.id}','unretire')"><i class="fa-solid fa-rotate-left"></i> Un-retire</button>`);
    actions.push(`<button class="btn btn-sm" onclick="editAsset('${a.id}')"><i class="fa-solid fa-pen"></i> Edit</button>`);
    actions.push(`<button class="btn btn-sm" onclick="editRestrictions('${a.id}')"><i class="fa-solid fa-user-lock"></i> Restrictions</button>`);
    actions.push(`<button class="btn btn-sm" onclick="addPhoto('${a.id}')"><i class="fa-solid fa-camera"></i> Photo</button>`);
  }
  // Retire is deliberately unavailable while the item is out — the API
  // refuses it too. Explain why rather than leaving a mystery gap.
  const retireNote = a.status === 'checked_out' && isAdmin
    ? `<div class="small muted" style="margin-top:8px"><i class="fa-solid fa-circle-info"></i>
       Check it back in before retiring it, so the custody record stays complete.</div>` : '';

  await formModal(
    `${a.asset_tag} — ${a.title}`,
    `${photos}
     <div style="margin-bottom:14px">${statusBadge(a.status, a.current?.overdue)}</div>
     ${current}
     <div style="overflow-x:auto"><table class="tbl">${fields}</table></div>
     ${actions.length ? `<div class="pill-row" style="margin-top:16px">${actions.join('')}</div>${retireNote}` : ''}
     <div class="section-title" style="margin:22px 0 10px"><i class="fa-solid fa-clock-rotate-left"></i> History</div>
     <ul class="tline">${(events || []).map(eventLine).join('') || '<li class="small muted">No history yet.</li>'}</ul>`,
    { icon: 'fa-box', submitLabel: 'Close', wide: true }
  );
}

async function assetAction(id, action) {
  let reason = null;
  if (['maintenance_start', 'retire'].includes(action)) {
    reason = await promptModal(
      action === 'retire'
        ? 'This is recorded permanently against the asset.'
        : 'What needs doing? Base members will see this on the asset.',
      { title: action === 'retire' ? 'Why retire it?' : 'What\'s wrong with it?', required: true, multiline: true });
    if (!reason) return;
  }
  const { error } = await api(`/assets/${id}/action`, 'POST', { action, reason });
  if (error) return toastMsg('Could not do that', error, 'error');
  toastMsg('Done', 'The asset has been updated.', 'ok');
  _closeUiModal();
  load();
}

// ── Admin editing ─────────────────────────────────
// An empty dropdown has to say why it is empty. There are three reasons and
// they need three different actions from whoever is standing there:
// the request failed, nothing has been set up yet, or everything that exists
// was filtered out of this particular list.
function lookupNote(kind, list, err, extra) {
  if (err) {
    return `<div class="small" style="color:var(--red);margin-top:6px">
      Could not load ${kind}: ${esc(err)}</div>`;
  }
  if (!list.length) {
    return `<div class="small" style="color:var(--amber);margin-top:6px">
      No ${kind} have been set up yet — add them under
      <a href="/pages/admin.html#sec-lookups">Admin → Lookups</a>.</div>`;
  }
  return extra || '';
}

function assetFormFields(a) {
  a = a || {};
  const opts = (list, sel) => `<option value="">—</option>` +
    list.map(x => `<option value="${x.id}"${x.id === sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('');

  // Repair destinations (EAC/ADC, the maintenance barn) are where equipment
  // goes when it breaks, not where it lives — an asset gets there via Send
  // for repair, which already records who has it. A currently-set one is
  // kept so editing an older asset does not silently clear its location.
  //
  // But if every location is flagged as a repair destination, excluding them
  // leaves an empty dropdown and no way to save a location at all. An
  // imperfect list beats a dead control, so in that case show all of them
  // and say what happened.
  const homes = LOCATIONS.filter(l => !l.is_repair_destination || l.id === a.location_id);
  const locList = homes.length ? homes : LOCATIONS;
  const locNote = (!homes.length && LOCATIONS.length)
    ? `<div class="small" style="color:var(--amber);margin-top:6px">
         Every location is marked as a repair destination, so they are all
         listed here. Untick that on the ones equipment actually lives at,
         under <a href="/pages/admin.html#sec-lookups">Admin → Lookups</a>.</div>`
    : '';

  return `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Asset tag *</label>
        <input class="form-input" name="asset_tag" required value="${esc(a.asset_tag || '')}" placeholder="ROCFEL05" />
      </div>
      <div class="form-group">
        <label class="form-label">Name *</label>
        <input class="form-input" name="title" required value="${esc(a.title || '')}" placeholder="ROC Front End Loader 05" />
      </div>
    </div>
    <!-- Photo lives on the form for both create and edit. Previously it was
         only reachable from the detail screen, which meant every new asset
         was created without one and someone had to remember to go back. -->
    <div class="form-group">
      <label class="form-label">Photo</label>
      <input class="form-input" type="file" name="photo_file" accept="image/*" />
      <div class="small muted">${a.primary_photo_url
        ? 'Choosing a new one adds it alongside the existing photos.'
        : 'Optional — a picture makes it far easier to find at the counter.'}</div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Category</label>
        <select class="form-input" name="category_id">${opts(CATEGORIES, a.category_id)}</select>
        ${lookupNote('categories', CATEGORIES, LOOKUP_ERR.categories)}
      </div>
      <div class="form-group">
        <label class="form-label">Location</label>
        <select class="form-input" name="location_id">${opts(locList, a.location_id)}</select>
        ${lookupNote('locations', LOCATIONS, LOOKUP_ERR.locations, locNote)}
      </div>
    </div>
    <!-- Colour and manufacturer sit next to each other because they answer
         the same question: which of these two identical-looking carts is
         this one. -->
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Color</label>
        <input class="form-input" name="color" value="${esc(a.color || '')}"
               placeholder="White" list="asset-colors" autocomplete="off" />
        <datalist id="asset-colors">
          ${['White', 'Black', 'Red', 'Blue', 'Green', 'Orange', 'Yellow', 'Grey', 'Tan', 'Camo']
            .map(c => `<option value="${c}"></option>`).join('')}
        </datalist>
      </div>
      <div class="form-group">
        <label class="form-label">Manufacturer</label>
        <input class="form-input" name="manufacturer" value="${esc(a.manufacturer || '')}"
               placeholder="Club Car" list="asset-mfrs" autocomplete="off" />
        <!-- Suggestions, not a fixed list: a datalist still accepts anything
             typed, so a one-off make is never blocked, but the common ones
             land spelled the same way every time. Three spellings of
             "Club Car" is what makes a report by manufacturer useless. -->
        <datalist id="asset-mfrs">
          ${manufacturerList().map(m => `<option value="${esc(m)}"></option>`).join('')}
        </datalist>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input class="form-input" name="description" value="${esc(a.description || '')}" />
    </div>
    <div class="form-group">
      <label class="form-label">Notes</label>
      <textarea class="form-input" name="notes" rows="2">${esc(a.notes || '')}</textarea>
    </div>`;
}

// The photo is uploaded AFTER the asset is saved, because it needs the
// asset's id. A failed photo never fails the save — the asset is the thing
// that matters, and a missing picture is fixable in one click.
async function uploadFormPhoto(form, assetId) {
  const input = form.querySelector('[name="photo_file"]');
  const file = input && input.files && input.files[0];
  if (!file) return;
  try {
    toastMsg('Uploading the photo', 'Resizing and sending…');
    const dataUrl = await fileToDataUrl(file);
    const { error } = await api(`/assets/${assetId}/photos`, 'POST', { mode: 'upload', data_url: dataUrl });
    if (error) toastMsg('Saved, but the photo failed', error, 'error');
  } catch (e) {
    toastMsg('Saved, but the photo failed', e.message, 'error');
  }
}

async function newAsset() {
  const form = await formModal('New asset', assetFormFields(), { icon: 'fa-plus', submitLabel: 'Create' });
  if (!form) return;
  const v = formValues(form);
  delete v.photo_file;                 // sent separately, not as a field
  const { data, error } = await api('/assets', 'POST', v);
  if (error) return toastMsg('Could not create it', error, 'error');
  const newId = data?.asset?.id || data?.id;
  if (newId) await uploadFormPhoto(form, newId);
  toastMsg('Asset created', `${v.asset_tag} is in the catalog.`, 'ok');
  load();
}

async function editAsset(id) {
  const { data: a } = await api(`/assets/${id}`);
  if (!a) return;
  const form = await formModal(`Edit ${a.asset_tag}`, assetFormFields(a), { icon: 'fa-pen' });
  if (!form) return;
  const v = formValues(form);
  delete v.photo_file;
  const { error } = await api(`/assets/${id}`, 'PATCH', v);
  if (error) return toastMsg('Could not save', error, 'error');
  await uploadFormPhoto(form, id);
  toastMsg('Saved', 'The asset has been updated.', 'ok');
  load();
}

async function editRestrictions(id) {
  const { data: a } = await api(`/assets/${id}`);
  if (!a) return;
  const have = new Set(a.groups.map(g => g.id));
  const fields = `
    <div class="small muted" style="margin-bottom:12px">
      Tick the groups allowed to borrow this. Leave everything unticked and anyone may borrow it.
    </div>
    ${GROUPS.map(g => `
      <label class="toggle-row" style="cursor:pointer">
        <span>
          <span style="font-weight:600">${esc(g.name)}</span>
          <span class="small muted"> · ${g.member_count} member${g.member_count === 1 ? '' : 's'}</span>
        </span>
        <input type="checkbox" name="g" data-multi value="${g.id}"${have.has(g.id) ? ' checked' : ''} />
      </label>`).join('') || '<div class="small muted">No groups exist yet — create some under Admin → Groups.</div>'}`;

  const form = await formModal(`Who can borrow ${a.asset_tag}?`, fields, { icon: 'fa-user-lock' });
  if (!form) return;
  const ids = [...form.querySelectorAll('input[name="g"]:checked')].map(c => c.value);
  const { error } = await api(`/assets/${id}/groups`, 'PATCH', { group_ids: ids });
  if (error) return toastMsg('Could not save', error, 'error');
  toastMsg('Restrictions saved', ids.length ? `Limited to ${ids.length} group(s).` : 'Anyone may borrow it now.', 'ok');
  load();
}

// Downscale before upload: base64 inflates bytes by a third and Static
// Web Apps caps request bodies, so a 12MP phone photo has to shrink
// before it ever hits the wire.
function fileToDataUrl(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image'));
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function addPhoto(id) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    toastMsg('Uploading', 'Resizing and sending the photo…');
    try {
      const dataUrl = await fileToDataUrl(file);
      const { error } = await api(`/assets/${id}/photos`, 'POST', { mode: 'upload', data_url: dataUrl });
      if (error) return toastMsg('Upload failed', error, 'error');
      toastMsg('Photo added', '', 'ok');
      _closeUiModal();
      load();
    } catch (e) { toastMsg('Upload failed', e.message, 'error'); }
  };
  input.click();
}

async function removePhoto(assetId, photoId) {
  const ok = await confirmModal('Delete this photo?', { confirmLabel: 'Delete' });
  if (!ok) return;
  const { error } = await api(`/assets/${assetId}/photos/${photoId}`, 'DELETE');
  if (error) return toastMsg('Could not delete', error, 'error');
  _closeUiModal();
  load();
}

// ── Boot ──────────────────────────────────────
(async function init() {
  if (!me) return;
  if (isAdmin) {
    document.getElementById('topbar-actions').innerHTML =
      `<button class="btn btn-primary" onclick="newAsset()"><i class="fa-solid fa-plus"></i> New Asset</button>`;
  }
  const [c, l, g] = await Promise.all([api('/categories'), api('/locations'), api('/groups')]);
  CATEGORIES = c.data || []; LOCATIONS = l.data || []; GROUPS = g.data || [];
  LOOKUP_ERR = { categories: c.error || null, locations: l.error || null };
  CATEGORIES.forEach(x => document.getElementById('f-category').add(new Option(x.name, x.id)));
  LOCATIONS.forEach(x => document.getElementById('f-location').add(new Option(x.name, x.id)));
  GROUPS.forEach(x => document.getElementById('f-group').add(new Option(x.name, x.id)));

  document.getElementById('f-q').addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(load, 250);
  });
  ['f-status', 'f-category', 'f-location', 'f-group'].forEach(id =>
    document.getElementById(id).addEventListener('change', load));

  load();
})();
