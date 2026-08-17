// ═══════════════════════════════════════════════════════════════════════
// Roster sync — the Rodeo Operations export, loaded and re-loaded.
//
// Separate from the general import wizard (js/importer.js) because it
// answers a different question. That one asks "add these rows"; this one
// asks "make the app match this file", and the number that matters most
// on screen is not how many will be added — it is how many will be
// CHANGED and how many will be switched off, because those are the ones
// that surprise people.
//
// Reuses loadXlsx() from importer.js for parsing.
// ═══════════════════════════════════════════════════════════════════════
const ROSTER_CHUNK = 250;
let RS = null;   // { filename, headers, rows, batchId, preview, columnMap }

async function openRosterSync() {
  try { await loadXlsx(); }
  catch (e) { return toastMsg('Roster sync unavailable', e.message, 'error'); }

  formModal('Sync the Rodeo Operations roster', `
    <div class="small muted" style="margin-bottom:14px">
      Load the roster export to add new members and update the ones whose details
      have changed. Safe to run as often as you like — nothing is written until you
      approve the preview.
    </div>
    <div class="form-group">
      <label class="form-label">Roster export (.xls, .xlsx or .csv)</label>
      <input class="form-input" type="file" id="rs-file" accept=".xls,.xlsx,.csv,text/csv" required />
    </div>
    <div class="card card-sm">
      <div class="small" style="font-weight:600;margin-bottom:8px">What a sync changes</div>
      <div class="small muted">
        Matched on <b>Customer Number</b>, shown in the app as Member Number.<br>
        Updates only: first name (preferred name wins), last name, title, committee,
        primary phone, primary email.<br>
        Never touched: notes, group membership you set by hand, and passwords.
      </div>
    </div>`,
    { icon: 'fa-rotate', submitLabel: 'Read the file' })
    .then(form => {
      if (!form) return;
      const file = form.querySelector('#rs-file').files[0];
      if (!file) return toastMsg('No file', 'Choose the roster export first.', 'error');
      parseRoster(file);
    });
}

function parseRoster(file) {
  const reader = new FileReader();
  reader.onerror = () => toastMsg('Could not read that file', '', 'error');
  reader.onload = (e) => {
    let rows, headers;
    try {
      // raw:false keeps everything a string, so a customer number never
      // arrives as 1.175843e6 and a zip never loses a leading zero.
      const wb = XLSX.read(e.target.result, { type: 'array', cellDates: false });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
      headers = (XLSX.utils.sheet_to_json(sheet, { header: 1, range: 0 })[0] || []).map(String);
    } catch (err) {
      return toastMsg('Could not read that spreadsheet', err.message, 'error');
    }
    if (!rows.length) return toastMsg('That sheet is empty', 'No data rows found.', 'error');

    RS = { filename: file.name, headers, rows: rows.map((r, i) => ({ ...r, row_number: i + 2 })), batchId: null, columnMap: null };
    runRosterPreview();
  };
  reader.readAsArrayBuffer(file);
}

async function runRosterPreview() {
  const total = RS.rows.length;
  toastMsg('Checking the roster', `${total} row${total === 1 ? '' : 's'} — nothing is saved yet.`);

  let last = null;
  for (let i = 0; i < total; i += ROSTER_CHUNK) {
    const slice = RS.rows.slice(i, i + ROSTER_CHUNK);
    const final = i + ROSTER_CHUNK >= total;
    const { data, error } = await api('/roster/preview', 'POST', {
      batch_id: RS.batchId, filename: RS.filename, headers: RS.headers, rows: slice, final,
      column_map: RS.columnMap || undefined,
    });
    if (error) return toastMsg('Roster check failed', error, 'error');
    RS.batchId = data.batch_id;
    last = data;
  }
  RS.preview = last;
  showRosterPreview(last);
}

function showRosterPreview(p) {
  const s = p.summary || {};
  const n = k => s[k] || 0;

  const tiles = [
    { n: n('create'),     label: 'New members',   color: 'var(--green)' },
    { n: n('update'),     label: 'Changed',       color: 'var(--blue)' },
    { n: n('unchanged'),  label: 'No change',     color: 'var(--muted2)' },
    { n: n('deactivate'), label: 'Off the roster', color: 'var(--amber)' },
    { n: n('error'),      label: 'Errors',        color: 'var(--red)' },
  ];

  const notes = [];
  if (p.will_create_groups?.length) {
    notes.push(`<div class="small" style="color:var(--amber)"><i class="fa-solid fa-layer-group"></i>
      <b>First import:</b> ${p.will_create_groups.length} group(s) will be created from Subcommittee 1 —
      ${p.will_create_groups.map(esc).join(', ')}.
      <br><span class="muted">Groups are only ever created automatically once. After this, add them by hand.</span></div>`);
  }
  if (p.groups_already_seeded && p.unseeded_new_subcommittees?.length) {
    notes.push(`<div class="small" style="color:var(--amber)"><i class="fa-solid fa-circle-info"></i>
      New subcommittee(s) in this file with no matching group:
      ${p.unseeded_new_subcommittees.map(esc).join(', ')}.
      <br><span class="muted">Not created automatically — add them under Groups if you want them.</span></div>`);
  }
  const logins = (p.logins?.staff || 0) + (p.logins?.leader || 0);
  if (logins) {
    notes.push(`<div class="small"><i class="fa-solid fa-key"></i>
      Up to <b>${logins}</b> login(s) for people who don't have one yet —
      ${p.logins.staff || 0} Base, ${p.logins.leader || 0} Leadership.
      <br><span class="muted">Password is their 5-digit zip. Existing accounts are never changed.</span></div>`);
  }
  if (p.login_blocked?.length) {
    notes.push(`<div class="small muted"><i class="fa-solid fa-triangle-exclamation"></i>
      ${p.login_blocked.length} person(s) qualify for a login but can't get one yet
      (${esc(p.login_blocked[0].reason)}${p.login_blocked.length > 1 ? ', and others' : ''}).</div>`);
  }

  // One line, not a wall of chips. The detail lives in the mapping editor;
  // what belongs here is "did it understand the file, and how do I fix it".
  const mappedCount = Object.keys(p.column_map || {}).length;
  notes.push(`<div class="small" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span><i class="fa-solid fa-right-left"></i>
      Matched <b>${mappedCount}</b> column${mappedCount === 1 ? '' : 's'}${
        p.unknown_columns?.length ? `, ignoring ${p.unknown_columns.length}` : ''}.
      ${p.saved_map ? '<span class="muted">Using your saved matching.</span>' : ''}</span>
    <button type="button" class="btn btn-sm" onclick="editRosterMapping()">
      <i class="fa-solid fa-right-left"></i> Change matching</button>
  </div>`);

  const deact = (p.deactivate || []);
  const deactBlock = deact.length ? `
    <div class="card card-sm" style="margin-bottom:14px;border-left:3px solid var(--amber)">
      <div class="small" style="font-weight:600;margin-bottom:6px">
        ${deact.length} person(s) are in the app but not in this file</div>
      <div class="small muted" style="margin-bottom:8px">
        They'll be marked inactive so they stop appearing in pickers. Their history is kept,
        and re-importing a file that includes them again turns them straight back on.
      </div>
      <div class="small" style="max-height:120px;overflow:auto">
        ${deact.map(d => `${esc(d.full_name)} <span class="muted mono">${esc(d.member_number)}</span>`).join('<br>')}
      </div>
      <label class="toggle-row" style="margin-top:10px">
        <span>Apply these deactivations</span>
        <input type="checkbox" name="apply_deactivations" checked />
      </label>
    </div>` : '';

  formModal(`Roster preview — ${esc(RS.filename)}`, `
    <div class="stat-grid" style="margin-bottom:14px">
      ${tiles.map(t => `<div class="stat-card" style="border-top-color:${t.color}">
        <div class="stat-num mono">${t.n}</div><div class="stat-label">${t.label}</div></div>`).join('')}
    </div>
    ${notes.length ? `<div class="card card-sm" style="margin-bottom:14px">${notes.join('<hr class="sep">')}</div>` : ''}
    ${deactBlock}
    <div class="small muted">
      <i class="fa-solid fa-circle-info"></i> Nothing has been saved yet.
    </div>`,
    { icon: 'fa-rotate', submitLabel: `Apply ${n('create') + n('update') + n('deactivate')} change(s)`, wide: true })
    .then(form => {
      if (!form) return;
      const box = form.querySelector('[name="apply_deactivations"]');
      commitRoster(box ? box.checked : true);
    });
}

// ── Mapping editor ─────────────────────────────────────────────────────
// Two panels: your spreadsheet's columns on the left, the app's fields on
// the right. Drag a column onto a field to connect them.
//
// Tap-to-select then tap-to-place is a first-class path, not a fallback:
// HTML5 drag-and-drop does not fire on touch at all, and this gets used on
// a phone. Both paths run through the same assign() so they cannot drift.
let MAPSTATE = null;   // { map: {header: field}, picked: header|null }

function editRosterMapping() {
  const p = RS.preview || {};
  const fields = p.mappable_fields || [];
  MAPSTATE = { map: { ...(RS.columnMap || p.column_map || {}) }, picked: null };

  formModal('Match your spreadsheet to the app', `
    <div class="small muted" style="margin-bottom:12px">
      Drag a column from <b>${esc(RS.filename)}</b> onto the field it belongs to —
      or tap a column, then tap a field. What you confirm is saved and reused
      automatically next time.
    </div>
    <div class="map-wrap">
      <div class="map-col">
        <div class="map-col-head">Columns in your file</div>
        <div class="map-list" id="map-sources"></div>
      </div>
      <div class="map-col">
        <div class="map-col-head">Fields in the app</div>
        <div class="map-list" id="map-targets"></div>
      </div>
    </div>
    <div class="small muted" style="margin-top:12px">
      <i class="fa-solid fa-circle-info"></i> Columns left on the left are simply
      not imported. Member Number, First Name and Last Name are required.
    </div>`,
    {
      icon: 'fa-right-left', submitLabel: 'Re-check the file', wide: true,
      onMount: () => renderMapper(fields),
    })
    .then(form => {
      if (!form) { MAPSTATE = null; return; }
      const used = Object.values(MAPSTATE.map);
      for (const need of ['member_number', 'first_name', 'last_name']) {
        if (!used.includes(need)) {
          const label = (fields.find(f => f.key === need) || {}).label || need;
          return toastMsg('Not ready yet', `Nothing is matched to ${label}. The import can't run without it.`, 'error');
        }
      }
      // Headers deliberately left unmatched are recorded as '' rather than
      // omitted, so next month's import does not quietly re-detect them.
      const map = {};
      for (const h of RS.headers) map[h] = MAPSTATE.map[h] || '';
      RS.columnMap = map;
      RS.batchId = null;        // a different mapping is a different import
      MAPSTATE = null;
      runRosterPreview();
    });
}

function renderMapper(fields) {
  const srcEl = document.getElementById('map-sources');
  const tgtEl = document.getElementById('map-targets');
  if (!srcEl || !tgtEl) return;

  const taken = MAPSTATE.map;
  const unmapped = RS.headers.filter(h => !taken[h]);

  srcEl.innerHTML = unmapped.length
    ? unmapped.map(h => {
        const sample = String((RS.rows[0] || {})[h] ?? '').slice(0, 30);
        return `<div class="map-chip${MAPSTATE.picked === h ? ' is-picked' : ''}"
             draggable="true" data-header="${esc(h)}"
             ondragstart="mapDragStart(event,'${esc(h)}')"
             onclick="mapPick('${esc(h)}')">
          <div class="map-chip-name">${esc(h)}</div>
          <div class="map-chip-sample">${esc(sample || '—')}</div>
        </div>`;
      }).join('')
    : '<div class="map-empty">Every column is matched.</div>';

  tgtEl.innerHTML = fields.map(f => {
    const header = Object.keys(taken).find(h => taken[h] === f.key);
    return `<div class="map-slot${header ? ' is-filled' : ''}${f.required ? ' is-required' : ''}"
         data-field="${f.key}"
         ondragover="mapDragOver(event)" ondragleave="mapDragLeave(event)"
         ondrop="mapDrop(event,'${f.key}')" onclick="mapPlace('${f.key}')">
      <div class="map-slot-label">${esc(f.label)}${f.required ? ' <span class="map-slot-req">*</span>' : ''}</div>
      ${header
        ? `<div class="map-slot-value"><span>${esc(header)}</span>
             <button type="button" class="map-slot-clear" title="Unmatch"
               onclick="event.stopPropagation();mapClear('${f.key}')">
               <i class="fa-solid fa-xmark"></i></button></div>`
        : '<div class="map-chip-sample">Drop a column here</div>'}
    </div>`;
  }).join('');
}

// Assigning is one function so drag and tap can never behave differently.
// A field holds exactly one column, so anything already in the slot is
// released back to the left rather than silently overwritten.
function mapAssign(header, field) {
  if (!header || !field) return;
  for (const h of Object.keys(MAPSTATE.map)) {
    if (MAPSTATE.map[h] === field) delete MAPSTATE.map[h];
  }
  MAPSTATE.map[header] = field;
  MAPSTATE.picked = null;
  renderMapper(RS.preview?.mappable_fields || []);
}

function mapDragStart(e, header) {
  e.dataTransfer.setData('text/plain', header);
  e.dataTransfer.effectAllowed = 'move';
}
function mapDragOver(e) { e.preventDefault(); e.currentTarget.classList.add('is-over'); }
function mapDragLeave(e) { e.currentTarget.classList.remove('is-over'); }
function mapDrop(e, field) {
  e.preventDefault();
  e.currentTarget.classList.remove('is-over');
  mapAssign(e.dataTransfer.getData('text/plain'), field);
}
function mapPick(header) {
  MAPSTATE.picked = MAPSTATE.picked === header ? null : header;
  renderMapper(RS.preview?.mappable_fields || []);
}
function mapPlace(field) {
  if (!MAPSTATE.picked) return;   // a tap with nothing picked is not a mistake
  mapAssign(MAPSTATE.picked, field);
}
function mapClear(field) {
  for (const h of Object.keys(MAPSTATE.map)) {
    if (MAPSTATE.map[h] === field) delete MAPSTATE.map[h];
  }
  renderMapper(RS.preview?.mappable_fields || []);
}

async function commitRoster(applyDeactivations) {
  toastMsg('Syncing', 'Applying the roster…');
  const { data, error } = await api('/roster/commit', 'POST', {
    batch_id: RS.batchId, apply_deactivations: applyDeactivations,
  });
  if (error) return toastMsg('Roster sync failed', error, 'error');

  const bits = [];
  if (data.created) bits.push(`${data.created} added`);
  if (data.updated) bits.push(`${data.updated} updated`);
  if (data.deactivated) bits.push(`${data.deactivated} deactivated`);
  if (data.logins_created) bits.push(`${data.logins_created} login(s) created`);
  toastMsg('Roster synced', bits.join(' · ') || 'Nothing to change.',
    data.errors?.length ? 'error' : 'ok');

  if (typeof loadLoanees === 'function') loadLoanees();
  if (typeof loadGroups === 'function') loadGroups();
  if (typeof loadUsers === 'function') loadUsers();
}
