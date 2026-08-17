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
  if (p.unknown_columns?.length) {
    notes.push(`<div class="small muted"><i class="fa-solid fa-circle-info"></i>
      Ignored columns: ${p.unknown_columns.map(esc).join(', ')}</div>`);
  }

  // The mapping is always visible, not hidden behind an "advanced" link:
  // if the rodeo renames a column, the wrong-looking numbers above and the
  // mapping that caused them should be on the same screen.
  const mapped = Object.entries(p.column_map || {});
  notes.push(`<div class="small">
    <i class="fa-solid fa-right-left"></i> Columns in use:
    ${mapped.map(([h, f]) => `<span class="class-chip class-exec">${esc(h)} → ${esc(f)}</span>`).join(' ')}
    <div style="margin-top:8px">
      <button type="button" class="btn btn-sm" onclick="editRosterMapping()">
        <i class="fa-solid fa-pen"></i> Change column mapping</button>
      ${p.saved_map ? '<span class="small muted" style="margin-left:8px">Using your saved mapping.</span>' : ''}
    </div></div>`);

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
// Every column in the file gets a dropdown. Choosing "(ignore)" is a real
// choice, not an absence — it is what stops a renamed column silently
// falling back to auto-detection on the next run.
function editRosterMapping() {
  const p = RS.preview || {};
  const fields = p.mappable_fields || [];
  const current = RS.columnMap || p.column_map || {};

  formModal('Column mapping', `
    <div class="small muted" style="margin-bottom:14px">
      What each column in <b>${esc(RS.filename)}</b> means. Change anything that's wrong —
      what you confirm is saved and used automatically next time, so a changed export
      is a one-time fix.
    </div>
    <div style="max-height:400px;overflow:auto">
      ${RS.headers.map((h, i) => `
        <div class="form-row" style="align-items:center;margin-bottom:6px">
          <div class="form-group" style="margin:0">
            <div class="small mono">${esc(h)}</div>
            <div class="small muted">e.g. ${esc(String((RS.rows[0] || {})[h] ?? '').slice(0, 28) || '—')}</div>
          </div>
          <div class="form-group" style="margin:0">
            <select class="form-input" data-header="${esc(h)}">
              <option value="">(ignore this column)</option>
              ${fields.map(f => `<option value="${f.key}"${current[h] === f.key ? ' selected' : ''}>${esc(f.label)}</option>`).join('')}
            </select>
          </div>
        </div>`).join('')}
    </div>
    <div class="small muted" style="margin-top:12px">
      <i class="fa-solid fa-circle-info"></i> Member Number, First Name and Last Name are required —
      the import can't match people without them.
    </div>`,
    { icon: 'fa-right-left', submitLabel: 'Re-check the file', wide: true })
    .then(form => {
      if (!form) return;
      const map = {};
      form.querySelectorAll('select[data-header]').forEach(sel => {
        map[sel.getAttribute('data-header')] = sel.value;
      });
      const used = Object.values(map);
      for (const need of ['member_number', 'first_name', 'last_name']) {
        if (!used.includes(need)) {
          return toastMsg('Mapping incomplete',
            `Nothing is mapped to ${need.replace(/_/g, ' ')}. The import can't run without it.`, 'error');
        }
      }
      RS.columnMap = map;
      RS.batchId = null;          // a different mapping is a different import
      runRosterPreview();
    });
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
