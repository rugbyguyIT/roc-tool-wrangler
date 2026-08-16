// ─────────────────────────────────────────────────────────────
// HLSR Asset Tracker — CSV export
//
// Export happens on the CLIENT, from exactly the JSON the report
// endpoint already returned. That means no second copy of any report's
// SQL, no Content-Disposition negotiation through the SWA gateway, and a
// guarantee that the exported columns match what the user is looking at.
// The one constraint — you can only export what you fetched — is handled
// by the reports page offering "Load all N rows" before export when the
// result set exceeds the default limit.
// ─────────────────────────────────────────────────────────────

// columns: [{ key, label, fmt? }] — controls both order and header text.
function toCsv(rows, columns) {
  const cols = columns && columns.length
    ? columns
    : Object.keys(rows[0] || {}).map(k => ({ key: k, label: k }));
  const lines = [cols.map(c => csvCell(c.label)).join(',')];
  for (const row of rows) {
    lines.push(cols.map(c => csvCell(c.fmt ? c.fmt(row[c.key], row) : row[c.key])).join(','));
  }
  return lines.join('\r\n');
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // RFC 4180: quote whenever the value contains a delimiter, a quote, a
  // newline, or leading/trailing whitespace Excel would otherwise eat.
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

// All exported timestamps are rendered in Houston time, not UTC and not
// the viewer's browser zone — a report emailed between two people should
// not disagree with itself.
function csvDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function downloadCsv(filename, csv) {
  // The leading BOM is what makes Excel read the file as UTF-8. Without
  // it, every accented name in the roster opens as mojibake.
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvFilename(report) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `hlsr-assets_${report}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.csv`;
}

function exportRows(report, rows, columns) {
  if (!rows || !rows.length) { toastMsg('Nothing to export', 'This report has no rows right now.'); return; }
  downloadCsv(csvFilename(report), toCsv(rows, columns));
  toastMsg('Exported', `${rows.length} row${rows.length === 1 ? '' : 's'} downloaded.`, 'ok');
}
