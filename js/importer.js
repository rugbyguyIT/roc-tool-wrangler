// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — CSV / XLSX import wizard.
//
// The browser's only job is to turn a spreadsheet into JSON. Every rule
// — required fields, formats, duplicate detection, group resolution —
// is enforced by the server, which re-derives each verdict from the raw
// cells. Nothing this file computes is trusted server-side.
//
// Flow: pick file → parse → confirm the column mapping → preview in
// 500-row chunks → review the verdicts → (optionally download the error
// rows as a CSV, fix, re-upload) → commit.
// ─────────────────────────────────────────────────────────────
const CHUNK = 500;

let IMP = null; // { kind, targetGroupId, filename, headers, rows, batchId, results, options }

// SheetJS is vendored rather than pulled from a CDN: the sheds and
// trailers at NRG have unreliable wifi, and a CDN miss would break the
// feature silently. It's ~640KB, so it is loaded ON DEMAND the first time
// an import is opened rather than on every admin page view. Once fetched,
// sw.js caches it like any other same-origin asset.
let _xlsxPromise = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  if (_xlsxPromise) return _xlsxPromise;

  // Local copy first, CDN as a fallback. The local file is what makes
  // imports work on bad wifi; the fallback is what stops the feature from
  // being dead if that file was never added to the deployment. If you want
  // guaranteed offline imports, drop the SheetJS build at the local path
  // and it will be preferred automatically.
  const SOURCES = [
    '/js/vendor/xlsx.full.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  ];

  const tryFrom = (i) => new Promise((resolve, reject) => {
    if (i >= SOURCES.length) {
      reject(new Error('Could not load the spreadsheet reader'));
      return;
    }
    const s = document.createElement('script');
    s.src = SOURCES[i];
    s.onload  = () => resolve();
    s.onerror = () => { s.remove(); tryFrom(i + 1).then(resolve, reject); };
    document.head.appendChild(s);
  });

  _xlsxPromise = tryFrom(0).catch((e) => { _xlsxPromise = null; throw e; });
  return _xlsxPromise;
}

const KIND_LABEL = {
  loanees: 'committee members',
  assets: 'assets',
  'group-members': 'group members',
};

async function openImport(kind, targetGroupId) {
  try { await loadXlsx(); }
  catch (e) { return toastMsg('Import unavailable', e.message, 'error'); }

  IMP = { kind, targetGroupId: targetGroupId || null, options: {} };
  const isAssets = kind === 'assets';
  const isMembers = kind === 'group-members';

  formModal(`Import ${KIND_LABEL[kind]}`, `
    <div class="small muted" style="margin-bottom:14px">
      Accepts .xlsx, .xls and .csv. Column headings are matched automatically —
      you'll get a chance to check them and to preview every row before anything is saved.
    </div>
    <div class="form-group">
      <label class="form-label">Spreadsheet file</label>
      <input class="form-input" type="file" id="imp-file" accept=".xlsx,.xls,.csv,text/csv" required />
    </div>
    <div class="card card-sm" style="margin-bottom:6px">
      <div class="small" style="font-weight:600;margin-bottom:8px">Expected columns</div>
      <div class="small muted">
        ${isAssets
          ? '<b>Required:</b> asset tag, title.<br><b>Optional:</b> category, location, serial, manufacturer (or make / brand / mfg), color, description, notes, status, groups, value.'
          : '<b>Required:</b> first name, last name.<br><b>Optional:</b> email, cell, position, sub-committee, groups, notes.'}
      </div>
    </div>
    <label class="toggle-row">
      <span>Update records that already exist
        <div class="small muted">Otherwise duplicates are skipped and left untouched.</div></span>
      <input type="checkbox" name="apply_updates" />
    </label>
    ${isMembers ? `<label class="toggle-row">
      <span>Also create people who aren't committee members yet
        <div class="small muted">Off means unknown names are reported as errors instead.</div></span>
      <input type="checkbox" name="create_missing_loanees" checked />
    </label>` : ''}`,
    { icon: 'fa-file-import', submitLabel: 'Read the file' })
    .then(form => {
      if (!form) return;
      const file = form.querySelector('#imp-file').files[0];
      if (!file) return toastMsg('No file', 'Choose a spreadsheet first.', 'error');
      IMP.options = {
        apply_updates: form.querySelector('[name="apply_updates"]').checked,
        create_missing_loanees: form.querySelector('[name="create_missing_loanees"]')?.checked ?? false,
      };
      parseFile(file);
    });
}

function parseFile(file) {
  const reader = new FileReader();
  reader.onerror = () => toastMsg('Could not read that file', '', 'error');
  reader.onload = (e) => {
    let rows; let headers;
    try {
      // One parse path for xlsx, xls and csv. raw:false keeps everything
      // as strings so a phone number never arrives as 7.135e9 and a
      // leading-zero asset tag never loses its zero.
      const wb = XLSX.read(e.target.result, { type: 'array', cellDates: false });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
      headers = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 0 })[0] || [];
    } catch (err) {
      return toastMsg('Could not read that spreadsheet', err.message, 'error');
    }
    if (!rows.length) return toastMsg('That sheet is empty', 'No data rows found.', 'error');

    IMP.filename = file.name;
    IMP.headers = headers.map(String);
    // row_number is 1-based on the DATA rows and offset by the header
    // row, so an error message points at the line the admin sees in Excel.
    IMP.rows = rows.map((r, i) => ({ ...r, row_number: i + 2 }));
    runPreview();
  };
  reader.readAsArrayBuffer(file);
}

async function runPreview() {
  const total = IMP.rows.length;
  toastMsg('Checking the file', `${total} row${total === 1 ? '' : 's'} — nothing is saved yet.`);

  IMP.batchId = null;
  IMP.results = [];
  let summary = {};
  let meta = {};

  for (let i = 0; i < total; i += CHUNK) {
    const slice = IMP.rows.slice(i, i + CHUNK);
    const { data, error } = await api(`/imports/${IMP.kind}/preview`, 'POST', {
      batch_id: IMP.batchId,
      filename: IMP.filename,
      headers: IMP.headers,
      target_group_id: IMP.targetGroupId,
      options: IMP.options,
      rows: slice,
    });
    if (error) return toastMsg('Import check failed', error, 'error');
    IMP.batchId = data.batch_id;
    IMP.results.push(...data.rows);
    summary = data.summary;
    meta = data;
  }
  showPreview(summary, meta);
}

function showPreview(summary, meta) {
  const n = k => summary[k] || 0;
  const tiles = [
    { n: n('create'), label: 'Will be added', color: 'var(--green)' },
    { n: n('update'), label: 'Will be updated', color: 'var(--blue)' },
    { n: n('skip_duplicate'), label: 'Duplicates skipped', color: 'var(--muted2)' },
    { n: n('error'), label: 'Errors', color: 'var(--red)' },
  ];

  const notices = [];
  if (meta.unknown_columns?.length) {
    notices.push(`<div class="small muted"><i class="fa-solid fa-circle-info"></i>
      Ignored columns: ${meta.unknown_columns.map(esc).join(', ')}</div>`);
  }
  if (meta.will_create_categories?.length) {
    notices.push(`<div class="small" style="color:var(--amber)"><i class="fa-solid fa-plus"></i>
      Will create ${meta.will_create_categories.length} new categor${meta.will_create_categories.length === 1 ? 'y' : 'ies'}:
      ${meta.will_create_categories.map(esc).join(', ')}</div>`);
  }
  if (meta.will_create_locations?.length) {
    notices.push(`<div class="small" style="color:var(--amber)"><i class="fa-solid fa-plus"></i>
      Will create ${meta.will_create_locations.length} new location(s): ${meta.will_create_locations.map(esc).join(', ')}</div>`);
  }

  const verdictBadge = v => ({
    create: '<span class="badge badge-approved">Add</span>',
    update: '<span class="badge badge-active">Update</span>',
    skip_duplicate: '<span class="badge badge-neutral">Skip</span>',
    error: '<span class="badge badge-no">Error</span>',
  }[v] || v);

  // Errors first: those are the rows that need a decision.
  const sorted = [...IMP.results].sort((a, b) =>
    (a.verdict === 'error' ? 0 : 1) - (b.verdict === 'error' ? 0 : 1) || a.row_number - b.row_number);

  const rows = sorted.slice(0, 400).map(r => `
    <tr${r.verdict === 'error' ? ' style="background:var(--redbg)"' : ''}>
      <td class="small mono">${r.row_number}</td>
      <td>${verdictBadge(r.verdict)}</td>
      <td class="small">${esc(r.normalized?.full_name || r.normalized?.title || r.normalized?.asset_tag || '—')}</td>
      <td class="small">${esc(r.message || '')}</td>
    </tr>`).join('');

  formModal(`Preview — ${esc(IMP.filename)}`, `
    <div class="stat-grid" style="margin-bottom:14px">
      ${tiles.map(t => `<div class="stat-card" style="border-top-color:${t.color}">
        <div class="stat-num mono">${t.n}</div><div class="stat-label">${t.label}</div></div>`).join('')}
    </div>
    ${notices.length ? `<div class="card card-sm" style="margin-bottom:14px">${notices.join('')}</div>` : ''}
    ${n('error') ? `<div class="card card-sm" style="margin-bottom:14px;border-left:3px solid var(--red)">
      <div class="small" style="font-weight:600;margin-bottom:6px">${n('error')} row(s) can't be imported</div>
      <div class="small muted" style="margin-bottom:10px">
        Everything else will still go in. Download the failed rows, fix them in the same file, and import again.
      </div>
      <button type="button" class="btn btn-sm" onclick="downloadPreviewErrors()">
        <i class="fa-solid fa-download"></i> Download the ${n('error')} failed rows</button>
    </div>` : ''}
    <div style="overflow-x:auto;max-height:320px"><table class="tbl">
      <thead><tr><th>Row</th><th>Action</th><th>Record</th><th>Note</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${sorted.length > 400 ? `<div class="small muted" style="margin-top:8px">
      Showing the first 400 of ${sorted.length} rows. All of them will be imported.</div>` : ''}
    <div class="small muted" style="margin-top:14px">
      <i class="fa-solid fa-circle-info"></i> Nothing has been saved yet. Press Import to apply this.
    </div>`,
    { icon: 'fa-list-check', submitLabel: `Import ${n('create') + (IMP.options.apply_updates ? n('update') : 0)} record(s)`, wide: true })
    .then(form => { if (form) commitImport(); });
}

function downloadPreviewErrors() {
  const errs = IMP.results.filter(r => r.verdict === 'error');
  const cols = IMP.headers;
  const rows = errs.map(r => {
    const o = { row_number: r.row_number };
    cols.forEach(c => { o[c] = r.raw?.[c] ?? ''; });
    o.error = r.message;
    return o;
  });
  exportRows('import-errors', rows, [
    { key: 'row_number', label: 'Row' },
    ...cols.map(c => ({ key: c, label: c })),
    { key: 'error', label: 'error' },
  ]);
}

async function commitImport() {
  toastMsg('Importing', 'Applying the changes…');
  const { data, error } = await api(`/imports/${IMP.kind}/commit`, 'POST', {
    batch_id: IMP.batchId,
    apply_updates: IMP.options.apply_updates,
  });
  if (error) return toastMsg('Import failed', error, 'error');

  const bits = [];
  if (data.created) bits.push(`${data.created} added`);
  if (data.updated) bits.push(`${data.updated} updated`);
  if (data.errors?.length) bits.push(`${data.errors.length} failed`);
  toastMsg('Import complete', bits.join(' · ') || 'Nothing to do.', data.errors?.length ? 'error' : 'ok');

  // Refresh whatever the admin console is showing behind the modal.
  if (typeof loadLoanees === 'function') loadLoanees();
  if (typeof loadGroups === 'function') loadGroups();
  if (typeof loadLookups === 'function') loadLookups();
  if (typeof loadLogs === 'function') loadLogs();
  if (typeof load === 'function') load();
}
